import { createHash, createHmac } from "node:crypto";
import { canonicalJson, ontologyId, validateSchema, type OntologyScope, type SchemaVersion, type ValidatedSchema } from "@nexus/ontology";
import { OntologyTransactionError, type JsonValue, type ObjectRecord, type OntologyTransactionPort, type TransactionOperation } from "@nexus/ontology/transaction";
import {
  BehavioralSignalError,
  type BehavioralSignalMode,
  type BehavioralSignalPolicy,
  type BehavioralSignalPrivacyConfig,
} from "./index";

const SESSION_TYPE = "cortex.behavioral_micro_signal_session";
const SITE_TYPE = "cortex.behavioral_micro_signal_site";
const IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const OPAQUE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{7,255})$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const HMAC256 = /^hmac-sha256:[0-9a-f]{64}$/u;
const HARD_MAX_RECEIPTS = 512;

const SESSION = Object.freeze({
  siteId: "cortex.behavioral_micro.session.site_id",
  sessionKey: "cortex.behavioral_micro.session.session_key",
  keyId: "cortex.behavioral_micro.session.key_id",
  payload: "cortex.behavioral_micro.session.payload",
  digest: "cortex.behavioral_micro.session.digest",
  updatedAt: "cortex.behavioral_micro.session.updated_at",
});

const SITE = Object.freeze({
  siteId: "cortex.behavioral_micro.site.site_id",
  payload: "cortex.behavioral_micro.site.payload",
  digest: "cortex.behavioral_micro.site.digest",
  updatedAt: "cortex.behavioral_micro.site.updated_at",
});

export type BehavioralMicroInteractionKind =
  | "READING_PAUSE"
  | "POINTER_ENTER"
  | "POINTER_DOWN"
  | "TOUCH_START"
  | "TOUCH_END";

export type BehavioralMicroInteractionStatus = "RECORDED" | "DUPLICATE" | "OBSERVED" | "NOOP";
export type BehavioralMicroInteractionReason = "RECORDED" | "DUPLICATE" | "OBSERVE_ONLY" | "KILL_SWITCH" | "PRIVACY_DENIED";

export interface BehavioralMicroInteractionInput {
  readonly eventId: string;
  readonly sessionId: string;
  readonly siteId: string;
  readonly kind: BehavioralMicroInteractionKind;
  readonly occurredAt: string;
  readonly surfaceId: string;
  readonly elementId?: string | null;
  readonly durationMs?: number | null;
  readonly collectionAllowed: boolean;
  readonly privacyDecisionRef?: string | null;
  readonly mode?: BehavioralSignalMode;
}

export type BehavioralMicroInteractionCounters = Readonly<Record<BehavioralMicroInteractionKind, number>>;

export interface BehavioralMicroSessionSnapshot {
  readonly siteId: string;
  readonly sessionKey: string;
  readonly keyId: string;
  readonly firstEventAt: string;
  readonly lastEventAt: string;
  readonly eventCount: number;
  readonly counts: BehavioralMicroInteractionCounters;
  readonly totalReadingPauseMs: number;
  readonly lastSurfaceId: string;
  readonly lastElementId: string | null;
  readonly lastEventKind: BehavioralMicroInteractionKind;
  readonly lastEventDigest: string;
  readonly lastPolicyDigest: string;
  readonly digest: string;
}

export interface BehavioralMicroSiteSnapshot {
  readonly siteId: string;
  readonly firstEventAt: string;
  readonly lastEventAt: string;
  readonly eventCount: number;
  readonly sessionCount: number;
  readonly counts: BehavioralMicroInteractionCounters;
  readonly totalReadingPauseMs: number;
  readonly lastSurfaceId: string;
  readonly lastElementId: string | null;
  readonly lastEventKind: BehavioralMicroInteractionKind;
  readonly lastEventDigest: string;
  readonly lastPolicyDigest: string;
  readonly digest: string;
}

export interface BehavioralMicroInteractionResult {
  readonly status: BehavioralMicroInteractionStatus;
  readonly reason: BehavioralMicroInteractionReason;
  readonly mode: BehavioralSignalMode;
  readonly siteId: string;
  readonly eventDigest: string | null;
  readonly session: BehavioralMicroSessionSnapshot | null;
  readonly site: BehavioralMicroSiteSnapshot | null;
  readonly policyDigest: string;
}

interface Receipt {
  readonly eventKey: string;
  readonly contentDigest: string;
}

interface SessionPayload {
  readonly firstEventAt: string;
  readonly lastEventAt: string;
  readonly receipts: readonly Receipt[];
  readonly counts: BehavioralMicroInteractionCounters;
  readonly totalReadingPauseMs: number;
  readonly lastSurfaceId: string;
  readonly lastElementId: string | null;
  readonly lastEventKind: BehavioralMicroInteractionKind;
  readonly lastEventDigest: string;
  readonly lastPolicyDigest: string;
}

