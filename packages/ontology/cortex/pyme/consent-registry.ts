import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{2,127})$/u;
const PHONE = /^\+[1-9]\d{7,14}$/u;

export type PymeConsentChannel = "ENHANCED_CONVERSIONS" | "WEBHOOK" | "WHATSAPP" | "SMS";
export type PymeConsentState = "GRANTED" | "REVOKED";
export type PymeConsentUseOutcome = "ALLOWED" | "DENIED" | "EXPIRED" | "DISPATCHED" | "FAILED" | "SUPPRESSED";

export interface PymeConsentMutation {
  readonly subjectId: `sha256:${string}`;
  readonly channel: PymeConsentChannel;
  readonly purpose: string;
  readonly expectedRevision: number;
  readonly reasonCode: string;
  readonly sourceRef: string;
  readonly decidedAt: string;
  readonly expiresAt?: string | null;
}

export interface PymeConsentDecision {
  readonly subjectId: `sha256:${string}`;
  readonly channel: PymeConsentChannel;
  readonly purpose: string;
  readonly state: PymeConsentState | "MISSING";
  readonly authorized: boolean;
  readonly reason: "GRANTED" | "REVOKED" | "MISSING" | "EXPIRED";
  readonly revision: number;
  readonly decidedAt: string | null;
  readonly expiresAt: string | null;
  readonly sourceRefDigest: `sha256:${string}` | null;
}

export interface PymeConsentAuditRecord {
  readonly sequence: number;
  readonly subjectId: `sha256:${string}`;
  readonly channel: PymeConsentChannel;
  readonly purpose: string;
  readonly action: "GRANT" | "REVOKE" | "USE";
  readonly outcome: PymeConsentUseOutcome | PymeConsentState;
  readonly reasonCode: string;
  readonly referenceDigest: `sha256:${string}`;
  readonly occurredAt: string;
  readonly digest: `sha256:${string}`;
}

export class PymeConsentError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "CONFLICT" | "INTEGRITY_FAILURE", message: string) {
    super(message);
    this.name = "PymeConsentError";
  }
}

