import { createHash, createHmac } from "node:crypto";
import { canonicalJson, ontologyId, validateSchema, type OntologyScope, type SchemaVersion, type ValidatedSchema } from "@nexus/ontology";
import { OntologyTransactionError, type JsonValue, type ObjectRecord, type OntologyTransactionPort, type TransactionOperation } from "@nexus/ontology/transaction";

const SESSION_TYPE = "cortex.behavioral_signal_session";
const SITE_TYPE = "cortex.behavioral_signal_site";
const IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const OPAQUE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{7,255})$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const HMAC256 = /^hmac-sha256:[0-9a-f]{64}$/u;
const HARD_MAX_EVENTS_PER_SESSION = 512;
const HARD_MAX_SURFACES = 512;
const HARD_MAX_ELEMENTS = 2_048;

const SESSION = Object.freeze({
  siteId: "cortex.behavioral_signal.session.site_id",
  sessionKey: "cortex.behavioral_signal.session.session_key",
  keyId: "cortex.behavioral_signal.session.key_id",
  payload: "cortex.behavioral_signal.session.payload",
  digest: "cortex.behavioral_signal.session.digest",
  updatedAt: "cortex.behavioral_signal.session.updated_at",
});
const SITE = Object.freeze({
  siteId: "cortex.behavioral_signal.site.site_id",
  payload: "cortex.behavioral_signal.site.payload",
  digest: "cortex.behavioral_signal.site.digest",
  updatedAt: "cortex.behavioral_signal.site.updated_at",
});

export type BehavioralSignalKind =
  | "PAGE_VIEW"
  | "CTA_CLICK"
  | "FORM_START"
  | "FORM_SUBMIT"
  | "FORM_ERROR"
  | "SCROLL_DEPTH"
  | "ENGAGEMENT"
  | "NAVIGATION";

export type BehavioralSignalMode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";
export type BehavioralSignalStatus = "RECORDED" | "DUPLICATE" | "OBSERVED" | "NOOP";
export type BehavioralSignalReason = "RECORDED" | "DUPLICATE" | "OBSERVE_ONLY" | "KILL_SWITCH" | "PRIVACY_DENIED";

export interface CreateBehavioralSignalPolicyInput {
  readonly policyId: string;
  readonly version: string;
  readonly pseudonymizationKeyId: string;
  readonly allowedSurfaceIds: readonly string[];
  readonly allowedElementIds?: readonly string[];
  readonly maxEventAgeMs: number;
  readonly maxFutureSkewMs: number;
  readonly maxSessionDurationMs: number;
  readonly maxEventsPerSession: number;
  readonly maxEngagementMsPerEvent: number;
  readonly maxWriteRetries?: number;
  readonly mode?: BehavioralSignalMode;
}

export interface BehavioralSignalPolicy {
  readonly policyId: string;
  readonly version: string;
  readonly pseudonymizationKeyId: string;
  readonly allowedSurfaceIds: readonly string[];
  readonly allowedElementIds: readonly string[];
  readonly maxEventAgeMs: number;
  readonly maxFutureSkewMs: number;
  readonly maxSessionDurationMs: number;
  readonly maxEventsPerSession: number;
  readonly maxEngagementMsPerEvent: number;
  readonly maxWriteRetries: number;
  readonly mode: BehavioralSignalMode;
  readonly digest: string;
}

export interface BehavioralSignalPrivacyConfig {
  readonly pseudonymizationKey: string | Uint8Array;
}

export interface BehavioralSignalEventInput {
  readonly eventId: string;
  readonly sessionId: string;
  readonly siteId: string;
  readonly kind: BehavioralSignalKind;
  readonly occurredAt: string;
  readonly surfaceId: string;
  readonly elementId?: string | null;
  readonly engagementMs?: number | null;
  readonly scrollDepthPercent?: number | null;
  readonly collectionAllowed: boolean;
  readonly privacyDecisionRef?: string | null;
  readonly mode?: BehavioralSignalMode;
}

export type BehavioralSignalCounters = Readonly<Record<BehavioralSignalKind, number>>;

export interface BehavioralSessionSnapshot {
  readonly siteId: string;
  readonly sessionKey: string;
  readonly keyId: string;
  readonly firstEventAt: string;
  readonly lastEventAt: string;
  readonly eventCount: number;
  readonly counts: BehavioralSignalCounters;
  readonly totalEngagementMs: number;
  readonly maxScrollDepthPercent: number;
  readonly lastSurfaceId: string;
  readonly lastEventKind: BehavioralSignalKind;
  readonly lastEventDigest: string;
  readonly lastPolicyDigest: string;
  readonly digest: string;
}

export interface BehavioralSiteSnapshot {
  readonly siteId: string;
  readonly firstEventAt: string;
  readonly lastEventAt: string;
  readonly eventCount: number;
  readonly sessionCount: number;
  readonly counts: BehavioralSignalCounters;
  readonly totalEngagementMs: number;
  readonly maxScrollDepthPercent: number;
  readonly lastSurfaceId: string;
  readonly lastEventKind: BehavioralSignalKind;
  readonly lastEventDigest: string;
  readonly lastPolicyDigest: string;
  readonly digest: string;
}

export interface BehavioralSignalIngestResult {
  readonly status: BehavioralSignalStatus;
  readonly reason: BehavioralSignalReason;
  readonly mode: BehavioralSignalMode;
  readonly siteId: string;
  readonly eventDigest: string | null;
  readonly session: BehavioralSessionSnapshot | null;
  readonly site: BehavioralSiteSnapshot | null;
  readonly policyDigest: string;
}

