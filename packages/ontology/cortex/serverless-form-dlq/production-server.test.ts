import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerlessFormIngress, type DurableEventWriter, type DurableFormEventInput } from "./index";
import { startCortex20Server } from "./production-server";
import type { Cortex20Mode } from "./runtime-control";

const port = 39820;
const key = randomBytes(32).toString("base64");
const submission = { submissionId: "submission-00000001", formId: "contact-form-0001", submittedAt: "2026-09-06T00:00:00.000Z", contactConsent: "GRANTED", fields: { name: "Cliente", email: "client@example.invalid", message: "Necesito información" } } as const;
afterEach(() => { vi.restoreAllMocks(); });

class CapturingWriter implements DurableEventWriter {
  readonly events: DurableFormEventInput[] = [];
  async append(event: DurableFormEventInput): Promise<{ sequence: number }> { this.events.push(event); return { sequence: this.events.length }; }
}

function call(body: unknown, token = "i".repeat(32), contentLength?: number): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const encoded = JSON.stringify(body);
    const req = httpRequest(`http://127.0.0.1:${port}/v1/forms`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": String(contentLength ?? Buffer.byteLength(encoded)),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> }));
    });
    req.on("error", reject); req.end(encoded);
  });
}

async function waitReady(expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(`http://127.0.0.1:${port}/healthz`, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode ?? 0)); });
        req.on("error", reject); req.end();
      });
      if (status === expected) return;
    } catch { /* bounded startup retry */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("CORTEX #20 server did not become ready");
}

describe("CORTEX #20 production HTTP consumer", () => {
  it("authenticates and durably accepts only through the real ACTIVE ingress path", async () => {
    const writer = new CapturingWriter(); const ingress = new ServerlessFormIngress(writer, key, "form-key-0001");
    const server = startCortex20Server({ ingress, ingestToken: "i".repeat(32), port, readMode: () => "ACTIVE" });
    try {
      await waitReady(200);
      expect((await call(submission, "wrong".repeat(8))).status).toBe(401);
      const accepted = await call(submission);
      expect(accepted.status).toBe(202); expect(accepted.json.mode).toBe("ACTIVE");
      expect(writer.events).toHaveLength(1);
      const serialized = JSON.stringify(writer.events[0]); expect(serialized).not.toContain(submission.fields.email); expect(serialized).not.toContain(submission.fields.message);
    } finally { await server.close(); }
  });

  it("keeps OBSERVE_ONLY side-effect free and KILLED fail-closed", async () => {
    const writer = new CapturingWriter(); let mode: Cortex20Mode = "OBSERVE_ONLY";
    const ingress = new ServerlessFormIngress(writer, key, "form-key-0001");
    const server = startCortex20Server({ ingress, ingestToken: "i".repeat(32), port, readMode: () => mode });
    try {
      await waitReady(200);
      const observed = await call(submission); expect(observed.status).toBe(200); expect(observed.json).toMatchObject({ mode: "OBSERVE_ONLY", accepted: false, durableSequence: null });
      expect(writer.events).toHaveLength(0);
      mode = "KILLED";
      const killed = await call(submission); expect(killed.status).toBe(503); expect(killed.json).toEqual({ error: "KILLED" });
      expect(writer.events).toHaveLength(0);
    } finally { await server.close(); }
  });

  it("rejects an oversized declared body before the ingress side effect", async () => {
    const writer = new CapturingWriter(); const ingress = new ServerlessFormIngress(writer, key, "form-key-0001");
    const server = startCortex20Server({ ingress, ingestToken: "i".repeat(32), port, readMode: () => "ACTIVE" });
    try {
      await waitReady(200);
      const result = await call({}, "i".repeat(32), 96 * 1024 + 1);
      expect(result.status).toBe(400); expect(result.json).toEqual({ error: "INVALID_INPUT" }); expect(writer.events).toHaveLength(0);
    } finally { await server.close(); }
  });
});
