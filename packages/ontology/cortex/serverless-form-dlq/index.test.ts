import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Cortex20Error, HttpDurableEventWriter, ServerlessFormIngress, decryptSubmission, encryptSubmission, type DurableEventWriter, type DurableFormEventInput } from "./index";

const key = randomBytes(32).toString("base64");
const submission = { submissionId: "submission-00000001", formId: "contact-form-0001", submittedAt: "2026-09-06T00:00:00.000Z", contactConsent: "GRANTED", fields: { name: "Cliente", email: "client@example.invalid", message: "Necesito información" } } as const;
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

class MemoryWriter implements DurableEventWriter {
  readonly events: DurableFormEventInput[] = [];
  async append(event: DurableFormEventInput): Promise<{ sequence: number }> {
    const existing = this.events.find((item) => item.stream === event.stream && item.eventId === event.eventId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(event)) throw new Error("idempotency conflict");
      return { sequence: this.events.indexOf(existing) + 1 };
    }
    this.events.push(event); return { sequence: this.events.length };
  }
}

describe("CORTEX #20 serverless form ingress", () => {
  it("encrypts lead fields before durable acceptance and makes exact retries event-idempotent", async () => {
    const writer = new MemoryWriter(); const ingress = new ServerlessFormIngress(writer, key, "form-key-0001");
    const receipt = await ingress.accept(submission); expect(receipt.durableSequence).toBe(1);
    expect(writer.events).toHaveLength(1);
    const firstEvent = JSON.stringify(writer.events[0]);
    expect(firstEvent).not.toContain(submission.fields.email); expect(firstEvent).not.toContain(submission.fields.message);
    const encrypted = (writer.events[0]!.payload as Record<string, unknown>).encrypted; expect(decryptSubmission(encrypted, key, "form-key-0001")).toEqual(submission);
    expect((await ingress.accept(submission)).durableSequence).toBe(1);
    expect(JSON.stringify(writer.events[0])).toBe(firstEvent);
  });

  it("normalizes field ordering so semantically identical retries encrypt identically", () => {
    const first = encryptSubmission(submission, key, "form-key-0001");
    const reordered = encryptSubmission({ ...submission, fields: { message: submission.fields.message, name: submission.fields.name, email: submission.fields.email } }, key, "form-key-0001");
    expect(reordered).toEqual(first);
    const changed = encryptSubmission({ ...submission, fields: { ...submission.fields, message: "Contenido diferente" } }, key, "form-key-0001");
    expect(changed.iv).not.toBe(first.iv); expect(changed.ciphertext).not.toBe(first.ciphertext);
  });

  it("requires explicit contact consent and rejects unsupported form fields", async () => {
    const writer = new MemoryWriter(); const ingress = new ServerlessFormIngress(writer, key, "form-key-0001");
    await expect(ingress.accept({ ...submission, contactConsent: "DENIED" })).rejects.toBeInstanceOf(Cortex20Error);
    await expect(ingress.accept({ ...submission, extra: "forbidden" })).rejects.toBeInstanceOf(Cortex20Error);
    expect(writer.events).toEqual([]);
  });

  it("authenticates canonical ciphertext and rejects wrong keys or malformed IVs", () => {
    const encrypted = encryptSubmission(submission, key, "form-key-0001");
    expect(() => decryptSubmission(encrypted, randomBytes(32).toString("base64"), "form-key-0001")).toThrowError(/authentication failed/u);
    expect(() => decryptSubmission({ ...encrypted, iv: Buffer.alloc(11).toString("base64") }, key, "form-key-0001")).toThrowError(/invalid size/u);
  });
});

describe("CORTEX #20 durable HTTPS writer", () => {
  it("rejects weak bearer credentials at the adapter boundary", () => {
    expect(() => new HttpDurableEventWriter(new URL("https://events.example/v1/events"), "short", 1000)).toThrowError(/configuration is invalid/u);
  });

  it("accepts only a receipt that proves the same durable event identity", async () => {
    const event = { stream: "forms.accepted", eventId: "form-event-00000001", occurredAt: submission.submittedAt, payload: { encrypted: "opaque" } } as const;
    const fetchMock = vi.fn(async () => Response.json({ ...event, sequence: 9 }, { status: 201 })); vi.stubGlobal("fetch", fetchMock);
    const writer = new HttpDurableEventWriter(new URL("https://events.example/v1/events"), "e".repeat(32), 1000);
    await expect(writer.append(event)).resolves.toEqual({ sequence: 9 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an ambiguous receipt bound to a different event", async () => {
    const event = { stream: "forms.accepted", eventId: "form-event-00000001", occurredAt: submission.submittedAt, payload: { encrypted: "opaque" } } as const;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...event, eventId: "form-event-00000002", sequence: 9 }, { status: 201 })));
    const writer = new HttpDurableEventWriter(new URL("https://events.example/v1/events"), "e".repeat(32), 1000);
    await expect(writer.append(event)).rejects.toThrowError(/does not prove the same event identity/u);
  });
});