interface SitePayload {
  readonly firstEventAt: string;
  readonly lastEventAt: string;
  readonly eventCount: number;
  readonly sessionCount: number;
  readonly counts: BehavioralMicroInteractionCounters;
  readonly totalReadingPauseMs: number;
  readonly lastSurfaceId: string;
  readonly lastElementId: string | null;
  readonly lastEventKind: BehavioralMicroInteractionKind;
  readonly lastEventDigest: string;
  readonly lastPolicyDigest: string;
}

interface SessionRecord extends SessionPayload {
  readonly id: string;
  readonly siteId: string;
  readonly sessionKey: string;
  readonly keyId: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly digest: string;
}

interface SiteRecord extends SitePayload {
  readonly id: string;
  readonly siteId: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly digest: string;
}

interface NormalizedEvent {
  readonly eventKey: string;
  readonly sessionKey: string;
  readonly siteId: string;
  readonly kind: BehavioralMicroInteractionKind;
  readonly occurredAt: string;
  readonly surfaceId: string;
  readonly elementId: string | null;
  readonly durationMs: number | null;
  readonly privacyDecisionDigest: string;
  readonly contentDigest: string;
}

const KINDS: readonly BehavioralMicroInteractionKind[] = ["READING_PAUSE", "POINTER_ENTER", "POINTER_DOWN", "TOUCH_START", "TOUCH_END"];
const MODES: readonly BehavioralSignalMode[] = ["ACTIVE", "OBSERVE_ONLY", "KILLED"];
const POINTER_TOUCH = new Set<BehavioralMicroInteractionKind>(["POINTER_ENTER", "POINTER_DOWN", "TOUCH_START", "TOUCH_END"]);
const INPUT_KEYS = new Set(["eventId", "sessionId", "siteId", "kind", "occurredAt", "surfaceId", "elementId", "durationMs", "collectionAllowed", "privacyDecisionRef", "mode"]);
const SESSION_PAYLOAD_KEYS = new Set(["firstEventAt", "lastEventAt", "receipts", "counts", "totalReadingPauseMs", "lastSurfaceId", "lastElementId", "lastEventKind", "lastEventDigest", "lastPolicyDigest"]);
const SITE_PAYLOAD_KEYS = new Set(["firstEventAt", "lastEventAt", "eventCount", "sessionCount", "counts", "totalReadingPauseMs", "lastSurfaceId", "lastElementId", "lastEventKind", "lastEventDigest", "lastPolicyDigest"]);

function hash(namespace: string, value: unknown): string {
  return `sha256:${createHash("sha256").update(`${namespace}\n${canonicalJson(value)}`, "utf8").digest("hex")}`;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, field: string, code: "INVALID_INPUT" | "INTEGRITY_FAILURE"): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new BehavioralSignalError(code, `${field} contains unsupported field ${key}`);
}

function identifier(value: string, field: string, code: "INVALID_INPUT" | "INTEGRITY_FAILURE" = "INVALID_INPUT"): string {
  if (typeof value !== "string") throw new BehavioralSignalError(code, `${field} must be a string`);
  const normalized = value.trim();
  if (!IDENTIFIER.test(normalized)) throw new BehavioralSignalError(code, `${field} is malformed`);
  return normalized;
}

function opaqueId(value: string, field: string): string {
  if (typeof value !== "string") throw new BehavioralSignalError("INVALID_INPUT", `${field} must be a string`);
  const normalized = value.trim();
  if (!OPAQUE_ID.test(normalized)) throw new BehavioralSignalError("INVALID_INPUT", `${field} must be an opaque 8..256 character identifier`);
  return normalized;
}

function utc(value: string, field: string, code: "INVALID_INPUT" | "INTEGRITY_FAILURE" = "INVALID_INPUT"): string {
  if (typeof value !== "string") throw new BehavioralSignalError(code, `${field} must be a string`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new BehavioralSignalError(code, `${field} must be canonical UTC`);
  return value;
}

function object(value: JsonValue | undefined, field: string): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BehavioralSignalError("INTEGRITY_FAILURE", `${field} must be object`);
  return value as Record<string, JsonValue>;
}

function isJson(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return Boolean(value) && typeof value === "object" && Object.values(value as Record<string, unknown>).every(isJson);
}

function json(value: unknown, field: string): JsonValue {
  if (!isJson(value)) throw new BehavioralSignalError("INTEGRITY_FAILURE", `${field} is not finite JSON`);
  return value;
}

function safeCount(value: JsonValue | undefined, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new BehavioralSignalError("INTEGRITY_FAILURE", `${field} invalid`);
  return value;
}

function safeAdd(left: number, right: number, field: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) throw new BehavioralSignalError("INTEGRITY_FAILURE", `${field} overflow`);
  return value;
}

