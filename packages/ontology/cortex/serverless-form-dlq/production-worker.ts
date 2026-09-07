import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Cortex20Error, decryptSubmission, type DurableFormEventInput, type DurableFormEventRecord, type LeadDestination } from "./index.js";
import type { Cortex20Mode } from "./runtime-control.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class Cortex20WorkerError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "REMOTE_FAILURE" | "INTEGRITY_FAILURE" | "KILLED", message: string) {
    super(message);
    this.name = "Cortex20WorkerError";
  }
}

function secureToken(value: string, label: string): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 4096 || /[\r\n\0]/u.test(value)) throw new Cortex20WorkerError("INVALID_INPUT", `${label} is invalid`);
  return value;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) throw new Cortex20WorkerError("REMOTE_FAILURE", "event service response is oversized");
  if (!response.body) throw new Cortex20WorkerError("REMOTE_FAILURE", "event service response body is missing");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break; total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => undefined); throw new Cortex20WorkerError("REMOTE_FAILURE", "event service response is oversized"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new Cortex20WorkerError("REMOTE_FAILURE", "event service response is invalid JSON"); }
}

function parseRemoteEvent(value: unknown): DurableFormEventRecord {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Cortex20WorkerError("INTEGRITY_FAILURE", "remote event must be a plain object");
  const raw = value as Record<string, unknown>;
  if (typeof raw.stream !== "string" || !ID.test(raw.stream) || typeof raw.eventId !== "string" || !ID.test(raw.eventId) || typeof raw.occurredAt !== "string" || typeof raw.sequence !== "number" || !Number.isSafeInteger(raw.sequence) || raw.sequence < 1) throw new Cortex20WorkerError("INTEGRITY_FAILURE", "remote event identity is invalid");
  const date = new Date(raw.occurredAt); if (!Number.isFinite(date.getTime()) || date.toISOString() !== raw.occurredAt) throw new Cortex20WorkerError("INTEGRITY_FAILURE", "remote event time is invalid");
  return Object.freeze({ stream: raw.stream, eventId: raw.eventId, occurredAt: raw.occurredAt, payload: raw.payload, sequence: raw.sequence });
}

function validateOutboundEvent(event: DurableFormEventInput): void {
  if (!event || typeof event !== "object" || typeof event.stream !== "string" || !ID.test(event.stream) || typeof event.eventId !== "string" || !ID.test(event.eventId) || typeof event.occurredAt !== "string") throw new Cortex20WorkerError("INVALID_INPUT", "outbound event identity is invalid");
  const date = new Date(event.occurredAt); if (!Number.isFinite(date.getTime()) || date.toISOString() !== event.occurredAt) throw new Cortex20WorkerError("INVALID_INPUT", "outbound event time is invalid");
}

