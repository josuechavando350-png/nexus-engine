import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Cortex20Error, DirectDurableEventWriter, DurableFormWorker, ServerlessFormIngress, decryptSubmission, encryptSubmission, type DurableFormEventInput, type DurableFormEventRecord, type DurableFormEventStore, type LeadDestination } from "./index";

const dirs: string[] = [];
function path(name: string): string { const dir = mkdtempSync(join(tmpdir(), `nexus-cortex20-${name}-`)); dirs.push(dir); return join(dir, `${name}.sqlite`); }
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

class MemoryDurableStore implements DurableFormEventStore {
  private sequence = 0;
  private readonly events: DurableFormEventRecord[] = [];
  private readonly offsets = new Map<string, number>();
  append(event: DurableFormEventInput): { sequence: number } {
    const existing = this.events.find((item) => item.stream === event.stream && item.eventId === event.eventId);
    if (existing) {
      if (JSON.stringify(existing.payload) !== JSON.stringify(event.payload) || existing.occurredAt !== event.occurredAt) throw new Error("idempotency conflict");
      return { sequence: existing.sequence };
    }
    const record = Object.freeze({ ...event, sequence: ++this.sequence });
    this.events.push(record);
    return { sequence: record.sequence };
  }
  read(stream: string, afterSequence: number, limit: number): readonly DurableFormEventRecord[] { return this.events.filter((item) => item.stream === stream && item.sequence > afterSequence).slice(0, limit); }
  readOffset(consumerId: string, stream: string): number { return this.offsets.get(`${consumerId}\0${stream}`) ?? 0; }
  commitOffset(consumerId: string, stream: string, sequence: number): void {
    const key = `${consumerId}\0${stream}`; const current = this.offsets.get(key) ?? 0;
    if (sequence < current) throw new Error("offset regression");
    this.offsets.set(key, sequence);
  }
}

const key = randomBytes(32).toString("base64");
const submission = { submissionId: "submission-00000001", formId: "contact-form-0001", submittedAt: "2026-09-06T00:00:00.000Z", contactConsent: "GRANTED", fields: { name: "Cliente", email: "client@example.invalid", message: "Necesito información" } } as const;

describe("CORTEX #20 serverless form ingress", () => {
  it("encrypts lead fields before durable acceptance and returns only after durable append", async () => {
    const stream = new MemoryDurableStore(); const ingress = new ServerlessFormIngress(new DirectDurableEventWriter(stream), key, "form-key-0001");
    const receipt = await ingress.accept(submission); expect(receipt.durableSequence).toBe(1);
    const accepted = stream.read("forms.accepted", 0, 10); expect(accepted).toHaveLength(1);
    const serialized = JSON.stringify(accepted[0]); expect(serialized).not.toContain(submission.fields.email); expect(serialized).not.toContain(submission.fields.message);
    const encrypted = (accepted[0]!.payload as Record<string, unknown>).encrypted; expect(decryptSubmission(encrypted, key, "form-key-0001")).toEqual(submission);
    expect((await ingress.accept(submission)).durableSequence).toBe(1);
  });

  it("requires explicit contact consent and rejects unsupported form fields", async () => {
    const stream = new MemoryDurableStore(); const ingress = new ServerlessFormIngress(new DirectDurableEventWriter(stream), key, "form-key-0001");
    await expect(ingress.accept({ ...submission, contactConsent: "DENIED" })).rejects.toBeInstanceOf(Cortex20Error);
    await expect(ingress.accept({ ...submission, extra: "forbidden" })).rejects.toBeInstanceOf(Cortex20Error);
    expect(stream.read("forms.accepted", 0, 10)).toEqual([]);
  });

  it("authenticates canonical ciphertext and rejects wrong keys or malformed IVs", () => {
    const encrypted = encryptSubmission(submission, key, "form-key-0001");
    expect(() => decryptSubmission(encrypted, randomBytes(32).toString("base64"), "form-key-0001")).toThrowError(/authentication failed/u);
    expect(() => decryptSubmission({ ...encrypted, iv: Buffer.alloc(11).toString("base64") }, key, "form-key-0001")).toThrowError(/invalid size/u);
  });
});

describe("CORTEX #20 worker and DLQ", () => {
  it("delivers accepted leads with an idempotency key then commits the consumer offset", async () => {
    const stream = new MemoryDurableStore(); const ingress = new ServerlessFormIngress(new DirectDurableEventWriter(stream), key, "form-key-0001"); await ingress.accept(submission);
    const destination: LeadDestination = { deliver: vi.fn(async () => ({ receiptId: "receipt-00000001" })) };
    const worker = new DurableFormWorker(path("deliver-worker"), stream, destination, key, "form-key-0001", "form-worker-0001", 3);
    expect(await worker.runOnce()).toEqual({ processed: 1, delivered: 1, dlq: 0, deferred: 0 });
    expect(destination.deliver).toHaveBeenCalledWith(expect.objectContaining({ submissionId: submission.submissionId }), expect.stringMatching(/^form-/u));
    expect(stream.readOffset("form-worker-0001", "forms.accepted")).toBe(1); worker.close();
  });

  it("persists exponential retry timing without advancing offset and moves encrypted data to DLQ after the limit", async () => {
    const stream = new MemoryDurableStore(); const ingress = new ServerlessFormIngress(new DirectDurableEventWriter(stream), key, "form-key-0001"); await ingress.accept(submission);
    const destination: LeadDestination = { deliver: vi.fn(async () => { throw new Cortex20Error("DESTINATION_FAILURE", "downstream unavailable"); }) };
    let now = Date.parse("2026-09-06T00:10:00.000Z");
    const worker = new DurableFormWorker(path("dlq-worker"), stream, destination, key, "form-key-0001", "form-worker-0002", 2, () => now, 100);
    expect(await worker.runOnce()).toEqual({ processed: 1, delivered: 0, dlq: 0, deferred: 0 }); expect(stream.readOffset("form-worker-0002", "forms.accepted")).toBe(0);
    expect(await worker.runOnce()).toEqual({ processed: 0, delivered: 0, dlq: 0, deferred: 1 });
    now += 100;
    expect(await worker.runOnce()).toEqual({ processed: 1, delivered: 0, dlq: 1, deferred: 0 }); expect(stream.readOffset("form-worker-0002", "forms.accepted")).toBe(1);
    const dlq = stream.read("forms.dlq", 0, 10); expect(dlq).toHaveLength(1); expect(JSON.stringify(dlq[0])).not.toContain(submission.fields.email); expect((dlq[0]!.payload as Record<string, unknown>).attempts).toBe(2);
    worker.close();
  });
});
