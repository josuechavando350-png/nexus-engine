import { createHash, createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u;
const TYPE = /^[A-Za-z][A-Za-z0-9._:-]{1,127}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export type RelayMode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";
export type RelayConsent = "GRANTED" | "DENIED";
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface RelayInput {
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly adUserDataConsent: RelayConsent;
  readonly userIdentifiers: readonly { readonly kind: "EMAIL_SHA256" | "PHONE_SHA256"; readonly value: string }[];
  readonly data: JsonValue;
}

export interface RelayRecord {
  readonly eventId: string;
  readonly digest: `sha256:${string}`;
  readonly status: "PENDING" | "SENT" | "AMBIGUOUS";
  readonly remoteRequestId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RelayReceipt {
  readonly requestId: string;
}

export interface RelayGateway {
  send(event: RelayInput, digest: `sha256:${string}`): Promise<RelayReceipt>;
}

export class Cortex11Error extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "CONSENT_VIOLATION" | "CONFLICT" | "KILLED" | "AMBIGUOUS_OUTCOME", message: string) {
    super(message);
    this.name = "Cortex11Error";
  }
}

function timestamp(value: unknown): string {
  if (typeof value !== "string") throw new Cortex11Error("INVALID_INPUT", "occurredAt must be canonical UTC");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Cortex11Error("INVALID_INPUT", "occurredAt must be canonical UTC");
  return value;
}

function assertJson(value: unknown, depth = 0): asserts value is JsonValue {
  if (depth > 16) throw new Cortex11Error("INVALID_INPUT", "data nesting is too deep");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Cortex11Error("INVALID_INPUT", "data contains a non-finite number");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new Cortex11Error("INVALID_INPUT", "data array is too large");
    for (const item of value) assertJson(item, depth + 1);
    return;
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw new Cortex11Error("INVALID_INPUT", "data must be JSON-compatible");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 1_000) throw new Cortex11Error("INVALID_INPUT", "data object is too large");
  for (const [key, item] of entries) {
    if (!key || key.length > 128) throw new Cortex11Error("INVALID_INPUT", "data key is invalid");
    assertJson(item, depth + 1);
  }
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

export function parseRelayInput(value: unknown): RelayInput {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Cortex11Error("INVALID_INPUT", "relay input must be a plain object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "adUserDataConsent,data,eventId,eventType,occurredAt,userIdentifiers") throw new Cortex11Error("INVALID_INPUT", "relay contract contains missing or unsupported fields");
  if (typeof raw.eventId !== "string" || !ID.test(raw.eventId)) throw new Cortex11Error("INVALID_INPUT", "eventId is malformed");
  if (typeof raw.eventType !== "string" || !TYPE.test(raw.eventType)) throw new Cortex11Error("INVALID_INPUT", "eventType is malformed");
  if (!(raw.adUserDataConsent === "GRANTED" || raw.adUserDataConsent === "DENIED")) throw new Cortex11Error("INVALID_INPUT", "adUserDataConsent is invalid");
  if (!Array.isArray(raw.userIdentifiers) || raw.userIdentifiers.length > 10) throw new Cortex11Error("INVALID_INPUT", "userIdentifiers must be an array with at most ten entries");
  const userIdentifiers = raw.userIdentifiers.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item as object).sort().join(",") !== "kind,value") throw new Cortex11Error("INVALID_INPUT", "user identifier contract is invalid");
    const identifier = item as Record<string, unknown>;
    if (!(identifier.kind === "EMAIL_SHA256" || identifier.kind === "PHONE_SHA256") || typeof identifier.value !== "string" || !SHA256.test(identifier.value)) throw new Cortex11Error("INVALID_INPUT", "user identifier must be an explicitly hashed value");
    return Object.freeze({ kind: identifier.kind, value: identifier.value });
  });
  if (raw.adUserDataConsent === "DENIED" && userIdentifiers.length > 0) throw new Cortex11Error("CONSENT_VIOLATION", "user identifiers are forbidden without consent");
  assertJson(raw.data);
  return Object.freeze({ eventId: raw.eventId, eventType: raw.eventType, occurredAt: timestamp(raw.occurredAt), adUserDataConsent: raw.adUserDataConsent, userIdentifiers: Object.freeze(userIdentifiers), data: raw.data });
}