export class HttpCortex17FormEventClient {
  private readonly origin: URL;
  constructor(
    origin: URL,
    private readonly readToken: string,
    private readonly writeToken: string,
    private readonly timeoutMs = 10_000,
    private readonly beforeMutation?: () => void,
  ) {
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.hash || origin.search || origin.pathname !== "/") throw new Cortex20WorkerError("INVALID_INPUT", "event service origin must be a credential-free HTTPS origin");
    secureToken(readToken, "event read token"); secureToken(writeToken, "event write token");
    if (readToken === writeToken) throw new Cortex20WorkerError("INVALID_INPUT", "event read and write tokens must be distinct");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000 || (beforeMutation !== undefined && typeof beforeMutation !== "function")) throw new Cortex20WorkerError("INVALID_INPUT", "event service timeout or mutation guard is invalid");
    this.origin = new URL(origin);
  }

  private assertMutationAllowed(boundary: string): void {
    if (!this.beforeMutation) return;
    try { this.beforeMutation(); }
    catch (error) {
      if (error instanceof Cortex20WorkerError && error.code === "KILLED") throw error;
      throw new Cortex20WorkerError("KILLED", `event mutation disabled ${boundary}`);
    }
  }

  async read(stream: string, after: number, limit: number): Promise<readonly DurableFormEventRecord[]> {
    if (!ID.test(stream) || !Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Cortex20WorkerError("INVALID_INPUT", "event read request is invalid");
    const url = new URL("/v1/events", this.origin); url.searchParams.set("stream", stream); url.searchParams.set("after", String(after)); url.searchParams.set("limit", String(limit));
    const response = await fetch(url, { headers: { authorization: `Bearer ${this.readToken}`, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Cortex20WorkerError("REMOTE_FAILURE", `event read returned HTTP ${response.status}`);
    const body = await boundedJson(response) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).join(",") !== "events" || !Array.isArray(body.events) || body.events.length > limit) throw new Cortex20WorkerError("INTEGRITY_FAILURE", "event read receipt is invalid");
    const events = body.events.map(parseRemoteEvent);
    let previous = after;
    for (const event of events) {
      if (event.stream !== stream || event.sequence <= previous) throw new Cortex20WorkerError("INTEGRITY_FAILURE", "event stream order or identity is invalid");
      previous = event.sequence;
    }
    return Object.freeze(events);
  }

  async append(event: DurableFormEventInput): Promise<number> {
    validateOutboundEvent(event);
    const url = new URL("/v1/events", this.origin);
    this.assertMutationAllowed("at final event append boundary");
    const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${this.writeToken}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(event), redirect: "error", signal: AbortSignal.timeout(this.timeoutMs) });
    if (!(response.status === 200 || response.status === 201)) throw new Cortex20WorkerError("REMOTE_FAILURE", `event append returned HTTP ${response.status}`);
    const receipt = parseRemoteEvent(await boundedJson(response));
    if (receipt.stream !== event.stream || receipt.eventId !== event.eventId) throw new Cortex20WorkerError("INTEGRITY_FAILURE", "event append receipt does not prove the same event identity");
    return receipt.sequence;
  }

  async commitOffset(consumerId: string, stream: string, sequence: number): Promise<void> {
    if (!ID.test(consumerId) || !ID.test(stream) || !Number.isSafeInteger(sequence) || sequence < 1) throw new Cortex20WorkerError("INVALID_INPUT", "offset commit is invalid");
    const url = new URL("/v1/offsets", this.origin);
    this.assertMutationAllowed("at final offset commit boundary");
    const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${this.writeToken}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ consumerId, stream, sequence }), redirect: "error", signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Cortex20WorkerError("REMOTE_FAILURE", `offset commit returned HTTP ${response.status}`);
    const body = await boundedJson(response) as Record<string, unknown>;
    if (!body || body.sequence !== sequence) throw new Cortex20WorkerError("INTEGRITY_FAILURE", "offset commit receipt is invalid");
  }
}

export interface Cortex20WorkerConfig {
  readonly databasePath: string;
  readonly eventClient: HttpCortex17FormEventClient;
  readonly destination: LeadDestination;
  readonly encryptionKeyBase64: string;
  readonly encryptionKeyId: string;
  readonly consumerId: string;
  readonly maxAttempts: number;
  readonly baseRetryDelayMs: number;
  readonly readMode: () => Cortex20Mode;
  readonly now?: () => number;
}