export interface BehavioralSignalTelemetryEvent {
  readonly status: BehavioralSignalStatus;
  readonly reason: BehavioralSignalReason;
  readonly mode: BehavioralSignalMode;
  readonly siteId: string;
  readonly kind: BehavioralSignalKind | null;
  readonly surfaceId: string | null;
  readonly eventDigest: string | null;
}

export class BehavioralSignalError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "POLICY_VIOLATION" | "INTEGRITY_FAILURE" | "PERSISTENCE_FAILURE" | "CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "BehavioralSignalError";
  }
}

interface EventReceipt {
  readonly eventKey: string;
  readonly contentDigest: string;
}

interface SessionPayload {
  readonly firstEventAt: string;
  readonly lastEventAt: string;
  readonly eventReceipts: readonly EventReceipt[];
  readonly counts: BehavioralSignalCounters;
  readonly totalEngagementMs: number;
  readonly maxScrollDepthPercent: number;
  readonly lastSurfaceId: string;
  readonly lastEventKind: BehavioralSignalKind;
  readonly lastEventDigest: string;
  readonly lastPolicyDigest: string;
}

interface SitePayload {
  readonly firstEventAt: string;
  readonly lastEventAt: string;
  readonly eventCount: number;
  readonly sessionCount: number;
  readonly counts: BehavioralSignalCounters;
  readonly totalEngagementMs: number;
  readonly maxScrollDepthPercent: number;
  readonly lastSurfaceId: string;
  readonly lastEventKind: BehavioralSignalKind;
  readonly lastEventDigest: string;
  readonly lastPolicyDigest: string;
}

interface SessionRecord extends SessionPayload {
  readonly id: string;
  readonly siteId: string;
  readonly sessionKey: string;
  readonly keyId: string;
  readonly digest: string;
  readonly updatedAt: string;
  readonly revision: number;
}

interface SiteRecord extends SitePayload {
  readonly id: string;
  readonly siteId: string;
  readonly digest: string;
  readonly updatedAt: string;
  readonly revision: number;
}

interface NormalizedEvent {
  readonly eventKey: string;
  readonly sessionKey: string;
  readonly siteId: string;
  readonly kind: BehavioralSignalKind;
  readonly occurredAt: string;
  readonly surfaceId: string;
  readonly elementId: string | null;
  readonly engagementMs: number | null;
  readonly scrollDepthPercent: number | null;
  readonly privacyDecisionDigest: string;
  readonly contentDigest: string;
}

const KINDS: readonly BehavioralSignalKind[] = [
  "PAGE_VIEW",
  "CTA_CLICK",
  "FORM_START",
  "FORM_SUBMIT",
  "FORM_ERROR",
  "SCROLL_DEPTH",
  "ENGAGEMENT",
  "NAVIGATION",
];
const MODES: readonly BehavioralSignalMode[] = ["ACTIVE", "OBSERVE_ONLY", "KILLED"];
const ELEMENT_KINDS = new Set<BehavioralSignalKind>(["CTA_CLICK", "FORM_START", "FORM_SUBMIT", "FORM_ERROR"]);
const EVENT_KEYS = new Set([
  "eventId",
  "sessionId",
  "siteId",
  "kind",
  "occurredAt",
  "surfaceId",
  "elementId",
  "engagementMs",
  "scrollDepthPercent",
  "collectionAllowed",
  "privacyDecisionRef",
  "mode",
]);
const SESSION_PAYLOAD_KEYS = new Set([
  "firstEventAt",
  "lastEventAt",
  "eventReceipts",
  "counts",
  "totalEngagementMs",
  "maxScrollDepthPercent",
  "lastSurfaceId",
  "lastEventKind",
  "lastEventDigest",
  "lastPolicyDigest",
]);
const SITE_PAYLOAD_KEYS = new Set([
  "firstEventAt",
  "lastEventAt",
  "eventCount",
  "sessionCount",
  "counts",
  "totalEngagementMs",
  "maxScrollDepthPercent",
  "lastSurfaceId",
  "lastEventKind",
  "lastEventDigest",
  "lastPolicyDigest",
]);

function hash(namespace: string, value: unknown): string {
  return `sha256:${createHash("sha256").update(`${namespace}\n${canonicalJson(value)}`, "utf8").digest("hex")}`;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, field: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new BehavioralSignalError("INVALID_INPUT", `${field} contains unsupported field ${key}`);
}

function exactStoredKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, field: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new BehavioralSignalError("INTEGRITY_FAILURE", `${field} contains unsupported field ${key}`);
}

function identifier(value: string, field: string): string {
  if (typeof value !== "string") throw new BehavioralSignalError("INVALID_INPUT", `${field} must be a string`);
  const normalized = value.trim();
  if (!IDENTIFIER.test(normalized)) throw new BehavioralSignalError("INVALID_INPUT", `${field} is malformed`);
  return normalized;
}

function opaqueId(value: string, field: string): string {
  if (typeof value !== "string") throw new BehavioralSignalError("INVALID_INPUT", `${field} must be a string`);
  const normalized = value.trim();
  if (!OPAQUE_ID.test(normalized)) throw new BehavioralSignalError("INVALID_INPUT", `${field} must be an opaque 8..256 character identifier`);
  return normalized;
}

function storedIdentifier(value: string, field: string): string {
  try {
    return identifier(value, field);
  } catch (error) {
    throw new BehavioralSignalError("INTEGRITY_FAILURE", error instanceof Error ? error.message : `${field} invalid`);
  }
}