function requiredString(record: ObjectRecord, key: string): string {
  const value = record.properties[key];
  if (typeof value !== "string" || !value) throw new BehavioralSignalError("INTEGRITY_FAILURE", `record ${record.id} has invalid ${key}`);
  return value;
}

function property(id: string, name: string, valueKind: "STRING" | "JSON" | "DATETIME", immutable = false) {
  return { id, name, valueKind, cardinality: "REQUIRED", unique: false, immutable } as const;
}

function schema(scope: OntologyScope): ValidatedSchema {
  const value: SchemaVersion = {
    version: "cortex-behavioral-micro-signal-v1",
    scope,
    properties: [
      property(SESSION.siteId, "BehavioralMicroSessionSiteId", "STRING", true),
      property(SESSION.sessionKey, "BehavioralMicroSessionKey", "STRING", true),
      property(SESSION.keyId, "BehavioralMicroSessionKeyId", "STRING", true),
      property(SESSION.payload, "BehavioralMicroSessionPayload", "JSON"),
      property(SESSION.digest, "BehavioralMicroSessionDigest", "STRING"),
      property(SESSION.updatedAt, "BehavioralMicroSessionUpdatedAt", "DATETIME"),
      property(SITE.siteId, "BehavioralMicroSiteId", "STRING", true),
      property(SITE.payload, "BehavioralMicroSitePayload", "JSON"),
      property(SITE.digest, "BehavioralMicroSiteDigest", "STRING"),
      property(SITE.updatedAt, "BehavioralMicroSiteUpdatedAt", "DATETIME"),
    ],
    interfaces: [],
    objects: [
      { id: SESSION_TYPE, name: "CortexBehavioralMicroSession", propertyIds: Object.values(SESSION), interfaceIds: [] },
      { id: SITE_TYPE, name: "CortexBehavioralMicroSite", propertyIds: Object.values(SITE), interfaceIds: [] },
    ],
    relationships: [],
    actions: [],
    functions: [],
    events: [],
  };
  return validateSchema(value);
}

function initialCounters(): BehavioralMicroInteractionCounters {
  return Object.freeze({ READING_PAUSE: 0, POINTER_ENTER: 0, POINTER_DOWN: 0, TOUCH_START: 0, TOUCH_END: 0 });
}

function incrementCounters(current: BehavioralMicroInteractionCounters, kind: BehavioralMicroInteractionKind): BehavioralMicroInteractionCounters {
  const next = { ...current, [kind]: current[kind] + 1 };
  if (!Number.isSafeInteger(next[kind])) throw new BehavioralSignalError("INTEGRITY_FAILURE", "micro signal counter overflow");
  return Object.freeze(next);
}

function parseCounters(value: JsonValue | undefined, field: string): BehavioralMicroInteractionCounters {
  const raw = object(value, field);
  exactKeys(raw as unknown as Record<string, unknown>, new Set(KINDS), field, "INTEGRITY_FAILURE");
  const result = {} as Record<BehavioralMicroInteractionKind, number>;
  for (const kind of KINDS) {
    const item = raw[kind];
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0) throw new BehavioralSignalError("INTEGRITY_FAILURE", `${field}.${kind} invalid`);
    result[kind] = item;
  }
  return Object.freeze(result);
}

function parseReceipts(value: JsonValue | undefined): readonly Receipt[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > HARD_MAX_RECEIPTS) throw new BehavioralSignalError("INTEGRITY_FAILURE", "micro receipts invalid");
  const receipts = value.map((item, index) => {
    const raw = object(item, `micro.receipts[${index}]`);
    exactKeys(raw as unknown as Record<string, unknown>, new Set(["eventKey", "contentDigest"]), `micro.receipts[${index}]`, "INTEGRITY_FAILURE");
    if (typeof raw.eventKey !== "string" || !HMAC256.test(raw.eventKey)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "micro receipt eventKey invalid");
    if (typeof raw.contentDigest !== "string" || !SHA256.test(raw.contentDigest)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "micro receipt contentDigest invalid");
    return Object.freeze({ eventKey: raw.eventKey, contentDigest: raw.contentDigest });
  });
  const keys = receipts.map((receipt) => receipt.eventKey);
  if (new Set(keys).size !== keys.length) throw new BehavioralSignalError("INTEGRITY_FAILURE", "micro receipts contain duplicate event keys");
  const sorted = [...receipts].sort((a, b) => a.eventKey.localeCompare(b.eventKey, "en"));
  if (canonicalJson(sorted) !== canonicalJson(receipts)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "micro receipts are not deterministically ordered");
  return Object.freeze(receipts);
}

