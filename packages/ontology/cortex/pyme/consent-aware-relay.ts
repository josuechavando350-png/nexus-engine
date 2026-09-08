import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Cortex20Error, type FormSubmission, type LeadDestination } from "../serverless-form-dlq/index";
import { parseRelayInput, type RelayGateway, type RelayInput, type RelayMode } from "../webhook-relay/index";
import { createPymeConsentSubjectId, SqlitePymeConsentRegistry, type PymeConsentChannel } from "./consent-registry";

const FIELD = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export type PymeLeadRelayChannel = "WEBHOOK" | "WHATSAPP" | "SMS";
export type PymeRelayLedgerStatus = "PENDING" | "DISPATCHING" | "SENT" | "SUPPRESSED";

export interface PymeConsentAwareRelayConfig {
  readonly databasePath: string;
  readonly registry: SqlitePymeConsentRegistry;
  readonly gateway: RelayGateway;
  readonly channel: PymeLeadRelayChannel;
  readonly purpose: string;
  readonly subjectField: string;
  readonly subjectKind: "EMAIL" | "PHONE" | "OPAQUE";
  readonly allowedFields: readonly string[];
  readonly modeProvider: () => RelayMode;
  /** Explicit deployment acknowledgement that the remote endpoint deduplicates by RelayInput.eventId. */
  readonly idempotencyContract: "EVENT_ID_IDEMPOTENT";
  readonly now?: () => number;
}

interface RelayLedgerRecord {
  readonly eventId: string;
  readonly eventDigest: `sha256:${string}`;
  readonly status: PymeRelayLedgerStatus;
  readonly receiptId: string | null;
  readonly attempts: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function canonicalDigest(value: unknown): `sha256:${string}` {
  return `sha256:${sha256(canonical(value))}`;
}

function consentChannel(channel: PymeLeadRelayChannel): PymeConsentChannel {
  return channel;
}

function eventType(channel: PymeLeadRelayChannel): string {
  return channel === "WHATSAPP" ? "pyme.lead.whatsapp" : channel === "SMS" ? "pyme.lead.sms" : "pyme.lead.webhook";
}

function mode(value: unknown): RelayMode {
  return value === "ACTIVE" || value === "OBSERVE_ONLY" || value === "KILLED" ? value : "KILLED";
}

export class PymeConsentAwareLeadDestination implements LeadDestination {
  private readonly db: DatabaseSync;
  private readonly allowedFields: readonly string[];
  private readonly now: () => number;