function utc(value: string, field: string): string {
  if (typeof value !== "string") throw new BehavioralSignalError("INVALID_INPUT", `${field} must be a string`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new BehavioralSignalError("INVALID_INPUT", `${field} must be canonical UTC`);
  return value;
}

function storedUtc(value: string, field: string): string {
  try {
    return utc(value, field);
  } catch (error) {
    throw new BehavioralSignalError("INTEGRITY_FAILURE", error instanceof Error ? error.message : `${field} invalid`);
  }
}

function positiveInt(value: number, field: string, max: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new BehavioralSignalError("INVALID_INPUT", `${field} must be 1..${max}`);
  return value;
}

function nonNegativeInt(value: number, field: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new BehavioralSignalError("INVALID_INPUT", `${field} must be 0..${max}`);
  return value;
}

function boundedOptionalInt(value: number | null | undefined, field: string, min: number, max: number): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new BehavioralSignalError("INVALID_INPUT", `${field} must be ${min}..${max} when present`);
  return value;
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

function object(value: JsonValue | undefined, field: string): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BehavioralSignalError("INTEGRITY_FAILURE", `${field} must be object`);
  return value as Record<string, JsonValue>;
}

function property(id: string, name: string, valueKind: "STRING" | "JSON" | "DATETIME", immutable = false) {
  return { id, name, valueKind, cardinality: "REQUIRED", unique: false, immutable } as const;
}

function schema(scope: OntologyScope): ValidatedSchema {
  const value: SchemaVersion = {
    version: "cortex-behavioral-signal-v1",
    scope,
    properties: [
      property(SESSION.siteId, "BehavioralSignalSessionSiteId", "STRING", true),
      property(SESSION.sessionKey, "BehavioralSignalSessionKey", "STRING", true),
      property(SESSION.keyId, "BehavioralSignalSessionKeyId", "STRING", true),
      property(SESSION.payload, "BehavioralSignalSessionPayload", "JSON"),
      property(SESSION.digest, "BehavioralSignalSessionDigest", "STRING"),
      property(SESSION.updatedAt, "BehavioralSignalSessionUpdatedAt", "DATETIME"),
      property(SITE.siteId, "BehavioralSignalSiteId", "STRING", true),
      property(SITE.payload, "BehavioralSignalSitePayload", "JSON"),
      property(SITE.digest, "BehavioralSignalSiteDigest", "STRING"),
      property(SITE.updatedAt, "BehavioralSignalSiteUpdatedAt", "DATETIME"),
    ],
    interfaces: [],
    objects: [
      { id: SESSION_TYPE, name: "CortexBehavioralSignalSession", propertyIds: Object.values(SESSION), interfaceIds: [] },
      { id: SITE_TYPE, name: "CortexBehavioralSignalSite", propertyIds: Object.values(SITE), interfaceIds: [] },
    ],
    relationships: [],
    actions: [],
    functions: [],
    events: [],
  };
  return validateSchema(value);
}

function initialCounters(): BehavioralSignalCounters {
  return Object.freeze({
    PAGE_VIEW: 0,
    CTA_CLICK: 0,
    FORM_START: 0,
    FORM_SUBMIT: 0,
    FORM_ERROR: 0,
    SCROLL_DEPTH: 0,
    ENGAGEMENT: 0,
    NAVIGATION: 0,
  });
}

function incrementCounters(current: BehavioralSignalCounters, kind: BehavioralSignalKind): BehavioralSignalCounters {
  const next = { ...current, [kind]: current[kind] + 1 };
  if (!Number.isSafeInteger(next[kind])) throw new BehavioralSignalError("INTEGRITY_FAILURE", "signal counter overflow");
  return Object.freeze(next);
}

function parseCounters(value: JsonValue | undefined, field: string): BehavioralSignalCounters {
  const raw = object(value, field);
  exactStoredKeys(raw as unknown as Record<string, unknown>, new Set(KINDS), field);
  const result = {} as Record<BehavioralSignalKind, number>;
  for (const kind of KINDS) {
    const item = raw[kind];
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0) throw new BehavioralSignalError("INTEGRITY_FAILURE", `${field}.${kind} invalid`);
    result[kind] = item;
  }
  return Object.freeze(result);
}

function parseReceipt(value: JsonValue, field: string): EventReceipt {
  const raw = object(value, field);
  exactStoredKeys(raw as unknown as Record<string, unknown>, new Set(["eventKey", "contentDigest"]), field);
  if (typeof raw.eventKey !== "string" || !HMAC256.test(raw.eventKey)) throw new BehavioralSignalError("INTEGRITY_FAILURE", `${field}.eventKey invalid`);
  if (typeof raw.contentDigest !== "string" || !SHA256.test(raw.contentDigest)) throw new BehavioralSignalError("INTEGRITY_FAILURE", `${field}.contentDigest invalid`);
  return Object.freeze({ eventKey: raw.eventKey, contentDigest: raw.contentDigest });
}

function parseReceipts(value: JsonValue | undefined): readonly EventReceipt[] {
  if (!Array.isArray(value)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "session.eventReceipts must be an array");
  if (value.length > HARD_MAX_EVENTS_PER_SESSION) throw new BehavioralSignalError("INTEGRITY_FAILURE", "session.eventReceipts exceeds hard limit");
  const receipts = value.map((item, index) => parseReceipt(item, `session.eventReceipts[${index}]`));
  const keys = receipts.map((item) => item.eventKey);
  if (new Set(keys).size !== keys.length) throw new BehavioralSignalError("INTEGRITY_FAILURE", "session.eventReceipts contains duplicate event keys");
  const ordered = [...receipts].sort((a, b) => a.eventKey.localeCompare(b.eventKey, "en"));
  if (canonicalJson(ordered) !== canonicalJson(receipts)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "session.eventReceipts are not deterministically ordered");
  return Object.freeze(receipts);
}