function digest(event: RelayInput): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonical(event as unknown as JsonValue), "utf8").digest("hex")}`;
}

export class FetchWebhookRelayGateway implements RelayGateway {
  constructor(private readonly endpoint: URL, private readonly bearerToken: string, private readonly signingSecret: string, private readonly timeoutMs = 2_000) {
    if (endpoint.protocol !== "https:" || !bearerToken || signingSecret.length < 32 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) throw new Cortex11Error("INVALID_INPUT", "webhook gateway configuration is invalid");
  }

  async send(event: RelayInput, eventDigest: `sha256:${string}`): Promise<RelayReceipt> {
    const body = canonical(event as unknown as JsonValue);
    const signature = `sha256=${createHmac("sha256", this.signingSecret).update(body, "utf8").digest("hex")}`;
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.bearerToken}`,
        "content-type": "application/json",
        "x-nexus-event-digest": eventDigest,
        "x-nexus-signature": signature,
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`REMOTE_HTTP_${response.status}`);
    const requestId = response.headers.get("x-request-id")?.trim();
    if (!requestId || !ID.test(requestId)) throw new Error("REMOTE_RECEIPT_INVALID");
    return Object.freeze({ requestId });
  }
}

export class DurableWebhookRelay {
  private readonly db: DatabaseSync;

  constructor(databasePath: string, private readonly gateway: RelayGateway, private readonly modeProvider: () => RelayMode, private readonly now: () => number = Date.now) {
    if (!databasePath) throw new Cortex11Error("INVALID_INPUT", "databasePath is required");
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS cortex11_relay (
      event_id TEXT PRIMARY KEY,
      digest TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('PENDING','SENT','AMBIGUOUS')),
      remote_request_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`);
  }

  close(): void { this.db.close(); }

  prepare(value: unknown): RelayRecord {
    const event = parseRelayInput(value);
    if (this.modeProvider() === "KILLED") throw new Cortex11Error("KILLED", "relay is killed");
    const eventDigest = digest(event);
    const existing = this.row(event.eventId);
    if (existing) {
      if (existing.digest !== eventDigest) throw new Cortex11Error("CONFLICT", "eventId is already bound to different relay content");
      return existing;
    }
    const now = new Date(this.now()).toISOString();
    this.db.prepare("INSERT INTO cortex11_relay(event_id,digest,payload_json,status,remote_request_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(event.eventId, eventDigest, canonical(event as unknown as JsonValue), "PENDING", null, now, now);
    return this.row(event.eventId)!;
  }

  async dispatch(eventId: string): Promise<RelayRecord> {
    if (!ID.test(eventId)) throw new Cortex11Error("INVALID_INPUT", "eventId is malformed");
    const record = this.row(eventId);
    if (!record) throw new Cortex11Error("INVALID_INPUT", "relay event was not prepared");
    if (record.status === "SENT") return record;
    if (record.status === "AMBIGUOUS") throw new Cortex11Error("AMBIGUOUS_OUTCOME", "ambiguous webhook outcome requires operator reconciliation");
    if (this.modeProvider() !== "ACTIVE") throw new Cortex11Error("KILLED", "relay is not active");
    const raw = this.db.prepare("SELECT payload_json FROM cortex11_relay WHERE event_id = ?").get(eventId) as { payload_json?: unknown } | undefined;
    const event = parseRelayInput(JSON.parse(String(raw?.payload_json ?? "null")) as unknown);
    // Final kill-switch check immediately before the external side effect.
    if (this.modeProvider() !== "ACTIVE") throw new Cortex11Error("KILLED", "relay was disabled before dispatch");
    try {
      const receipt = await this.gateway.send(event, record.digest);
      const updatedAt = new Date(this.now()).toISOString();
      this.db.prepare("UPDATE cortex11_relay SET status='SENT',remote_request_id=?,updated_at=? WHERE event_id=? AND status='PENDING'").run(receipt.requestId, updatedAt, eventId);
      return this.row(eventId)!;
    } catch (error) {
      const updatedAt = new Date(this.now()).toISOString();
      this.db.prepare("UPDATE cortex11_relay SET status='AMBIGUOUS',updated_at=? WHERE event_id=? AND status='PENDING'").run(updatedAt, eventId);
      throw new Cortex11Error("AMBIGUOUS_OUTCOME", error instanceof Error ? error.message : "webhook outcome is ambiguous");
    }
  }

  get(eventId: string): RelayRecord | undefined { return this.row(eventId); }

  private row(eventId: string): RelayRecord | undefined {
    const row = this.db.prepare("SELECT event_id,digest,status,remote_request_id,created_at,updated_at FROM cortex11_relay WHERE event_id=?").get(eventId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return Object.freeze({ eventId: String(row.event_id), digest: String(row.digest) as `sha256:${string}`, status: String(row.status) as RelayRecord["status"], remoteRequestId: row.remote_request_id ? String(row.remote_request_id) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at) });
  }
}
