import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SqliteDurableEventStream, type DurableEventInput, type DurableEventRecord } from "../event-budget-stream/index";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u;
const FIELD = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;

export interface FormSubmission {
  readonly submissionId: string;
  readonly formId: string;
  readonly submittedAt: string;
  readonly contactConsent: "GRANTED" | "DENIED";
  readonly fields: Readonly<Record<string, string>>;
}

export interface AcceptedFormReceipt {
  readonly submissionId: string;
  readonly eventId: string;
  readonly durableSequence: number;
}

export interface DurableEventWriter {
  append(event: DurableEventInput): Promise<{ sequence: number }>;
}

export interface LeadDestination {
  deliver(submission: FormSubmission, idempotencyKey: string): Promise<{ receiptId: string }>;
}

export class Cortex20Error extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "CONSENT_VIOLATION" | "ENCRYPTION_ERROR" | "QUEUE_FAILURE" | "DESTINATION_FAILURE", message: string) {
    super(message);
    this.name = "Cortex20Error";
  }
}

function utc(value: unknown): string {
  if (typeof value !== "string") throw new Cortex20Error("INVALID_INPUT", "submittedAt must be canonical UTC");
  const date = new Date(value); if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Cortex20Error("INVALID_INPUT", "submittedAt must be canonical UTC"); return value;
}

export function parseFormSubmission(value: unknown): FormSubmission {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Cortex20Error("INVALID_INPUT", "form submission must be a plain object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "contactConsent,fields,formId,submissionId,submittedAt") throw new Cortex20Error("INVALID_INPUT", "form contract contains missing or unsupported fields");
  if (typeof raw.submissionId !== "string" || !ID.test(raw.submissionId) || typeof raw.formId !== "string" || !ID.test(raw.formId)) throw new Cortex20Error("INVALID_INPUT", "submission identity is malformed");
  if (!(raw.contactConsent === "GRANTED" || raw.contactConsent === "DENIED")) throw new Cortex20Error("INVALID_INPUT", "contactConsent is invalid");
  if (raw.contactConsent !== "GRANTED") throw new Cortex20Error("CONSENT_VIOLATION", "contact processing requires explicit consent");
  if (!raw.fields || typeof raw.fields !== "object" || Array.isArray(raw.fields) || Object.getPrototypeOf(raw.fields) !== Object.prototype) throw new Cortex20Error("INVALID_INPUT", "fields must be a plain object");
  const entries = Object.entries(raw.fields as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 64) throw new Cortex20Error("INVALID_INPUT", "fields must contain 1-64 entries");
  const fields: Record<string, string> = {};
  let bytes = 0;
  for (const [key, item] of entries) {
    if (!FIELD.test(key) || typeof item !== "string" || item.length > 10_000) throw new Cortex20Error("INVALID_INPUT", "form field is invalid");
    bytes += Buffer.byteLength(key) + Buffer.byteLength(item);
    if (bytes > 64 * 1024) throw new Cortex20Error("INVALID_INPUT", "form fields exceed size limit");
    fields[key] = item;
  }
  return Object.freeze({ submissionId: raw.submissionId, formId: raw.formId, submittedAt: utc(raw.submittedAt), contactConsent: raw.contactConsent, fields: Object.freeze(fields) });
}

function encryptionKey(value: string): Buffer {
  let key: Buffer;
  try { key = Buffer.from(value, "base64"); } catch { throw new Cortex20Error("ENCRYPTION_ERROR", "encryption key is invalid"); }
  if (key.length !== 32 || key.toString("base64") !== value) throw new Cortex20Error("ENCRYPTION_ERROR", "encryption key must be canonical base64 for 32 bytes");
  return key;
}

interface EncryptedLead {
  readonly schemaVersion: 1;
  readonly algorithm: "AES-256-GCM";
  readonly keyId: string;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

export function encryptSubmission(submission: FormSubmission, keyBase64: string, keyId: string): EncryptedLead {
  if (!ID.test(keyId)) throw new Cortex20Error("ENCRYPTION_ERROR", "keyId is malformed");
  const key = encryptionKey(keyBase64); const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(submission), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]); const tag = cipher.getAuthTag();
  return Object.freeze({ schemaVersion: 1, algorithm: "AES-256-GCM", keyId, iv: iv.toString("base64"), tag: tag.toString("base64"), ciphertext: ciphertext.toString("base64") });
}