function requiredString(record: ObjectRecord, key: string): string {
  const value = record.properties[key];
  if (typeof value !== "string" || !value) throw new BehavioralSignalError("INTEGRITY_FAILURE", `record ${record.id} has invalid ${key}`);
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

function parseKind(value: JsonValue | undefined, field: string): BehavioralSignalKind {
  if (typeof value !== "string" || !KINDS.includes(value as BehavioralSignalKind)) throw new BehavioralSignalError("INTEGRITY_FAILURE", `${field} invalid`);
  return value as BehavioralSignalKind;
}

function digestValue(value: JsonValue | undefined, field: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new BehavioralSignalError("INTEGRITY_FAILURE", `${field} invalid`);
  return value;
}

function sessionDigest(siteId: string, sessionKey: string, keyId: string, payload: SessionPayload, updatedAt: string): string {
  return hash("cortex-behavioral-session-record-v1", { siteId, sessionKey, keyId, payload, updatedAt });
}

function siteDigest(siteId: string, payload: SitePayload, updatedAt: string): string {
  return hash("cortex-behavioral-site-record-v1", { siteId, payload, updatedAt });
}

function sessionProperties(siteId: string, sessionKey: string, keyId: string, payload: SessionPayload, updatedAt: string): Record<string, JsonValue> {
  return {
    [SESSION.siteId]: siteId,
    [SESSION.sessionKey]: sessionKey,
    [SESSION.keyId]: keyId,
    [SESSION.payload]: json(payload, "session.payload"),
    [SESSION.digest]: sessionDigest(siteId, sessionKey, keyId, payload, updatedAt),
    [SESSION.updatedAt]: updatedAt,
  };
}

function siteProperties(siteId: string, payload: SitePayload, updatedAt: string): Record<string, JsonValue> {
  return {
    [SITE.siteId]: siteId,
    [SITE.payload]: json(payload, "site.payload"),
    [SITE.digest]: siteDigest(siteId, payload, updatedAt),
    [SITE.updatedAt]: updatedAt,
  };
}

function parseSession(record: ObjectRecord): SessionRecord {
  if (record.typeId !== SESSION_TYPE) throw new BehavioralSignalError("INTEGRITY_FAILURE", "session type mismatch");
  const siteId = storedIdentifier(requiredString(record, SESSION.siteId), "stored session.siteId");
  const sessionKey = requiredString(record, SESSION.sessionKey);
  if (!HMAC256.test(sessionKey)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "stored session key invalid");
  const keyId = storedIdentifier(requiredString(record, SESSION.keyId), "stored session.keyId");
  const raw = object(record.properties[SESSION.payload], "session.payload");
  exactStoredKeys(raw as unknown as Record<string, unknown>, SESSION_PAYLOAD_KEYS, "session.payload");
  const firstEventAt = storedUtc(String(raw.firstEventAt), "session.firstEventAt");
  const lastEventAt = storedUtc(String(raw.lastEventAt), "session.lastEventAt");
  if (Date.parse(firstEventAt) > Date.parse(lastEventAt)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "session event range invalid");
  const eventReceipts = parseReceipts(raw.eventReceipts);
  if (eventReceipts.length === 0) throw new BehavioralSignalError("INTEGRITY_FAILURE", "session must contain at least one event receipt");
  const counts = parseCounters(raw.counts, "session.counts");
  if (eventReceipts.length !== KINDS.reduce((total, kind) => total + counts[kind], 0)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "session receipt/count mismatch");
  const totalEngagementMs = safeCount(raw.totalEngagementMs, "session.totalEngagementMs");
  const maxScrollDepthPercent = safeCount(raw.maxScrollDepthPercent, "session.maxScrollDepthPercent");
  if (maxScrollDepthPercent > 100) throw new BehavioralSignalError("INTEGRITY_FAILURE", "session.maxScrollDepthPercent exceeds 100");
  if (typeof raw.lastSurfaceId !== "string") throw new BehavioralSignalError("INTEGRITY_FAILURE", "session.lastSurfaceId invalid");
  const lastSurfaceId = storedIdentifier(raw.lastSurfaceId, "session.lastSurfaceId");
  const lastEventKind = parseKind(raw.lastEventKind, "session.lastEventKind");
  const lastEventDigest = digestValue(raw.lastEventDigest, "session.lastEventDigest");
  const lastPolicyDigest = digestValue(raw.lastPolicyDigest, "session.lastPolicyDigest");
  const payload: SessionPayload = { firstEventAt, lastEventAt, eventReceipts, counts, totalEngagementMs, maxScrollDepthPercent, lastSurfaceId, lastEventKind, lastEventDigest, lastPolicyDigest };
  const updatedAt = storedUtc(requiredString(record, SESSION.updatedAt), "session.updatedAt");
  const digest = requiredString(record, SESSION.digest);
  if (digest !== sessionDigest(siteId, sessionKey, keyId, payload, updatedAt)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "session digest mismatch");
  return Object.freeze({ id: record.id, siteId, sessionKey, keyId, ...payload, digest, updatedAt, revision: record.revision });
}

function parseSite(record: ObjectRecord): SiteRecord {
  if (record.typeId !== SITE_TYPE) throw new BehavioralSignalError("INTEGRITY_FAILURE", "site type mismatch");
  const siteId = storedIdentifier(requiredString(record, SITE.siteId), "stored site.siteId");
  const raw = object(record.properties[SITE.payload], "site.payload");
  exactStoredKeys(raw as unknown as Record<string, unknown>, SITE_PAYLOAD_KEYS, "site.payload");
  const firstEventAt = storedUtc(String(raw.firstEventAt), "site.firstEventAt");
  const lastEventAt = storedUtc(String(raw.lastEventAt), "site.lastEventAt");
  if (Date.parse(firstEventAt) > Date.parse(lastEventAt)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "site event range invalid");
  const eventCount = safeCount(raw.eventCount, "site.eventCount");
  const sessionCount = safeCount(raw.sessionCount, "site.sessionCount");
  if (eventCount === 0 || sessionCount === 0 || sessionCount > eventCount) throw new BehavioralSignalError("INTEGRITY_FAILURE", "site aggregate counts are inconsistent");
  const counts = parseCounters(raw.counts, "site.counts");
  if (eventCount !== KINDS.reduce((total, kind) => total + counts[kind], 0)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "site event/count mismatch");
  const totalEngagementMs = safeCount(raw.totalEngagementMs, "site.totalEngagementMs");
  const maxScrollDepthPercent = safeCount(raw.maxScrollDepthPercent, "site.maxScrollDepthPercent");
  if (maxScrollDepthPercent > 100) throw new BehavioralSignalError("INTEGRITY_FAILURE", "site.maxScrollDepthPercent exceeds 100");
  if (typeof raw.lastSurfaceId !== "string") throw new BehavioralSignalError("INTEGRITY_FAILURE", "site.lastSurfaceId invalid");
  const lastSurfaceId = storedIdentifier(raw.lastSurfaceId, "site.lastSurfaceId");
  const lastEventKind = parseKind(raw.lastEventKind, "site.lastEventKind");
  const lastEventDigest = digestValue(raw.lastEventDigest, "site.lastEventDigest");
  const lastPolicyDigest = digestValue(raw.lastPolicyDigest, "site.lastPolicyDigest");
  const payload: SitePayload = { firstEventAt, lastEventAt, eventCount, sessionCount, counts, totalEngagementMs, maxScrollDepthPercent, lastSurfaceId, lastEventKind, lastEventDigest, lastPolicyDigest };
  const updatedAt = storedUtc(requiredString(record, SITE.updatedAt), "site.updatedAt");
  const digest = requiredString(record, SITE.digest);
  if (digest !== siteDigest(siteId, payload, updatedAt)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "site digest mismatch");
  return Object.freeze({ id: record.id, siteId, ...payload, digest, updatedAt, revision: record.revision });
}

function sessionSnapshot(record: SessionRecord): BehavioralSessionSnapshot {
  return Object.freeze({
    siteId: record.siteId,
    sessionKey: record.sessionKey,
    keyId: record.keyId,
    firstEventAt: record.firstEventAt,
    lastEventAt: record.lastEventAt,
    eventCount: record.eventReceipts.length,
    counts: record.counts,
    totalEngagementMs: record.totalEngagementMs,
    maxScrollDepthPercent: record.maxScrollDepthPercent,
    lastSurfaceId: record.lastSurfaceId,
    lastEventKind: record.lastEventKind,
    lastEventDigest: record.lastEventDigest,
    lastPolicyDigest: record.lastPolicyDigest,
    digest: record.digest,
  });
}

function siteSnapshot(record: SiteRecord): BehavioralSiteSnapshot {
  return Object.freeze({
    siteId: record.siteId,
    firstEventAt: record.firstEventAt,
    lastEventAt: record.lastEventAt,
    eventCount: record.eventCount,
    sessionCount: record.sessionCount,
    counts: record.counts,
    totalEngagementMs: record.totalEngagementMs,
    maxScrollDepthPercent: record.maxScrollDepthPercent,
    lastSurfaceId: record.lastSurfaceId,
    lastEventKind: record.lastEventKind,
    lastEventDigest: record.lastEventDigest,
    lastPolicyDigest: record.lastPolicyDigest,
    digest: record.digest,
  });
}

function eventIsLater(occurredAt: string, contentDigest: string, currentAt: string, currentDigest: string): boolean {
  const left = Date.parse(occurredAt);
  const right = Date.parse(currentAt);
  return left > right || (left === right && contentDigest.localeCompare(currentDigest, "en") > 0);
}

function minIso(left: string, right: string): string {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function maxIso(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function conflict(error: unknown): boolean {
  return error instanceof OntologyTransactionError && error.code === "CONFLICT";
}

function effectiveMode(policyMode: BehavioralSignalMode, requested: BehavioralSignalMode | undefined): BehavioralSignalMode {
  const mode = requested ?? policyMode;
  if (!MODES.includes(mode)) throw new BehavioralSignalError("INVALID_INPUT", "mode invalid");
  const rank: Record<BehavioralSignalMode, number> = { ACTIVE: 0, OBSERVE_ONLY: 1, KILLED: 2 };
  return rank[mode] > rank[policyMode] ? mode : policyMode;
}

export function createBehavioralSignalPolicy(input: CreateBehavioralSignalPolicyInput): BehavioralSignalPolicy {
  const policyId = identifier(input.policyId, "policyId");
  const version = identifier(input.version, "version");
  const pseudonymizationKeyId = identifier(input.pseudonymizationKeyId, "pseudonymizationKeyId");
  if (!Array.isArray(input.allowedSurfaceIds) || input.allowedSurfaceIds.length === 0 || input.allowedSurfaceIds.length > HARD_MAX_SURFACES) throw new BehavioralSignalError("INVALID_INPUT", `allowedSurfaceIds must contain 1..${HARD_MAX_SURFACES} items`);
  const allowedSurfaceIds = Object.freeze([...input.allowedSurfaceIds].map((value, index) => identifier(value, `allowedSurfaceIds[${index}]`)).sort((a, b) => a.localeCompare(b, "en")));
  if (new Set(allowedSurfaceIds).size !== allowedSurfaceIds.length) throw new BehavioralSignalError("INVALID_INPUT", "allowedSurfaceIds must be unique");
  const rawElements = input.allowedElementIds ?? [];
  if (!Array.isArray(rawElements) || rawElements.length > HARD_MAX_ELEMENTS) throw new BehavioralSignalError("INVALID_INPUT", `allowedElementIds may contain at most ${HARD_MAX_ELEMENTS} items`);
  const allowedElementIds = Object.freeze([...rawElements].map((value, index) => identifier(value, `allowedElementIds[${index}]`)).sort((a, b) => a.localeCompare(b, "en")));
  if (new Set(allowedElementIds).size !== allowedElementIds.length) throw new BehavioralSignalError("INVALID_INPUT", "allowedElementIds must be unique");
  const maxEventAgeMs = positiveInt(input.maxEventAgeMs, "maxEventAgeMs", 30 * 24 * 60 * 60 * 1_000);
  const maxFutureSkewMs = nonNegativeInt(input.maxFutureSkewMs, "maxFutureSkewMs", 5 * 60 * 1_000);
  const maxSessionDurationMs = positiveInt(input.maxSessionDurationMs, "maxSessionDurationMs", 7 * 24 * 60 * 60 * 1_000);
  const maxEventsPerSession = positiveInt(input.maxEventsPerSession, "maxEventsPerSession", HARD_MAX_EVENTS_PER_SESSION);
  const maxEngagementMsPerEvent = positiveInt(input.maxEngagementMsPerEvent, "maxEngagementMsPerEvent", 60 * 60 * 1_000);
  const maxWriteRetries = input.maxWriteRetries ?? 3;
  if (!Number.isSafeInteger(maxWriteRetries) || maxWriteRetries < 0 || maxWriteRetries > 10) throw new BehavioralSignalError("INVALID_INPUT", "maxWriteRetries must be 0..10");
  const mode = input.mode ?? "ACTIVE";
  if (!MODES.includes(mode)) throw new BehavioralSignalError("INVALID_INPUT", "mode invalid");
  const core = { policyId, version, pseudonymizationKeyId, allowedSurfaceIds, allowedElementIds, maxEventAgeMs, maxFutureSkewMs, maxSessionDurationMs, maxEventsPerSession, maxEngagementMsPerEvent, maxWriteRetries, mode };
  return Object.freeze({ ...core, digest: hash("cortex-behavioral-signal-policy-v1", core) });
}

export class BehavioralSignalTrackingEngine {
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
    private readonly onTelemetry?: (event: BehavioralSignalTelemetryEvent) => void,
    private readonly onTelemetryError?: (error: unknown, event: BehavioralSignalTelemetryEvent) => void,
  ) {
    this.schema = schema(scope);
    this.privacyKey = typeof privacy.pseudonymizationKey === "string" ? Buffer.from(privacy.pseudonymizationKey, "utf8") : Buffer.from(privacy.pseudonymizationKey);
    if (this.privacyKey.byteLength < 32 || this.privacyKey.byteLength > 4_096) throw new BehavioralSignalError("INVALID_INPUT", "pseudonymizationKey must contain 32..4096 bytes");
    this.allowedSurfaces = new Set(policy.allowedSurfaceIds);
    this.allowedElements = new Set(policy.allowedElementIds);
  }

  private clock(): { readonly ms: number; readonly iso: string } {
    const ms = this.now();
    if (!Number.isFinite(ms)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "engine clock invalid");
    return Object.freeze({ ms, iso: new Date(ms).toISOString() });
  }

  private pseudonym(namespace: string, siteId: string, value: string): string {
    const digest = createHmac("sha256", this.privacyKey).update(`${this.policy.pseudonymizationKeyId}\n${namespace}\n${siteId}\n${value}`, "utf8").digest("hex");
    return `hmac-sha256:${digest}`;
  }

  private sessionObjectId(siteId: string, sessionKey: string): string {
    return ontologyId("cortex-behavioral-session-v1", { scope: this.scope, siteId, sessionKey });
  }

  private siteObjectId(siteId: string): string {
    return ontologyId("cortex-behavioral-site-v1", { scope: this.scope, siteId });
  }

  private readSession(siteId: string, sessionKey: string): SessionRecord | undefined {
    const raw = this.transactions.getObject(this.scope, this.sessionObjectId(siteId, sessionKey));
    return raw ? parseSession(raw) : undefined;
  }

  private readSite(siteId: string): SiteRecord | undefined {
    const raw = this.transactions.getObject(this.scope, this.siteObjectId(siteId));
    return raw ? parseSite(raw) : undefined;
  }

  private emit(event: BehavioralSignalTelemetryEvent): void {
    if (!this.onTelemetry) return;
    try {
      this.onTelemetry(event);
    } catch (error) {
      try {
        this.onTelemetryError?.(error, event);
      } catch {
        // telemetry must never change ingestion semantics
      }
    }
  }

  private result(
    status: BehavioralSignalStatus,
    reason: BehavioralSignalReason,
    mode: BehavioralSignalMode,
    siteId: string,
    eventDigest: string | null,
    session: SessionRecord | null,
    site: SiteRecord | null,
    kind: BehavioralSignalKind | null,
    surfaceId: string | null,
  ): BehavioralSignalIngestResult {
    const value = Object.freeze({
      status,
      reason,
      mode,
      siteId,
      eventDigest,
      session: session ? sessionSnapshot(session) : null,
      site: site ? siteSnapshot(site) : null,
      policyDigest: this.policy.digest,
    });
    this.emit(Object.freeze({ status, reason, mode, siteId, kind, surfaceId, eventDigest }));
    return value;
  }

  private normalizeAllowedEvent(input: BehavioralSignalEventInput, siteId: string, nowMs: number): NormalizedEvent {
    const eventId = opaqueId(input.eventId, "eventId");
    const sessionId = opaqueId(input.sessionId, "sessionId");
    const kind = input.kind;
    if (!KINDS.includes(kind)) throw new BehavioralSignalError("INVALID_INPUT", "kind invalid");
    const occurredAt = utc(input.occurredAt, "occurredAt");
    const occurredMs = Date.parse(occurredAt);
    if (occurredMs > nowMs + this.policy.maxFutureSkewMs) throw new BehavioralSignalError("POLICY_VIOLATION", "event occurs too far in the future");
    if (nowMs - occurredMs > this.policy.maxEventAgeMs) throw new BehavioralSignalError("POLICY_VIOLATION", "event is older than maxEventAgeMs");
    const surfaceId = identifier(input.surfaceId, "surfaceId");
    const elementId = input.elementId === undefined || input.elementId === null ? null : identifier(input.elementId, "elementId");
    const engagementMs = boundedOptionalInt(input.engagementMs, "engagementMs", 1, this.policy.maxEngagementMsPerEvent);
    const scrollDepthPercent = boundedOptionalInt(input.scrollDepthPercent, "scrollDepthPercent", 0, 100);
    if (kind === "ENGAGEMENT" ? engagementMs === null : engagementMs !== null) throw new BehavioralSignalError("INVALID_INPUT", "engagementMs is required only for ENGAGEMENT");
    if (kind === "SCROLL_DEPTH" ? scrollDepthPercent === null : scrollDepthPercent !== null) throw new BehavioralSignalError("INVALID_INPUT", "scrollDepthPercent is required only for SCROLL_DEPTH");
    if (ELEMENT_KINDS.has(kind) ? elementId === null : elementId !== null) throw new BehavioralSignalError("INVALID_INPUT", "elementId is required only for CTA/form signals");
    if (typeof input.privacyDecisionRef !== "string" || !input.privacyDecisionRef.trim()) throw new BehavioralSignalError("INVALID_INPUT", "privacyDecisionRef is required when collectionAllowed=true");
    const privacyDecisionRef = identifier(input.privacyDecisionRef, "privacyDecisionRef");
    const eventKey = this.pseudonym("event", siteId, `${sessionId}\n${eventId}`);
    const sessionKey = this.pseudonym("session", siteId, sessionId);
    const privacyDecisionDigest = this.pseudonym("privacy-decision", siteId, privacyDecisionRef);
    const contentCore = { eventKey, sessionKey, siteId, kind, occurredAt, surfaceId, elementId, engagementMs, scrollDepthPercent, privacyDecisionDigest };
    return Object.freeze({ ...contentCore, contentDigest: hash("cortex-behavioral-event-content-v1", contentCore) });
  }

  private enforceAllowlist(event: NormalizedEvent): void {
    if (!this.allowedSurfaces.has(event.surfaceId)) throw new BehavioralSignalError("POLICY_VIOLATION", `surfaceId ${event.surfaceId} is not allowlisted`);
    if (event.elementId !== null && !this.allowedElements.has(event.elementId)) throw new BehavioralSignalError("POLICY_VIOLATION", `elementId ${event.elementId} is not allowlisted`);
  }

  private nextSession(current: SessionRecord | undefined, event: NormalizedEvent): SessionPayload {
    const existingReceipt = current?.eventReceipts.find((receipt) => receipt.eventKey === event.eventKey);
    if (existingReceipt) throw new BehavioralSignalError("INTEGRITY_FAILURE", "duplicate event reached mutation path");
    if (current && current.eventReceipts.length >= this.policy.maxEventsPerSession) throw new BehavioralSignalError("POLICY_VIOLATION", "session exceeded maxEventsPerSession");
    const firstEventAt = current ? minIso(current.firstEventAt, event.occurredAt) : event.occurredAt;
    const lastEventAt = current ? maxIso(current.lastEventAt, event.occurredAt) : event.occurredAt;
    if (Date.parse(lastEventAt) - Date.parse(firstEventAt) > this.policy.maxSessionDurationMs) throw new BehavioralSignalError("POLICY_VIOLATION", "session exceeded maxSessionDurationMs");
    const eventReceipts = Object.freeze([...(current?.eventReceipts ?? []), Object.freeze({ eventKey: event.eventKey, contentDigest: event.contentDigest })].sort((a, b) => a.eventKey.localeCompare(b.eventKey, "en")));
    const counts = incrementCounters(current?.counts ?? initialCounters(), event.kind);
    const totalEngagementMs = safeAdd(current?.totalEngagementMs ?? 0, event.engagementMs ?? 0, "session.totalEngagementMs");
    const maxScrollDepthPercent = Math.max(current?.maxScrollDepthPercent ?? 0, event.scrollDepthPercent ?? 0);
    const later = !current || eventIsLater(event.occurredAt, event.contentDigest, current.lastEventAt, current.lastEventDigest);
    return Object.freeze({
      firstEventAt,
      lastEventAt,
      eventReceipts,
      counts,
      totalEngagementMs,
      maxScrollDepthPercent,
      lastSurfaceId: later ? event.surfaceId : current.lastSurfaceId,
      lastEventKind: later ? event.kind : current.lastEventKind,
      lastEventDigest: later ? event.contentDigest : current.lastEventDigest,
      lastPolicyDigest: this.policy.digest,
    });
  }

  private nextSite(current: SiteRecord | undefined, event: NormalizedEvent, newSession: boolean): SitePayload {
    const firstEventAt = current ? minIso(current.firstEventAt, event.occurredAt) : event.occurredAt;
    const lastEventAt = current ? maxIso(current.lastEventAt, event.occurredAt) : event.occurredAt;
    const eventCount = safeAdd(current?.eventCount ?? 0, 1, "site.eventCount");
    const sessionCount = safeAdd(current?.sessionCount ?? 0, newSession ? 1 : 0, "site.sessionCount");
    const counts = incrementCounters(current?.counts ?? initialCounters(), event.kind);
    const totalEngagementMs = safeAdd(current?.totalEngagementMs ?? 0, event.engagementMs ?? 0, "site.totalEngagementMs");
    const maxScrollDepthPercent = Math.max(current?.maxScrollDepthPercent ?? 0, event.scrollDepthPercent ?? 0);
    const later = !current || eventIsLater(event.occurredAt, event.contentDigest, current.lastEventAt, current.lastEventDigest);
    return Object.freeze({
      firstEventAt,
      lastEventAt,
      eventCount,
      sessionCount,
      counts,
      totalEngagementMs,
      maxScrollDepthPercent,
      lastSurfaceId: later ? event.surfaceId : current.lastSurfaceId,
      lastEventKind: later ? event.kind : current.lastEventKind,
      lastEventDigest: later ? event.contentDigest : current.lastEventDigest,
      lastPolicyDigest: this.policy.digest,
    });
  }

  ingest(input: BehavioralSignalEventInput): BehavioralSignalIngestResult {
    exactKeys(input as unknown as Record<string, unknown>, EVENT_KEYS, "event");
    const siteId = identifier(input.siteId, "siteId");
    if (typeof input.collectionAllowed !== "boolean") throw new BehavioralSignalError("INVALID_INPUT", "collectionAllowed must be boolean");
    const mode = effectiveMode(this.policy.mode, input.mode);
    if (mode === "KILLED") return this.result("NOOP", "KILL_SWITCH", mode, siteId, null, null, null, null, null);
    if (!input.collectionAllowed) return this.result("NOOP", "PRIVACY_DENIED", mode, siteId, null, null, null, null, null);

    const now = this.clock();
    const event = this.normalizeAllowedEvent(input, siteId, now.ms);
    if (mode === "OBSERVE_ONLY") {
      this.enforceAllowlist(event);
      return this.result("OBSERVED", "OBSERVE_ONLY", mode, siteId, event.contentDigest, null, null, event.kind, event.surfaceId);
    }

    for (let attempt = 0; attempt <= this.policy.maxWriteRetries; attempt += 1) {
      const session = this.readSession(siteId, event.sessionKey);
      const site = this.readSite(siteId);
      if (session && !site) throw new BehavioralSignalError("INTEGRITY_FAILURE", "session exists without site aggregate");
      if (session) {
        const receipt = session.eventReceipts.find((item) => item.eventKey === event.eventKey);
        if (receipt) {
          if (receipt.contentDigest !== event.contentDigest) throw new BehavioralSignalError("CONFLICT", "eventId replayed with different content");
          if (!site) throw new BehavioralSignalError("INTEGRITY_FAILURE", "duplicate event has no site aggregate");
          return this.result("DUPLICATE", "DUPLICATE", mode, siteId, event.contentDigest, session, site, event.kind, event.surfaceId);
        }
      }

      this.enforceAllowlist(event);
      const sessionPayload = this.nextSession(session, event);
      const sitePayload = this.nextSite(site, event, !session);
      const operations: TransactionOperation[] = [
        session
          ? { kind: "UPDATE_OBJECT", id: session.id, expectedRevision: session.revision, properties: sessionProperties(siteId, event.sessionKey, this.policy.pseudonymizationKeyId, sessionPayload, now.iso) }
          : { kind: "CREATE_OBJECT", record: { id: this.sessionObjectId(siteId, event.sessionKey), typeId: SESSION_TYPE, scope: this.scope, properties: sessionProperties(siteId, event.sessionKey, this.policy.pseudonymizationKeyId, sessionPayload, now.iso) } },
        site
          ? { kind: "UPDATE_OBJECT", id: site.id, expectedRevision: site.revision, properties: siteProperties(siteId, sitePayload, now.iso) }
          : { kind: "CREATE_OBJECT", record: { id: this.siteObjectId(siteId), typeId: SITE_TYPE, scope: this.scope, properties: siteProperties(siteId, sitePayload, now.iso) } },
      ];

      try {
        this.transactions.transact(this.scope, this.schema, operations);
        const storedSession = this.readSession(siteId, event.sessionKey);
        const storedSite = this.readSite(siteId);
        if (!storedSession || !storedSite) throw new BehavioralSignalError("PERSISTENCE_FAILURE", "committed behavioral state is unreadable");
        return this.result("RECORDED", "RECORDED", mode, siteId, event.contentDigest, storedSession, storedSite, event.kind, event.surfaceId);
      } catch (error) {
        if (conflict(error) && attempt < this.policy.maxWriteRetries) continue;
        if (conflict(error)) throw new BehavioralSignalError("CONFLICT", "behavioral signal write conflicted");
        if (error instanceof BehavioralSignalError) throw error;
        throw new BehavioralSignalError("PERSISTENCE_FAILURE", error instanceof Error ? error.message : "behavioral signal write failed");
      }
    }

    throw new BehavioralSignalError("CONFLICT", "behavioral signal write exhausted retries");
  }

  getSessionSnapshot(siteIdInput: string, sessionIdInput: string): BehavioralSessionSnapshot | null {
    const siteId = identifier(siteIdInput, "siteId");
    const sessionId = opaqueId(sessionIdInput, "sessionId");
    const sessionKey = this.pseudonym("session", siteId, sessionId);
    const record = this.readSession(siteId, sessionKey);
    return record ? sessionSnapshot(record) : null;
  }

  getSiteSnapshot(siteIdInput: string): BehavioralSiteSnapshot | null {
    const siteId = identifier(siteIdInput, "siteId");
    const record = this.readSite(siteId);
    return record ? siteSnapshot(record) : null;
  }
}