  constructor(private readonly config: PymeConsentAwareRelayConfig) {
    if (!config.databasePath) throw new Cortex20Error("INVALID_INPUT", "PyME relay databasePath is required");
    if (config.idempotencyContract !== "EVENT_ID_IDEMPOTENT") throw new Cortex20Error("INVALID_INPUT", "PyME relay requires an event-id idempotency contract");
    if (!ID.test(config.purpose) || !FIELD.test(config.subjectField)) throw new Cortex20Error("INVALID_INPUT", "PyME relay purpose or subjectField is invalid");
    if ((config.channel === "WHATSAPP" || config.channel === "SMS") && config.subjectKind !== "PHONE") throw new Cortex20Error("INVALID_INPUT", "WhatsApp/SMS PyME relay requires a phone consent subject");
    if (!Array.isArray(config.allowedFields) || config.allowedFields.length < 1 || config.allowedFields.length > 64 || config.allowedFields.some((entry) => typeof entry !== "string" || !FIELD.test(entry))) throw new Cortex20Error("INVALID_INPUT", "PyME relay allowedFields must contain 1..64 valid field names");
    const unique = [...new Set(config.allowedFields)].sort();
    if (unique.length !== config.allowedFields.length || !unique.includes(config.subjectField)) throw new Cortex20Error("INVALID_INPUT", "PyME relay allowedFields must be unique and include subjectField");
    if (typeof config.modeProvider !== "function") throw new Cortex20Error("INVALID_INPUT", "PyME relay modeProvider is required");
    this.allowedFields = Object.freeze(unique);
    this.now = config.now ?? Date.now;
    this.db = new DatabaseSync(config.databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS cortex_pyme_relay_ledger(
      event_id TEXT PRIMARY KEY,
      event_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('PENDING','DISPATCHING','SENT','SUPPRESSED')),
      receipt_id TEXT,
      attempts INTEGER NOT NULL CHECK(attempts>=0),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cortex_pyme_relay_audit(
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id_digest TEXT NOT NULL,
      event_digest TEXT NOT NULL,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL,
      reference_digest TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      digest TEXT NOT NULL
    );`);
  }

  close(): void { this.db.close(); }

  private currentMode(): RelayMode {
    try { return mode(this.config.modeProvider()); } catch { return "KILLED"; }
  }

  private row(eventId: string): RelayLedgerRecord | undefined {
    const row = this.db.prepare("SELECT event_id,event_digest,status,receipt_id,attempts FROM cortex_pyme_relay_ledger WHERE event_id=?").get(eventId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    if (row.event_id !== eventId || typeof row.event_digest !== "string" || !SHA256.test(row.event_digest) || !(row.status === "PENDING" || row.status === "DISPATCHING" || row.status === "SENT" || row.status === "SUPPRESSED") || !(row.receipt_id === null || typeof row.receipt_id === "string") || typeof row.attempts !== "number" || !Number.isSafeInteger(row.attempts) || row.attempts < 0) throw new Cortex20Error("DESTINATION_FAILURE", "PyME relay ledger is corrupt");
    return Object.freeze({ eventId, eventDigest: row.event_digest as `sha256:${string}`, status: row.status, receiptId: row.receipt_id, attempts: row.attempts });
  }

  private audit(eventId: string, eventDigest: `sha256:${string}`, action: string, outcome: string, reference: string): void {
    const occurredAt = new Date(this.now()).toISOString();
    const eventIdDigest = `sha256:${sha256(`NEXUS-CORTEX-PYME-RELAY-EVENT\n${eventId}`)}`;
    const referenceDigest = `sha256:${sha256(`NEXUS-CORTEX-PYME-RELAY-REF\n${reference}`)}`;
    const digest = `sha256:${sha256(`${eventIdDigest}|${eventDigest}|${action}|${outcome}|${referenceDigest}|${occurredAt}`)}`;
    this.db.prepare("INSERT INTO cortex_pyme_relay_audit(event_id_digest,event_digest,action,outcome,reference_digest,occurred_at,digest) VALUES(?,?,?,?,?,?,?)").run(eventIdDigest, eventDigest, action, outcome, referenceDigest, occurredAt, digest);
  }

  private transition(eventId: string, from: PymeRelayLedgerStatus, to: PymeRelayLedgerStatus, receiptId: string | null = null, incrementAttempt = false): RelayLedgerRecord {
    const result = this.db.prepare(`UPDATE cortex_pyme_relay_ledger SET status=?,receipt_id=?,attempts=attempts+?,updated_at=? WHERE event_id=? AND status=?`).run(to, receiptId, incrementAttempt ? 1 : 0, new Date(this.now()).toISOString(), eventId, from);
    if (result.changes !== 1) throw new Cortex20Error("DESTINATION_FAILURE", `PyME relay transition ${from}->${to} lost its CAS boundary`);
    const updated = this.row(eventId);
    if (!updated) throw new Cortex20Error("DESTINATION_FAILURE", "PyME relay record disappeared after transition");
    return updated;
  }

  private minimizedFields(submission: FormSubmission): Readonly<Record<string, string>> {
    const selected: Record<string, string> = {};
    for (const field of this.allowedFields) {
      const value = submission.fields[field];
      if (typeof value === "string") selected[field] = value;
    }
    if (typeof selected[this.config.subjectField] !== "string") throw new Cortex20Error("INVALID_INPUT", `PyME relay subject field ${this.config.subjectField} is missing`);
    return Object.freeze(selected);
  }

  async deliver(submission: FormSubmission, idempotencyKey: string): Promise<{ receiptId: string }> {
    if (!ID.test(idempotencyKey)) throw new Cortex20Error("INVALID_INPUT", "PyME relay idempotency key is malformed");
    if (this.currentMode() !== "ACTIVE") throw new Cortex20Error("DESTINATION_FAILURE", "PyME relay capability gate is not ACTIVE");

    const fields = this.minimizedFields(submission);
    const subjectValue = fields[this.config.subjectField]!;
    const subjectId = createPymeConsentSubjectId(this.config.subjectKind, subjectValue);
    const relay: RelayInput = parseRelayInput({
      eventId: idempotencyKey,
      eventType: eventType(this.config.channel),
      occurredAt: submission.submittedAt,
      adUserDataConsent: "GRANTED",
      userIdentifiers: [],
      data: { submissionId: submission.submissionId, formId: submission.formId, fields },
    });
    const eventDigest = canonicalDigest(relay);

    const ledger = this.row(idempotencyKey);
    if (ledger && ledger.eventDigest !== eventDigest) throw new Cortex20Error("DESTINATION_FAILURE", "PyME relay idempotency key is already bound to different content");
    if (ledger?.status === "SENT" || ledger?.status === "SUPPRESSED") return { receiptId: ledger.receiptId! };
    if (ledger?.status === "DISPATCHING") {
      this.transition(idempotencyKey, "DISPATCHING", "PENDING");
      this.audit(idempotencyKey, eventDigest, "RECOVER", "IDEMPOTENT_RETRY", idempotencyKey);
    }
    if (!ledger) {
      this.db.prepare("INSERT INTO cortex_pyme_relay_ledger(event_id,event_digest,status,receipt_id,attempts,updated_at) VALUES(?,?,?,?,?,?)").run(idempotencyKey, eventDigest, "PENDING", null, 0, new Date(this.now()).toISOString());
      this.audit(idempotencyKey, eventDigest, "PREPARE", "PENDING", idempotencyKey);
    }

    const channel = consentChannel(this.config.channel);
    const initialConsent = this.config.registry.authorize(subjectId, channel, this.config.purpose, idempotencyKey, new Date(this.now()).toISOString());
    if (!initialConsent.authorized) {
      const receiptId = `suppressed-${sha256(idempotencyKey).slice(0, 24)}`;
      this.transition(idempotencyKey, "PENDING", "SUPPRESSED", receiptId);
      this.config.registry.recordUse(subjectId, channel, this.config.purpose, "SUPPRESSED", idempotencyKey, `CONSENT_${initialConsent.reason}`, new Date(this.now()).toISOString());
      this.audit(idempotencyKey, eventDigest, "CONSENT", "SUPPRESSED", initialConsent.reason);
      return { receiptId };
    }

    if (this.currentMode() !== "ACTIVE") throw new Cortex20Error("DESTINATION_FAILURE", "PyME relay capability gate changed before dispatch");
    const finalConsent = this.config.registry.authorize(subjectId, channel, this.config.purpose, idempotencyKey, new Date(this.now()).toISOString());
    if (!finalConsent.authorized) {
      const receiptId = `suppressed-${sha256(idempotencyKey).slice(0, 24)}`;
      this.transition(idempotencyKey, "PENDING", "SUPPRESSED", receiptId);
      this.config.registry.recordUse(subjectId, channel, this.config.purpose, "SUPPRESSED", idempotencyKey, `CONSENT_${finalConsent.reason}`, new Date(this.now()).toISOString());
      this.audit(idempotencyKey, eventDigest, "FINAL_CONSENT", "SUPPRESSED", finalConsent.reason);
      return { receiptId };
    }

    const dispatching = this.transition(idempotencyKey, "PENDING", "DISPATCHING", null, true);
    this.audit(idempotencyKey, eventDigest, "DISPATCH", "ATTEMPT", String(dispatching.attempts));
    try {
      const receipt = await this.config.gateway.send(relay, eventDigest);
      if (this.currentMode() !== "ACTIVE") throw new Error("PyME relay capability gate changed while provider request was in flight");
      const sent = this.transition(idempotencyKey, "DISPATCHING", "SENT", receipt.requestId);
      this.config.registry.recordUse(subjectId, channel, this.config.purpose, "DISPATCHED", idempotencyKey, "PROVIDER_ACK", new Date(this.now()).toISOString());
      this.audit(idempotencyKey, eventDigest, "DISPATCH", "SENT", receipt.requestId);
      return { receiptId: sent.receiptId! };
    } catch (error) {
      try { this.transition(idempotencyKey, "DISPATCHING", "PENDING"); } catch { /* DISPATCHING is recoverable because deployment explicitly guarantees event-id idempotency. */ }
      this.config.registry.recordUse(subjectId, channel, this.config.purpose, "FAILED", idempotencyKey, "PROVIDER_FAILURE", new Date(this.now()).toISOString());
      this.audit(idempotencyKey, eventDigest, "DISPATCH", "FAILED", error instanceof Error ? error.name : "UNKNOWN");
      throw new Cortex20Error("DESTINATION_FAILURE", error instanceof Error ? `PyME relay provider failed: ${error.message}` : "PyME relay provider failed");
    }
  }
}