export class Cortex20ProductionWorker {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  constructor(private readonly config: Cortex20WorkerConfig) {
    if (!config.databasePath || !config.eventClient || !config.destination || !ID.test(config.consumerId) || !Number.isSafeInteger(config.maxAttempts) || config.maxAttempts < 1 || config.maxAttempts > 20 || !Number.isSafeInteger(config.baseRetryDelayMs) || config.baseRetryDelayMs < 100 || config.baseRetryDelayMs > 60_000 || typeof config.readMode !== "function") throw new Cortex20WorkerError("INVALID_INPUT", "worker configuration is invalid");
    this.now = config.now ?? Date.now;
    this.db = new DatabaseSync(config.databasePath); this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS cortex20_remote_worker_state(consumer_id TEXT PRIMARY KEY,sequence INTEGER NOT NULL CHECK(sequence>=0));
      CREATE TABLE IF NOT EXISTS cortex20_remote_attempts(event_id TEXT PRIMARY KEY,attempts INTEGER NOT NULL CHECK(attempts>0),last_error TEXT NOT NULL,next_attempt_at TEXT);`);
  }
  close(): void { this.db.close(); }

  private mode(): Cortex20Mode { try { const value = this.config.readMode(); return value === "ACTIVE" || value === "OBSERVE_ONLY" || value === "KILLED" ? value : "KILLED"; } catch { return "KILLED"; } }
  private localOffset(): number {
    const row = this.db.prepare("SELECT sequence FROM cortex20_remote_worker_state WHERE consumer_id=?").get(this.config.consumerId) as { sequence?: unknown } | undefined;
    const value = Number(row?.sequence ?? 0); if (!Number.isSafeInteger(value) || value < 0) throw new Cortex20WorkerError("INTEGRITY_FAILURE", "local worker offset is invalid"); return value;
  }
  private storeOffset(sequence: number): void {
    this.db.prepare("INSERT INTO cortex20_remote_worker_state(consumer_id,sequence) VALUES(?,?) ON CONFLICT(consumer_id) DO UPDATE SET sequence=excluded.sequence WHERE excluded.sequence>=cortex20_remote_worker_state.sequence").run(this.config.consumerId, sequence);
  }

  async runOnce(limit = 50): Promise<{ processed: number; delivered: number; dlq: number; deferred: number; offset: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Cortex20WorkerError("INVALID_INPUT", "worker limit is invalid");
    if (this.mode() !== "ACTIVE") return Object.freeze({ processed: 0, delivered: 0, dlq: 0, deferred: 0, offset: this.localOffset() });
    const after = this.localOffset(); const events = await this.config.eventClient.read("forms.accepted", after, limit);
    let processed = 0; let delivered = 0; let dlq = 0; let deferred = 0; let offset = after;
    for (const event of events) {
      if (this.mode() !== "ACTIVE") break;
      const attempt = this.db.prepare("SELECT attempts,next_attempt_at FROM cortex20_remote_attempts WHERE event_id=?").get(event.eventId) as Record<string, unknown> | undefined;
      const attempts = Number(attempt?.attempts ?? 0); const retryAt = attempt?.next_attempt_at ? Date.parse(String(attempt.next_attempt_at)) : 0;
      if (!Number.isSafeInteger(attempts) || attempts < 0 || (attempt?.next_attempt_at && !Number.isFinite(retryAt))) throw new Cortex20WorkerError("INTEGRITY_FAILURE", "stored retry state is invalid");
      if (retryAt > this.now()) { deferred += 1; break; }
      processed += 1;
      try {
        if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) throw new Cortex20Error("ENCRYPTION_ERROR", "accepted form event payload is invalid");
        const submission = decryptSubmission((event.payload as Record<string, unknown>).encrypted, this.config.encryptionKeyBase64, this.config.encryptionKeyId);
        await this.config.destination.deliver(submission, event.eventId);
        if (this.mode() !== "ACTIVE") throw new Cortex20WorkerError("KILLED", "worker killed before offset commit");
        await this.config.eventClient.commitOffset(this.config.consumerId, "forms.accepted", event.sequence);
        this.db.exec("BEGIN IMMEDIATE");
        try { this.storeOffset(event.sequence); this.db.prepare("DELETE FROM cortex20_remote_attempts WHERE event_id=?").run(event.eventId); this.db.exec("COMMIT"); }
        catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
        offset = event.sequence; delivered += 1;
      } catch (error) {
        if (error instanceof Cortex20WorkerError && error.code === "KILLED") break;
        const nextAttempt = attempts + 1; const errorCode = error instanceof Cortex20Error ? error.code : error instanceof Cortex20WorkerError ? error.code : "DESTINATION_FAILURE"; const now = this.now();
        if (nextAttempt < this.config.maxAttempts) {
          const delay = Math.min(3_600_000, this.config.baseRetryDelayMs * 2 ** Math.max(0, nextAttempt - 1));
          this.db.prepare("INSERT INTO cortex20_remote_attempts(event_id,attempts,last_error,next_attempt_at) VALUES(?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET attempts=excluded.attempts,last_error=excluded.last_error,next_attempt_at=excluded.next_attempt_at").run(event.eventId, nextAttempt, errorCode, new Date(now + delay).toISOString());
          break;
        }
        if (this.mode() !== "ACTIVE") break;
        const dlqEventId = `dlq-${createHash("sha256").update(event.eventId, "utf8").digest("hex").slice(0, 32)}`;
        const payload = event.payload as Record<string, unknown>;
        await this.config.eventClient.append({ stream: "forms.dlq", eventId: dlqEventId, occurredAt: new Date(now).toISOString(), payload: { sourceEventId: event.eventId, sourceSequence: event.sequence, attempts: nextAttempt, encryptedLead: payload.encrypted, errorCode } });
        if (this.mode() !== "ACTIVE") break;
        await this.config.eventClient.commitOffset(this.config.consumerId, "forms.accepted", event.sequence);
        this.db.exec("BEGIN IMMEDIATE");
        try { this.storeOffset(event.sequence); this.db.prepare("DELETE FROM cortex20_remote_attempts WHERE event_id=?").run(event.eventId); this.db.exec("COMMIT"); }
        catch (inner) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw inner; }
        offset = event.sequence; dlq += 1;
      }
    }
    return Object.freeze({ processed, delivered, dlq, deferred, offset });
  }
}