function parseKind(value: JsonValue | undefined, field: string): BehavioralMicroInteractionKind {
  if (typeof value !== "string" || !KINDS.includes(value as BehavioralMicroInteractionKind)) throw new BehavioralSignalError("INTEGRITY_FAILURE", `${field} invalid`);
  return value as BehavioralMicroInteractionKind;
}

function parseOptionalIdentifier(value: JsonValue | undefined, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new BehavioralSignalError("INTEGRITY_FAILURE", `${field} invalid`);
  return identifier(value, field, "INTEGRITY_FAILURE");
}

function sessionDigest(siteId: string, sessionKey: string, keyId: string, payload: SessionPayload, updatedAt: string): string {
  return hash("cortex-behavioral-micro-session-record-v1", { siteId, sessionKey, keyId, payload, updatedAt });
}

function siteDigest(siteId: string, payload: SitePayload, updatedAt: string): string {
  return hash("cortex-behavioral-micro-site-record-v1", { siteId, payload, updatedAt });
}

function sessionProperties(siteId: string, sessionKey: string, keyId: string, payload: SessionPayload, updatedAt: string): Record<string, JsonValue> {
  return {
    [SESSION.siteId]: siteId,
    [SESSION.sessionKey]: sessionKey,
    [SESSION.keyId]: keyId,
    [SESSION.payload]: json(payload, "micro.session.payload"),
    [SESSION.digest]: sessionDigest(siteId, sessionKey, keyId, payload, updatedAt),
    [SESSION.updatedAt]: updatedAt,
  };
}

function siteProperties(siteId: string, payload: SitePayload, updatedAt: string): Record<string, JsonValue> {
  return {
    [SITE.siteId]: siteId,
    [SITE.payload]: json(payload, "micro.site.payload"),
    [SITE.digest]: siteDigest(siteId, payload, updatedAt),
    [SITE.updatedAt]: updatedAt,
  };
}

function parseSession(record: ObjectRecord): SessionRecord {
  if (record.typeId !== SESSION_TYPE) throw new BehavioralSignalError("INTEGRITY_FAILURE", "micro session type mismatch");
  const siteId = identifier(requiredString(record, SESSION.siteId), "stored micro.session.siteId", "INTEGRITY_FAILURE");
  const sessionKey = requiredString(record, SESSION.sessionKey);
  if (!HMAC256.test(sessionKey)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "stored micro session key invalid");
  const keyId = identifier(requiredString(record, SESSION.keyId), "stored micro.session.keyId", "INTEGRITY_FAILURE");
  const raw = object(record.properties[SESSION.payload], "micro.session.payload");
  exactKeys(raw as unknown as Record<string, unknown>, SESSION_PAYLOAD_KEYS, "micro.session.payload", "INTEGRITY_FAILURE");
  const firstEventAt = utc(String(raw.firstEventAt), "micro.session.firstEventAt", "INTEGRITY_FAILURE");
  const lastEventAt = utc(String(raw.lastEventAt), "micro.session.lastEventAt", "INTEGRITY_FAILURE");
  if (Date.parse(firstEventAt) > Date.parse(lastEventAt)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "micro session event range invalid");
  const receipts = parseReceipts(raw.receipts);
  const counts = parseCounters(raw.counts, "micro.session.counts");
  if (receipts.length !== KINDS.reduce((sum, kind) => sum + counts[kind], 0)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "micro session receipt/count mismatch");
  const totalReadingPauseMs = safeCount(raw.totalReadingPauseMs, "micro.session.totalReadingPauseMs");
  if (typeof raw.lastSurfaceId !== "string") throw new BehavioralSignalError("INTEGRITY_FAILURE", "micro session lastSurfaceId invalid");
  const lastSurfaceId = identifier(raw.lastSurfaceId, "micro.session.lastSurfaceId", "INTEGRITY_FAILURE");
  const lastElementId = parseOptionalIdentifier(raw.lastElementId, "micro.session.lastElementId");
  const lastEventKind = parseKind(raw.lastEventKind, "micro.session.lastEventKind");
  if (typeof raw.lastEventDigest !== "string" || !SHA256.test(raw.lastEventDigest)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "micro session lastEventDigest invalid");
  if (typeof raw.lastPolicyDigest !== "string" || !SHA256.test(raw.lastPolicyDigest)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "micro session lastPolicyDigest invalid");
  const payload: SessionPayload = { firstEventAt, lastEventAt, receipts, counts, totalReadingPauseMs, lastSurfaceId, lastElementId, lastEventKind, lastEventDigest: raw.lastEventDigest, lastPolicyDigest: raw.lastPolicyDigest };
  const updatedAt = utc(requiredString(record, SESSION.updatedAt), "micro.session.updatedAt", "INTEGRITY_FAILURE");
  const digest = requiredString(record, SESSION.digest);
  if (digest !== sessionDigest(siteId, sessionKey, keyId, payload, updatedAt)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "micro session digest mismatch");
  return Object.freeze({ id: record.id, siteId, sessionKey, keyId, ...payload, updatedAt, revision: record.revision, digest });
}