function hash(namespace: string, value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(`${namespace}\n${value}`, "utf8").digest("hex")}`;
}

function utc(value: string, label: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new PymeConsentError("INVALID_INPUT", `${label} must be canonical UTC`);
  return value;
}

function id(value: string, label: string): string {
  const normalized = value.trim();
  if (!ID.test(normalized)) throw new PymeConsentError("INVALID_INPUT", `${label} must be a bounded identifier`);
  return normalized;
}

function subject(value: string): `sha256:${string}` {
  if (!SHA256.test(value)) throw new PymeConsentError("INVALID_INPUT", "subjectId must be lowercase sha256");
  return value as `sha256:${string}`;
}

export function createPymeConsentSubjectId(kind: "EMAIL" | "PHONE" | "OPAQUE", value: string): `sha256:${string}` {
  if (typeof value !== "string") throw new PymeConsentError("INVALID_INPUT", "consent subject value must be a string");
  let normalized: string;
  if (kind === "EMAIL") {
    normalized = value.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
    const at = normalized.lastIndexOf("@");
    if (at <= 0 || at === normalized.length - 1 || normalized.length > 254) throw new PymeConsentError("INVALID_INPUT", "email consent subject is malformed");
    let local = normalized.slice(0, at);
    const domain = normalized.slice(at + 1);
    if (!/^[a-z0-9.-]+\.[a-z]{2,63}$/u.test(domain)) throw new PymeConsentError("INVALID_INPUT", "email consent domain is malformed");
    if (domain === "gmail.com" || domain === "googlemail.com") local = local.split("+", 1)[0]!.replaceAll(".", "");
    if (!local || local.length > 64) throw new PymeConsentError("INVALID_INPUT", "email consent local part is malformed");
    normalized = `${local}@${domain}`;
  } else if (kind === "PHONE") {
    normalized = value.trim();
    if (!PHONE.test(normalized)) throw new PymeConsentError("INVALID_INPUT", "phone consent subject must be canonical E.164");
  } else {
    normalized = value.normalize("NFKC").trim();
    if (normalized.length < 8 || normalized.length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized)) throw new PymeConsentError("INVALID_INPUT", "opaque consent subject is malformed");
  }
  return hash(`NEXUS-CORTEX-PYME-CONSENT-${kind}-V1`, normalized);
}

function parseChannel(value: unknown): PymeConsentChannel {
  if (!(value === "ENHANCED_CONVERSIONS" || value === "WEBHOOK" || value === "WHATSAPP" || value === "SMS")) throw new PymeConsentError("INTEGRITY_FAILURE", "stored consent channel is invalid");
  return value;
}

function parseState(value: unknown): PymeConsentState {
  if (!(value === "GRANTED" || value === "REVOKED")) throw new PymeConsentError("INTEGRITY_FAILURE", "stored consent state is invalid");
  return value;
}

export class SqlitePymeConsentRegistry {
  private readonly db: DatabaseSync;
  constructor(databasePath: string, private readonly now: () => number = Date.now) {
    if (!databasePath) throw new PymeConsentError("INVALID_INPUT", "databasePath is required");
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS cortex_pyme_consent(
      subject_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      purpose TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('GRANTED','REVOKED')),
      revision INTEGER NOT NULL CHECK(revision>=1),
      reason_code TEXT NOT NULL,
      source_ref_digest TEXT NOT NULL,
      decided_at TEXT NOT NULL,
      expires_at TEXT,
      PRIMARY KEY(subject_id,channel,purpose)
    );
    CREATE TABLE IF NOT EXISTS cortex_pyme_consent_audit(
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      purpose TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('GRANT','REVOKE','USE')),
      outcome TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      reference_digest TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      digest TEXT NOT NULL
    );`);
  }

  close(): void { this.db.close(); }

  private row(subjectId: string, channel: PymeConsentChannel, purpose: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT subject_id,channel,purpose,state,revision,reason_code,source_ref_digest,decided_at,expires_at FROM cortex_pyme_consent WHERE subject_id=? AND channel=? AND purpose=?").get(subjectId, channel, purpose) as Record<string, unknown> | undefined;
  }

  decision(subjectIdInput: string, channel: PymeConsentChannel, purposeInput: string): PymeConsentDecision {
    const subjectId = subject(subjectIdInput);
    const purpose = id(purposeInput, "purpose");
    parseChannel(channel);
    const row = this.row(subjectId, channel, purpose);
    if (!row) return Object.freeze({ subjectId, channel, purpose, state: "MISSING", authorized: false, reason: "MISSING", revision: 0, decidedAt: null, expiresAt: null, sourceRefDigest: null });
    if (row.subject_id !== subjectId || parseChannel(row.channel) !== channel || row.purpose !== purpose || typeof row.revision !== "number" || !Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.reason_code !== "string" || !ID.test(row.reason_code) || typeof row.source_ref_digest !== "string" || !SHA256.test(row.source_ref_digest) || typeof row.decided_at !== "string") throw new PymeConsentError("INTEGRITY_FAILURE", "stored consent record is invalid");
    const state = parseState(row.state);
    const decidedAt = utc(row.decided_at, "stored decidedAt");
    const expiresAt = row.expires_at === null ? null : utc(String(row.expires_at), "stored expiresAt");
    const expired = expiresAt !== null && Date.parse(expiresAt) <= this.now();
    return Object.freeze({
      subjectId,
      channel,
      purpose,
      state,
      authorized: state === "GRANTED" && !expired,
      reason: expired ? "EXPIRED" : state,
      revision: row.revision,
      decidedAt,
      expiresAt,
      sourceRefDigest: row.source_ref_digest as `sha256:${string}`,
    });
  }

  private audit(subjectId: `sha256:${string}`, channel: PymeConsentChannel, purpose: string, action: "GRANT" | "REVOKE" | "USE", outcome: PymeConsentUseOutcome | PymeConsentState, reasonCode: string, reference: string, occurredAt: string): void {
    const referenceDigest = hash("NEXUS-CORTEX-PYME-CONSENT-REF-V1", reference);
    const core = `${subjectId}|${channel}|${purpose}|${action}|${outcome}|${reasonCode}|${referenceDigest}|${occurredAt}`;
    const digest = hash("NEXUS-CORTEX-PYME-CONSENT-AUDIT-V1", core);
    this.db.prepare("INSERT INTO cortex_pyme_consent_audit(subject_id,channel,purpose,action,outcome,reason_code,reference_digest,occurred_at,digest) VALUES(?,?,?,?,?,?,?,?,?)").run(subjectId, channel, purpose, action, outcome, reasonCode, referenceDigest, occurredAt, digest);
  }

  private mutate(input: PymeConsentMutation, state: PymeConsentState): PymeConsentDecision {
    const subjectId = subject(input.subjectId);
    const channel = parseChannel(input.channel);
    const purpose = id(input.purpose, "purpose");
    const reasonCode = id(input.reasonCode, "reasonCode");
    const sourceRef = id(input.sourceRef, "sourceRef");
    const decidedAt = utc(input.decidedAt, "decidedAt");
    const expiresAt = input.expiresAt == null ? null : utc(input.expiresAt, "expiresAt");
    if (expiresAt !== null && Date.parse(expiresAt) <= Date.parse(decidedAt)) throw new PymeConsentError("INVALID_INPUT", "expiresAt must be later than decidedAt");
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new PymeConsentError("INVALID_INPUT", "expectedRevision must be non-negative");
    const current = this.decision(subjectId, channel, purpose);
    if (current.revision !== input.expectedRevision) throw new PymeConsentError("CONFLICT", "consent revision changed");
    const nextRevision = input.expectedRevision + 1;
    const sourceRefDigest = hash("NEXUS-CORTEX-PYME-CONSENT-SOURCE-V1", sourceRef);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (input.expectedRevision === 0) {
        this.db.prepare("INSERT INTO cortex_pyme_consent(subject_id,channel,purpose,state,revision,reason_code,source_ref_digest,decided_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)").run(subjectId, channel, purpose, state, nextRevision, reasonCode, sourceRefDigest, decidedAt, expiresAt);
      } else {
        const result = this.db.prepare("UPDATE cortex_pyme_consent SET state=?,revision=?,reason_code=?,source_ref_digest=?,decided_at=?,expires_at=? WHERE subject_id=? AND channel=? AND purpose=? AND revision=?").run(state, nextRevision, reasonCode, sourceRefDigest, decidedAt, expiresAt, subjectId, channel, purpose, input.expectedRevision);
        if (result.changes !== 1) throw new PymeConsentError("CONFLICT", "consent CAS update lost its revision boundary");
      }
      this.audit(subjectId, channel, purpose, state === "GRANTED" ? "GRANT" : "REVOKE", state, reasonCode, sourceRef, decidedAt);
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
    return this.decision(subjectId, channel, purpose);
  }

  grant(input: PymeConsentMutation): PymeConsentDecision { return this.mutate(input, "GRANTED"); }
  revoke(input: PymeConsentMutation): PymeConsentDecision { return this.mutate(input, "REVOKED"); }

  authorize(subjectIdInput: string, channel: PymeConsentChannel, purposeInput: string, reference: string, occurredAt = new Date(this.now()).toISOString()): PymeConsentDecision {
    const subjectId = subject(subjectIdInput);
    const purpose = id(purposeInput, "purpose");
    const referenceId = id(reference, "reference");
    const at = utc(occurredAt, "occurredAt");
    const decision = this.decision(subjectId, channel, purpose);
    const outcome: PymeConsentUseOutcome = decision.authorized ? "ALLOWED" : decision.reason === "EXPIRED" ? "EXPIRED" : "DENIED";
    this.audit(subjectId, channel, purpose, "USE", outcome, decision.reason, referenceId, at);
    return decision;
  }

  recordUse(subjectIdInput: string, channel: PymeConsentChannel, purposeInput: string, outcome: Exclude<PymeConsentUseOutcome, "ALLOWED" | "DENIED" | "EXPIRED">, reference: string, reasonCode = "DELIVERY", occurredAt = new Date(this.now()).toISOString()): void {
    const subjectId = subject(subjectIdInput);
    const purpose = id(purposeInput, "purpose");
    this.audit(subjectId, channel, purpose, "USE", outcome, id(reasonCode, "reasonCode"), id(reference, "reference"), utc(occurredAt, "occurredAt"));
  }

  auditTrail(subjectIdInput: string, limit = 100): readonly PymeConsentAuditRecord[] {
    const subjectId = subject(subjectIdInput);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new PymeConsentError("INVALID_INPUT", "audit limit must be 1..500");
    const rows = this.db.prepare("SELECT sequence,subject_id,channel,purpose,action,outcome,reason_code,reference_digest,occurred_at,digest FROM cortex_pyme_consent_audit WHERE subject_id=? ORDER BY sequence ASC LIMIT ?").all(subjectId, limit) as Record<string, unknown>[];
    return Object.freeze(rows.map((row) => {
      if (typeof row.sequence !== "number" || !Number.isSafeInteger(row.sequence) || row.sequence < 1 || row.subject_id !== subjectId || typeof row.purpose !== "string" || typeof row.action !== "string" || typeof row.outcome !== "string" || typeof row.reason_code !== "string" || typeof row.reference_digest !== "string" || !SHA256.test(row.reference_digest) || typeof row.digest !== "string" || !SHA256.test(row.digest) || typeof row.occurred_at !== "string") throw new PymeConsentError("INTEGRITY_FAILURE", "stored consent audit record is invalid");
      const channel = parseChannel(row.channel);
      if (!(row.action === "GRANT" || row.action === "REVOKE" || row.action === "USE")) throw new PymeConsentError("INTEGRITY_FAILURE", "stored consent audit action is invalid");
      return Object.freeze({ sequence: row.sequence, subjectId, channel, purpose: row.purpose, action: row.action, outcome: row.outcome as PymeConsentAuditRecord["outcome"], reasonCode: row.reason_code, referenceDigest: row.reference_digest as `sha256:${string}`, occurredAt: utc(row.occurred_at, "audit occurredAt"), digest: row.digest as `sha256:${string}` });
    }));
  }
}
