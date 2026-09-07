import { DatabaseSync } from "node:sqlite";
import type { DurableCouponEventInput } from "./index.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u;
const MAX_RESPONSE_BYTES = 64 * 1024;

export class Cortex19OutboxError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "DELIVERY_FAILURE" | "INTEGRITY_FAILURE", message: string) {
    super(message);
    this.name = "Cortex19OutboxError";
  }
}

function validateEndpoint(endpoint: URL, token: string, timeoutMs: number): void {
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash || endpoint.search || endpoint.pathname.length < 1 || !token || token.length < 32 || token.length > 4096 || /[\r\n\0]/u.test(token) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) throw new Cortex19OutboxError("INVALID_INPUT", "CORTEX #19 durable event destination configuration is invalid");
}

function parseEvent(value: unknown): DurableCouponEventInput {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Cortex19OutboxError("INTEGRITY_FAILURE", "outbox event must be a plain object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "eventId,occurredAt,payload,stream" || raw.stream !== "coupon.issued" || typeof raw.eventId !== "string" || !ID.test(raw.eventId) || typeof raw.occurredAt !== "string") throw new Cortex19OutboxError("INTEGRITY_FAILURE", "outbox event contract is invalid");
  const when = new Date(raw.occurredAt);
  if (!Number.isFinite(when.getTime()) || when.toISOString() !== raw.occurredAt) throw new Cortex19OutboxError("INTEGRITY_FAILURE", "outbox event time is invalid");
  return Object.freeze({ stream: raw.stream, eventId: raw.eventId, occurredAt: raw.occurredAt, payload: raw.payload });
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) throw new Cortex19OutboxError("DELIVERY_FAILURE", "durable event receipt is oversized");
  if (!response.body) throw new Cortex19OutboxError("DELIVERY_FAILURE", "durable event receipt body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => undefined); throw new Cortex19OutboxError("DELIVERY_FAILURE", "durable event receipt is oversized"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new Cortex19OutboxError("DELIVERY_FAILURE", "durable event receipt is invalid JSON"); }
}

export class SqliteCouponOutboxDispatcher {
  private readonly db: DatabaseSync;
  constructor(databasePath: string, private readonly endpoint: URL, private readonly bearerToken: string, private readonly timeoutMs = 5_000) {
    if (!databasePath) throw new Cortex19OutboxError("INVALID_INPUT", "databasePath is required");
    validateEndpoint(endpoint, bearerToken, timeoutMs);
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
  }
  close(): void { this.db.close(); }

  pendingCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) count FROM cortex19_outbox WHERE sent=0").get() as { count?: unknown };
    const count = Number(row.count ?? 0);
    if (!Number.isSafeInteger(count) || count < 0) throw new Cortex19OutboxError("INTEGRITY_FAILURE", "outbox count is invalid");
    return count;
  }

  async flush(limit = 100, beforeMarkSent?: () => void): Promise<{ attempted: number; delivered: number; remaining: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000 || (beforeMarkSent !== undefined && typeof beforeMarkSent !== "function")) throw new Cortex19OutboxError("INVALID_INPUT", "outbox flush request is invalid");
    const rows = this.db.prepare("SELECT event_id,payload_json FROM cortex19_outbox WHERE sent=0 ORDER BY event_id LIMIT ?").all(limit) as Record<string, unknown>[];
    let delivered = 0;
    for (const row of rows) {
      const eventId = String(row.event_id);
      if (!ID.test(eventId)) throw new Cortex19OutboxError("INTEGRITY_FAILURE", "stored outbox eventId is invalid");
      let event: DurableCouponEventInput;
      try { event = parseEvent(JSON.parse(String(row.payload_json)) as unknown); }
      catch (error) { if (error instanceof Cortex19OutboxError) throw error; throw new Cortex19OutboxError("INTEGRITY_FAILURE", "stored outbox payload is invalid JSON"); }
      if (event.eventId !== eventId) throw new Cortex19OutboxError("INTEGRITY_FAILURE", "stored outbox eventId does not match payload");
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${this.bearerToken}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(event),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!(response.status === 200 || response.status === 201)) throw new Cortex19OutboxError("DELIVERY_FAILURE", `durable event stream returned HTTP ${response.status}`);
      const receipt = await boundedJson(response) as Record<string, unknown>;
      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || receipt.eventId !== event.eventId || receipt.stream !== event.stream || typeof receipt.sequence !== "number" || !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1) throw new Cortex19OutboxError("DELIVERY_FAILURE", "durable event receipt does not prove the same event identity");
      beforeMarkSent?.();
      const marked = this.db.prepare("UPDATE cortex19_outbox SET sent=1 WHERE event_id=? AND sent=0").run(event.eventId);
      if (marked.changes !== 1) throw new Cortex19OutboxError("INTEGRITY_FAILURE", "outbox delivery acknowledgement raced or disappeared");
      delivered += 1;
    }
    return Object.freeze({ attempted: rows.length, delivered, remaining: this.pendingCount() });
  }
}