function parseSite(record: ObjectRecord): SiteRecord {
  if (record.typeId !== SITE_TYPE) throw new BehavioralSignalError("INTEGRITY_FAILURE", "micro site type mismatch");
  const siteId = identifier(requiredString(record, SITE.siteId), "stored micro.site.siteId", "INTEGRITY_FAILURE");
  const raw = object(record.properties[SITE.payload], "micro.site.payload");
  exactKeys(raw as unknown as Record<string, unknown>, SITE_PAYLOAD_KEYS, "micro.site.payload", "INTEGRITY_FAILURE");
  const firstEventAt = utc(String(raw.firstEventAt), "micro.site.firstEventAt", "INTEGRITY_FAILURE");
  const lastEventAt = utc(String(raw.lastEventAt), "micro.site.lastEventAt", "INTEGRITY_FAILURE");
  if (Date.parse(firstEventAt) > Date.parse(lastEventAt)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "micro site event range invalid");
  const eventCount = safeCount(raw.eventCount, "micro.site.eventCount");
  const sessionCount = safeCount(raw.sessionCount, "micro.site.sessionCount");
  if (eventCount === 0 || sessionCount === 0 || sessionCount > eventCount) throw new BehavioralSignalError("INTEGRITY_FAILURE", "micro site aggregate counts inconsistent");
  const counts = parseCounters(raw.counts, "micro.site.counts");
  if (eventCount !== KINDS.reduce((sum, kind) => sum + counts[kind], 0)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "micro site event/count mismatch");
  const totalReadingPauseMs = safeCount(raw.totalReadingPauseMs, "micro.site.totalReadingPauseMs");
  if (typeof raw.lastSurfaceId !== "string") throw new BehavioralSignalError("INTEGRITY_FAILURE", "micro site lastSurfaceId invalid");
  const lastSurfaceId = identifier(raw.lastSurfaceId, "micro.site.lastSurfaceId", "INTEGRITY_FAILURE");
  const lastElementId = parseOptionalIdentifier(raw.lastElementId, "micro.site.lastElementId");
  const lastEventKind = parseKind(raw.lastEventKind, "micro.site.lastEventKind");
  if (typeof raw.lastEventDigest !== "string" || !SHA256.test(raw.lastEventDigest)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "micro site lastEventDigest invalid");
  if (typeof raw.lastPolicyDigest !== "string" || !SHA256.test(raw.lastPolicyDigest)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "micro site lastPolicyDigest invalid");
  const payload: SitePayload = { firstEventAt, lastEventAt, eventCount, sessionCount, counts, totalReadingPauseMs, lastSurfaceId, lastElementId, lastEventKind, lastEventDigest: raw.lastEventDigest, lastPolicyDigest: raw.lastPolicyDigest };
  const updatedAt = utc(requiredString(record, SITE.updatedAt), "micro.site.updatedAt", "INTEGRITY_FAILURE");
  const digest = requiredString(record, SITE.digest);
  if (digest !== siteDigest(siteId, payload, updatedAt)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "micro site digest mismatch");
  return Object.freeze({ id: record.id, siteId, ...payload, updatedAt, revision: record.revision, digest });
}

function sessionSnapshot(record: SessionRecord): BehavioralMicroSessionSnapshot {
  return Object.freeze({ siteId: record.siteId, sessionKey: record.sessionKey, keyId: record.keyId, firstEventAt: record.firstEventAt, lastEventAt: record.lastEventAt, eventCount: record.receipts.length, counts: record.counts, totalReadingPauseMs: record.totalReadingPauseMs, lastSurfaceId: record.lastSurfaceId, lastElementId: record.lastElementId, lastEventKind: record.lastEventKind, lastEventDigest: record.lastEventDigest, lastPolicyDigest: record.lastPolicyDigest, digest: record.digest });
}

function siteSnapshot(record: SiteRecord): BehavioralMicroSiteSnapshot {
  return Object.freeze({ siteId: record.siteId, firstEventAt: record.firstEventAt, lastEventAt: record.lastEventAt, eventCount: record.eventCount, sessionCount: record.sessionCount, counts: record.counts, totalReadingPauseMs: record.totalReadingPauseMs, lastSurfaceId: record.lastSurfaceId, lastElementId: record.lastElementId, lastEventKind: record.lastEventKind, lastEventDigest: record.lastEventDigest, lastPolicyDigest: record.lastPolicyDigest, digest: record.digest });
}