export function decryptSubmission(encrypted: unknown, keyBase64: string, expectedKeyId: string): FormSubmission {
  if (!encrypted || typeof encrypted !== "object" || Array.isArray(encrypted) || Object.getPrototypeOf(encrypted) !== Object.prototype) throw new Cortex20Error("ENCRYPTION_ERROR", "encrypted lead is invalid");
  const raw = encrypted as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "algorithm,ciphertext,iv,keyId,schemaVersion,tag" || raw.schemaVersion !== 1 || raw.algorithm !== "AES-256-GCM" || raw.keyId !== expectedKeyId || typeof raw.iv !== "string" || typeof raw.tag !== "string" || typeof raw.ciphertext !== "string") throw new Cortex20Error("ENCRYPTION_ERROR", "encrypted lead contract is invalid");
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(keyBase64), Buffer.from(raw.iv, "base64")); decipher.setAuthTag(Buffer.from(raw.tag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(raw.ciphertext, "base64")), decipher.final()]).toString("utf8");
    return parseFormSubmission(JSON.parse(plaintext) as unknown);
  } catch (error) { if (error instanceof Cortex20Error) throw error; throw new Cortex20Error("ENCRYPTION_ERROR", "encrypted lead authentication failed"); }
}

export class DirectDurableEventWriter implements DurableEventWriter {
  constructor(private readonly stream: SqliteDurableEventStream) {}
  async append(event: DurableEventInput): Promise<{ sequence: number }> { return { sequence: this.stream.append(event).sequence }; }
}

export class HttpDurableEventWriter implements DurableEventWriter {
  constructor(private readonly endpoint: URL, private readonly bearerToken: string, private readonly timeoutMs = 5_000) {
    if (endpoint.protocol !== "https:" || !bearerToken || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) throw new Cortex20Error("INVALID_INPUT", "durable event writer configuration is invalid");
  }
  async append(event: DurableEventInput): Promise<{ sequence: number }> {
    const response = await fetch(this.endpoint, { method: "POST", headers: { authorization: `Bearer ${this.bearerToken}`, "content-type": "application/json" }, body: JSON.stringify(event), redirect: "error", signal: AbortSignal.timeout(this.timeoutMs) });
    if (!(response.status === 200 || response.status === 201)) throw new Cortex20Error("QUEUE_FAILURE", `durable event stream returned HTTP ${response.status}`);
    const body = await response.json() as { sequence?: unknown }; if (typeof body.sequence !== "number" || !Number.isSafeInteger(body.sequence) || body.sequence < 1) throw new Cortex20Error("QUEUE_FAILURE", "durable event stream receipt is invalid");
    return { sequence: body.sequence };
  }
}

export class ServerlessFormIngress {
  constructor(private readonly writer: DurableEventWriter, private readonly keyBase64: string, private readonly keyId: string) { encryptionKey(keyBase64); if (!ID.test(keyId)) throw new Cortex20Error("INVALID_INPUT", "keyId is malformed"); }
  async accept(value: unknown): Promise<AcceptedFormReceipt> {
    const submission = parseFormSubmission(value); const encrypted = encryptSubmission(submission, this.keyBase64, this.keyId);
    const eventId = `form-${createHash("sha256").update(submission.submissionId, "utf8").digest("hex").slice(0, 32)}`;
    const receipt = await this.writer.append({ stream: "forms.accepted", eventId, occurredAt: submission.submittedAt, payload: { submissionIdHash: `sha256:${createHash("sha256").update(submission.submissionId).digest("hex")}`, formId: submission.formId, encrypted } });
    return Object.freeze({ submissionId: submission.submissionId, eventId, durableSequence: receipt.sequence });
  }
}

