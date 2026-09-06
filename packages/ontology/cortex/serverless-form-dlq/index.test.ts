import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteDurableEventStream } from "../event-budget-stream/index";
import { Cortex20Error, DirectDurableEventWriter, DurableFormWorker, ServerlessFormIngress, decryptSubmission, encryptSubmission, type LeadDestination } from "./index";

const dirs: string[] = [];
function path(name: string): string { const dir = mkdtempSync(join(tmpdir(), `nexus-cortex20-${name}-`)); dirs.push(dir); return join(dir, `${name}.sqlite`); }
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const key = randomBytes(32).toString("base64");
const submission = { submissionId: "submission-00000001", formId: "contact-form-0001", submittedAt: "2026-09-06T00:00:00.000Z", contactConsent: "GRANTED", fields: { name: "Cliente", email: "client@example.invalid", message: "Necesito información" } } as const;

describe("CORTEX #20 serverless form ingress", () => {
  it("encrypts lead fields before durable acceptance and returns only after CORTEX #17 commits", async () => {
    const stream = new SqliteDurableEventStream(path("events")); const ingress = new ServerlessFormIngress(new DirectDurableEventWriter(stream), key, "form-key-0001");
    const receipt = await ingress.accept(submission); expect(receipt.durableSequence).toBe(1);
    const accepted = stream.read("forms.accepted", 0, 10); expect(accepted).toHaveLength(1);
    const serialized = JSON.stringify(accepted[0]); expect(serialized).not.toContain(submission.fields.email); expect(serialized).not.toContain(submission.fields.message);
    const encrypted = (accepted[0]!.payload as Record<string, unknown>).encrypted; expect(decryptSubmission(encrypted, key, "form-key-0001")).toEqual(submission);
    expect((await ingress.accept(submission)).durableSequence).toBe(1);
    stream.close();
  });

  it("requires explicit contact consent and rejects unsupported form fields", async () => {
    const stream = new SqliteDurableEventStream(path("consent")); const ingress = new ServerlessFormIngress(new DirectDurableEventWriter(stream), key, "form-key-0001");
    await expect(ingress.accept({ ...submission, contactConsent: "DENIED" })).rejects.toBeInstanceOf(Cortex20Error);
    await expect(ingress.accept({ ...submission, extra: "forbidden" })).rejects.toBeInstanceOf(Cortex20Error);
    expect(stream.read("forms.accepted", 0, 10)).toEqual([]); stream.close();
  });

  it("authenticates ciphertext and rejects the wrong key", () => {
    const encrypted = encryptSubmission(submission, key, "form-key-0001");
    expect(() => decryptSubmission(encrypted, randomBytes(32).toString("base64"), "form-key-0001")).toThrowError(/authentication failed/u);
  });
});

describe("CORTEX #20 worker and DLQ", () => {
  it("delivers accepted leads with an idempotency key then commits the consumer offset", async () => {
    const stream = new SqliteDurableEventStream(path("deliver-events")); const ingress = new ServerlessFormIngress(new DirectDurableEventWriter(stream), key, "form-key-0001"); await ingress.accept(submission);
    const destination: LeadDestination = { deliver: vi.fn(async () => ({ receiptId: "receipt-00000001" })) };
    const worker = new DurableFormWorker(path("deliver-worker"), stream, destination, key, "form-key-0001", "form-worker-0001", 3);
    expect(await worker.runOnce()).toEqual({ processed: 1, delivered: 1, dlq: 0 });
    expect(destination.deliver).toHaveBeenCalledWith(expect.objectContaining({ submissionId: submission.submissionId }), expect.stringMatching(/^form-/u));
    expect(stream.readOffset("form-worker-0001", "forms.accepted")).toBe(1); worker.close(); stream.close();
  });

  it("retries without advancing the accepted offset and moves the encrypted lead to DLQ after the configured limit", async () => {
    const stream = new SqliteDurableEventStream(path("dlq-events")); const ingress = new ServerlessFormIngress(new DirectDurableEventWriter(stream), key, "form-key-0001"); await ingress.accept(submission);
    const destination: LeadDestination = { deliver: vi.fn(async () => { throw new Cortex20Error("DESTINATION_FAILURE", "downstream unavailable"); }) };
    const worker = new DurableFormWorker(path("dlq-worker"), stream, destination, key, "form-key-0001", "form-worker-0002", 2, () => Date.parse("2026-09-06T00:10:00.000Z"));
    expect(await worker.runOnce()).toEqual({ processed: 1, delivered: 0, dlq: 0 }); expect(stream.readOffset("form-worker-0002", "forms.accepted")).toBe(0);
    expect(await worker.runOnce()).toEqual({ processed: 1, delivered: 0, dlq: 1 }); expect(stream.readOffset("form-worker-0002", "forms.accepted")).toBe(1);
    const dlq = stream.read("forms.dlq", 0, 10); expect(dlq).toHaveLength(1); expect(JSON.stringify(dlq[0])).not.toContain(submission.fields.email); expect((dlq[0]!.payload as Record<string, unknown>).attempts).toBe(2);
    worker.close(); stream.close();
  });
});