function effectiveMode(policyMode: BehavioralSignalMode, requested: BehavioralSignalMode | undefined): BehavioralSignalMode {
  const mode = requested ?? policyMode;
  if (!MODES.includes(mode)) throw new BehavioralSignalError("INVALID_INPUT", "mode invalid");
  const rank: Record<BehavioralSignalMode, number> = { ACTIVE: 0, OBSERVE_ONLY: 1, KILLED: 2 };
  return rank[mode] > rank[policyMode] ? mode : policyMode;
}

function isLater(event: NormalizedEvent, currentAt: string, currentDigest: string): boolean {
  const left = Date.parse(event.occurredAt);
  const right = Date.parse(currentAt);
  return left > right || (left === right && event.contentDigest.localeCompare(currentDigest, "en") > 0);
}

function conflict(error: unknown): boolean {
  return error instanceof OntologyTransactionError && error.code === "CONFLICT";
}

export class BehavioralMicroInteractionTrackingEngine {
  readonly schema: ValidatedSchema;
  private readonly privacyKey: Buffer;
  private readonly allowedSurfaces: ReadonlySet<string>;
  private readonly allowedElements: ReadonlySet<string>;

  constructor(
    private readonly transactions: OntologyTransactionPort,
    readonly scope: OntologyScope,
    readonly policy: BehavioralSignalPolicy,
    privacy: BehavioralSignalPrivacyConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.schema = schema(scope);
    this.privacyKey = typeof privacy.pseudonymizationKey === "string" ? Buffer.from(privacy.pseudonymizationKey, "utf8") : Buffer.from(privacy.pseudonymizationKey);
    if (this.privacyKey.byteLength < 32 || this.privacyKey.byteLength > 4_096) throw new BehavioralSignalError("INVALID_INPUT", "pseudonymizationKey must contain 32..4096 bytes");
    this.allowedSurfaces = new Set(policy.allowedSurfaceIds);
    this.allowedElements = new Set(policy.allowedElementIds);
  }

  private pseudonym(namespace: string, siteId: string, value: string): string {
    const digest = createHmac("sha256", this.privacyKey).update(`${this.policy.pseudonymizationKeyId}\n${namespace}\n${siteId}\n${value}`, "utf8").digest("hex");
    return `hmac-sha256:${digest}`;
  }

  private sessionId(siteId: string, sessionKey: string): string {
    return ontologyId("cortex-behavioral-micro-session-v1", { scope: this.scope, siteId, sessionKey });
  }

  private siteId(siteId: string): string {
    return ontologyId("cortex-behavioral-micro-site-v1", { scope: this.scope, siteId });
  }

  private readSession(siteId: string, sessionKey: string): SessionRecord | undefined {
    const raw = this.transactions.getObject(this.scope, this.sessionId(siteId, sessionKey));
    return raw ? parseSession(raw) : undefined;
  }

  private readSite(siteId: string): SiteRecord | undefined {
    const raw = this.transactions.getObject(this.scope, this.siteId(siteId));
    return raw ? parseSite(raw) : undefined;
  }

  private normalize(input: BehavioralMicroInteractionInput, siteId: string, nowMs: number): NormalizedEvent {
    const eventId = opaqueId(input.eventId, "eventId");
    const sessionId = opaqueId(input.sessionId, "sessionId");
    if (!KINDS.includes(input.kind)) throw new BehavioralSignalError("INVALID_INPUT", "kind invalid");
    const occurredAt = utc(input.occurredAt, "occurredAt");
    const occurredMs = Date.parse(occurredAt);
    if (occurredMs > nowMs + this.policy.maxFutureSkewMs) throw new BehavioralSignalError("POLICY_VIOLATION", "micro signal occurs too far in the future");
    if (nowMs - occurredMs > this.policy.maxEventAgeMs) throw new BehavioralSignalError("POLICY_VIOLATION", "micro signal is older than maxEventAgeMs");
    const surfaceId = identifier(input.surfaceId, "surfaceId");
    const elementId = input.elementId === undefined || input.elementId === null ? null : identifier(input.elementId, "elementId");
    const durationMs = input.durationMs === undefined || input.durationMs === null ? null : input.durationMs;
    if (input.kind === "READING_PAUSE") {
      if (!Number.isSafeInteger(durationMs) || durationMs === null || durationMs <= 0 || durationMs > this.policy.maxEngagementMsPerEvent) throw new BehavioralSignalError("INVALID_INPUT", "durationMs is required for READING_PAUSE and must be within maxEngagementMsPerEvent");
      if (elementId !== null) throw new BehavioralSignalError("INVALID_INPUT", "elementId is not allowed for READING_PAUSE");
    } else {
      if (!POINTER_TOUCH.has(input.kind)) throw new BehavioralSignalError("INVALID_INPUT", "unsupported micro interaction kind");
      if (elementId === null) throw new BehavioralSignalError("INVALID_INPUT", "elementId is required for pointer/touch signals");
      if (durationMs !== null) throw new BehavioralSignalError("INVALID_INPUT", "durationMs is allowed only for READING_PAUSE");
    }
    if (!this.allowedSurfaces.has(surfaceId)) throw new BehavioralSignalError("POLICY_VIOLATION", `surfaceId ${surfaceId} is not allowlisted`);
    if (elementId !== null && !this.allowedElements.has(elementId)) throw new BehavioralSignalError("POLICY_VIOLATION", `elementId ${elementId} is not allowlisted`);
    if (typeof input.privacyDecisionRef !== "string" || !input.privacyDecisionRef.trim()) throw new BehavioralSignalError("INVALID_INPUT", "privacyDecisionRef is required when collectionAllowed=true");
    const privacyDecisionRef = identifier(input.privacyDecisionRef, "privacyDecisionRef");
    const eventKey = this.pseudonym("micro-event", siteId, `${sessionId}\n${eventId}`);
    const sessionKey = this.pseudonym("micro-session", siteId, sessionId);
    const privacyDecisionDigest = this.pseudonym("micro-privacy-decision", siteId, privacyDecisionRef);
    const core = { eventKey, sessionKey, siteId, kind: input.kind, occurredAt, surfaceId, elementId, durationMs, privacyDecisionDigest };
    return Object.freeze({ ...core, contentDigest: hash("cortex-behavioral-micro-event-content-v1", core) });
  }