export class FetchLeadDestination implements LeadDestination {
  constructor(private readonly endpoint: URL, private readonly bearerToken: string, private readonly timeoutMs = 10_000) { if (endpoint.protocol !== "https:" || !bearerToken) throw new Cortex20Error("INVALID_INPUT", "lead destination configuration is invalid"); }
  async deliver(submission: FormSubmission, idempotencyKey: string): Promise<{ receiptId: string }> {
    const response = await fetch(this.endpoint, { method: "POST", headers: { authorization: `Bearer ${this.bearerToken}`, "content-type": "application/json", "idempotency-key": idempotencyKey }, body: JSON.stringify(submission), redirect: "error", signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Cortex20Error("DESTINATION_FAILURE", `lead destination returned HTTP ${response.status}`);
    const receiptId = response.headers.get("x-request-id")?.trim(); if (!receiptId || !ID.test(receiptId)) throw new Cortex20Error("DESTINATION_FAILURE", "lead destination receipt is invalid"); return { receiptId };
  }
}

export class DurableFormWorker {
  private readonly db: DatabaseSync;
  constructor(databasePath: string, private readonly eventStream: SqliteDurableEventStream, private readonly destination: LeadDestination, private readonly keyBase64: string, private readonly keyId: string, private readonly consumerId: string, private readonly maxAttempts = 5, private readonly now: () => number = Date.now) {
    if (!databasePath || !ID.test(consumerId) || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw new Cortex20Error("INVALID_INPUT", "worker configuration is invalid"); encryptionKey(keyBase64);
    this.db = new DatabaseSync(databasePath); this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;"); this.db.exec("CREATE TABLE IF NOT EXISTS cortex20_attempts(event_id TEXT PRIMARY KEY,attempts INTEGER NOT NULL,last_error TEXT,last_attempt_at TEXT);");
  }
  close(): void { this.db.close(); }
  async runOnce(limit = 50): Promise<{ processed: number; delivered: number; dlq: number }> {
    const after = this.eventStream.readOffset(this.consumerId, "forms.accepted"); const events = this.eventStream.read("forms.accepted", after, limit); let delivered = 0; let dlq = 0;
    for (const event of events) {
      const attemptsRow = this.db.prepare("SELECT attempts FROM cortex20_attempts WHERE event_id=?").get(event.eventId) as { attempts?: unknown } | undefined; const attempts = Number(attemptsRow?.attempts ?? 0);
      try {
        const submission = this.submissionFromEvent(event); await this.destination.deliver(submission, event.eventId); this.eventStream.commitOffset(this.consumerId, "forms.accepted", event.sequence); this.db.prepare("DELETE FROM cortex20_attempts WHERE event_id=?").run(event.eventId); delivered += 1;
      } catch (error) {
        const nextAttempt = attempts + 1; const code = error instanceof Cortex20Error ? error.code : "DESTINATION_FAILURE"; this.db.prepare("INSERT INTO cortex20_attempts(event_id,attempts,last_error,last_attempt_at) VALUES(?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET attempts=excluded.attempts,last_error=excluded.last_error,last_attempt_at=excluded.last_attempt_at").run(event.eventId, nextAttempt, code, new Date(this.now()).toISOString());
        if (nextAttempt < this.maxAttempts) break;
        const dlqEventId = `dlq-${createHash("sha256").update(event.eventId).digest("hex").slice(0, 32)}`; this.eventStream.append({ stream: "forms.dlq", eventId: dlqEventId, occurredAt: new Date(this.now()).toISOString(), payload: { sourceEventId: event.eventId, sourceSequence: event.sequence, attempts: nextAttempt, encryptedLead: (event.payload as Record<string, unknown>).encrypted as never, errorCode: code } }); this.eventStream.commitOffset(this.consumerId, "forms.accepted", event.sequence); dlq += 1;
      }
    }
    return Object.freeze({ processed: events.length, delivered, dlq });
  }
  private submissionFromEvent(event: DurableEventRecord): FormSubmission {
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) throw new Cortex20Error("ENCRYPTION_ERROR", "accepted form event is malformed"); const payload = event.payload as Record<string, unknown>; return decryptSubmission(payload.encrypted, this.keyBase64, this.keyId);
  }
}