  private result(status: BehavioralMicroInteractionStatus, reason: BehavioralMicroInteractionReason, mode: BehavioralSignalMode, siteId: string, eventDigest: string | null, session: SessionRecord | null, site: SiteRecord | null): BehavioralMicroInteractionResult {
    return Object.freeze({ status, reason, mode, siteId, eventDigest, session: session ? sessionSnapshot(session) : null, site: site ? siteSnapshot(site) : null, policyDigest: this.policy.digest });
  }

  ingest(input: BehavioralMicroInteractionInput): BehavioralMicroInteractionResult {
    exactKeys(input as unknown as Record<string, unknown>, INPUT_KEYS, "micro event", "INVALID_INPUT");
    const siteId = identifier(input.siteId, "siteId");
    if (typeof input.collectionAllowed !== "boolean") throw new BehavioralSignalError("INVALID_INPUT", "collectionAllowed must be boolean");
    const mode = effectiveMode(this.policy.mode, input.mode);
    if (mode === "KILLED") return this.result("NOOP", "KILL_SWITCH", mode, siteId, null, null, null);
    if (!input.collectionAllowed) return this.result("NOOP", "PRIVACY_DENIED", mode, siteId, null, null, null);
    const nowMs = this.now();
    if (!Number.isFinite(nowMs)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "engine clock invalid");
    const nowIso = new Date(nowMs).toISOString();
    const event = this.normalize(input, siteId, nowMs);
    if (mode === "OBSERVE_ONLY") return this.result("OBSERVED", "OBSERVE_ONLY", mode, siteId, event.contentDigest, null, null);

    for (let attempt = 0; attempt <= this.policy.maxWriteRetries; attempt += 1) {
      const session = this.readSession(siteId, event.sessionKey);
      const site = this.readSite(siteId);
      if (session && !site) throw new BehavioralSignalError("INTEGRITY_FAILURE", "micro session exists without site aggregate");
      if (session) {
        const receipt = session.receipts.find((item) => item.eventKey === event.eventKey);
        if (receipt) {
          if (receipt.contentDigest !== event.contentDigest) throw new BehavioralSignalError("CONFLICT", "micro eventId replayed with different content");
          if (!site) throw new BehavioralSignalError("INTEGRITY_FAILURE", "duplicate micro event has no site aggregate");
          return this.result("DUPLICATE", "DUPLICATE", mode, siteId, event.contentDigest, session, site);
        }
      }
      if (session && session.receipts.length >= Math.min(this.policy.maxEventsPerSession, HARD_MAX_RECEIPTS)) throw new BehavioralSignalError("POLICY_VIOLATION", "micro session exceeded maxEventsPerSession");
      const firstEventAt = session && Date.parse(session.firstEventAt) < Date.parse(event.occurredAt) ? session.firstEventAt : event.occurredAt;
      const lastEventAt = session && Date.parse(session.lastEventAt) > Date.parse(event.occurredAt) ? session.lastEventAt : event.occurredAt;
      if (Date.parse(lastEventAt) - Date.parse(firstEventAt) > this.policy.maxSessionDurationMs) throw new BehavioralSignalError("POLICY_VIOLATION", "micro session exceeded maxSessionDurationMs");
      const laterSession = !session || isLater(event, session.lastEventAt, session.lastEventDigest);
      const receipts = Object.freeze([...(session?.receipts ?? []), Object.freeze({ eventKey: event.eventKey, contentDigest: event.contentDigest })].sort((a, b) => a.eventKey.localeCompare(b.eventKey, "en")));
      const sessionPayload: SessionPayload = Object.freeze({
        firstEventAt,
        lastEventAt,
        receipts,
        counts: incrementCounters(session?.counts ?? initialCounters(), event.kind),
        totalReadingPauseMs: safeAdd(session?.totalReadingPauseMs ?? 0, event.durationMs ?? 0, "micro.session.totalReadingPauseMs"),
        lastSurfaceId: laterSession ? event.surfaceId : session.lastSurfaceId,
        lastElementId: laterSession ? event.elementId : session.lastElementId,
        lastEventKind: laterSession ? event.kind : session.lastEventKind,
        lastEventDigest: laterSession ? event.contentDigest : session.lastEventDigest,
        lastPolicyDigest: this.policy.digest,
      });
      const laterSite = !site || isLater(event, site.lastEventAt, site.lastEventDigest);
      const sitePayload: SitePayload = Object.freeze({
        firstEventAt: site && Date.parse(site.firstEventAt) < Date.parse(event.occurredAt) ? site.firstEventAt : event.occurredAt,
        lastEventAt: site && Date.parse(site.lastEventAt) > Date.parse(event.occurredAt) ? site.lastEventAt : event.occurredAt,
        eventCount: safeAdd(site?.eventCount ?? 0, 1, "micro.site.eventCount"),
        sessionCount: safeAdd(site?.sessionCount ?? 0, session ? 0 : 1, "micro.site.sessionCount"),
        counts: incrementCounters(site?.counts ?? initialCounters(), event.kind),
        totalReadingPauseMs: safeAdd(site?.totalReadingPauseMs ?? 0, event.durationMs ?? 0, "micro.site.totalReadingPauseMs"),
        lastSurfaceId: laterSite ? event.surfaceId : site.lastSurfaceId,
        lastElementId: laterSite ? event.elementId : site.lastElementId,
        lastEventKind: laterSite ? event.kind : site.lastEventKind,
        lastEventDigest: laterSite ? event.contentDigest : site.lastEventDigest,
        lastPolicyDigest: this.policy.digest,
      });
      const operations: TransactionOperation[] = [
        session
          ? { kind: "UPDATE_OBJECT", id: session.id, expectedRevision: session.revision, properties: sessionProperties(siteId, event.sessionKey, this.policy.pseudonymizationKeyId, sessionPayload, nowIso) }
          : { kind: "CREATE_OBJECT", record: { id: this.sessionId(siteId, event.sessionKey), typeId: SESSION_TYPE, scope: this.scope, properties: sessionProperties(siteId, event.sessionKey, this.policy.pseudonymizationKeyId, sessionPayload, nowIso) } },
        site
          ? { kind: "UPDATE_OBJECT", id: site.id, expectedRevision: site.revision, properties: siteProperties(siteId, sitePayload, nowIso) }
          : { kind: "CREATE_OBJECT", record: { id: this.siteId(siteId), typeId: SITE_TYPE, scope: this.scope, properties: siteProperties(siteId, sitePayload, nowIso) } },
      ];
      try {
        this.transactions.transact(this.scope, this.schema, operations);
        const storedSession = this.readSession(siteId, event.sessionKey);
        const storedSite = this.readSite(siteId);
        if (!storedSession || !storedSite) throw new BehavioralSignalError("PERSISTENCE_FAILURE", "committed micro signal state is unreadable");
        return this.result("RECORDED", "RECORDED", mode, siteId, event.contentDigest, storedSession, storedSite);
      } catch (error) {
        if (conflict(error) && attempt < this.policy.maxWriteRetries) continue;
        if (conflict(error)) throw new BehavioralSignalError("CONFLICT", "behavioral micro signal write conflicted");
        if (error instanceof BehavioralSignalError) throw error;
        throw new BehavioralSignalError("PERSISTENCE_FAILURE", error instanceof Error ? error.message : "behavioral micro signal write failed");
      }
    }
    throw new BehavioralSignalError("CONFLICT", "behavioral micro signal write exhausted retries");
  }

  getSessionSnapshot(siteIdInput: string, sessionIdInput: string): BehavioralMicroSessionSnapshot | null {
    const siteId = identifier(siteIdInput, "siteId");
    const sessionId = opaqueId(sessionIdInput, "sessionId");
    const sessionKey = this.pseudonym("micro-session", siteId, sessionId);
    const record = this.readSession(siteId, sessionKey);
    return record ? sessionSnapshot(record) : null;
  }

  getSiteSnapshot(siteIdInput: string): BehavioralMicroSiteSnapshot | null {
    const siteId = identifier(siteIdInput, "siteId");
    const record = this.readSite(siteId);
    return record ? siteSnapshot(record) : null;
  }
}
