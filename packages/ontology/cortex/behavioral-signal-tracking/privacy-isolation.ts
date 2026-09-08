import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalJson, ontologyId, validateSchema, type OntologyScope, type SchemaVersion, type ValidatedSchema } from "@nexus/ontology";
import { OntologyTransactionError, type JsonValue, type ObjectRecord, type OntologyTransactionPort, type TransactionOperation, type TransactionResult } from "@nexus/ontology/transaction";
import { BehavioralSignalError, type BehavioralSignalEventInput, type BehavioralSignalIngestResult } from "./index";
import type { BehavioralMicroInteractionInput, BehavioralMicroInteractionResult } from "./browser-micro-signals";
import type { CortexBehavioralSignalRuntime } from "./runtime";

const ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const OPAQUE = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{7,255})$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const HMAC256 = /^hmac-sha256:[0-9a-f]{64}$/u;
const SESSION_REF = /^session:[0-9a-f]{64}$/u;
const BASE_KEYS = new Set(["eventId", "sessionToken", "siteId", "kind", "occurredAt", "surfaceId", "elementId", "engagementMs", "scrollDepthPercent", "mode"]);
const MICRO_KEYS = new Set(["eventId", "sessionToken", "siteId", "kind", "occurredAt", "surfaceId", "elementId", "durationMs", "mode"]);
const BASE_SESSION_TYPE = "cortex.behavioral_signal_session";
const MICRO_SESSION_TYPE = "cortex.behavioral_micro_signal_session";
const KEY_CONTROL_TYPE = "cortex.behavioral_privacy_key_control";
const RETENTION_TYPE = "cortex.behavioral_privacy_retention_index";
const KEY_CONTROL = Object.freeze({
  payload: "cortex.behavioral_privacy.key_control.payload",
  digest: "cortex.behavioral_privacy.key_control.digest",
  updatedAt: "cortex.behavioral_privacy.key_control.updated_at",
});
const RETENTION = Object.freeze({
  siteId: "cortex.behavioral_privacy.retention.site_id",
  payload: "cortex.behavioral_privacy.retention.payload",
  digest: "cortex.behavioral_privacy.retention.digest",
  updatedAt: "cortex.behavioral_privacy.retention.updated_at",
});

export interface CreatePrivacyIsolationPolicyInput {
  readonly version: 1;
  readonly sessionTtlMs: number;
  readonly aggregateRetentionMs: number;
  readonly retentionSweepIntervalMs: number;
  readonly maxTrackedSessionsPerSite: number;
  readonly maxActiveKeyAgeMs: number;
  readonly allowedSiteIds: readonly string[];
}

export interface PrivacyIsolationPolicy extends CreatePrivacyIsolationPolicyInput {
  readonly allowedSiteIds: readonly string[];
  readonly digest: string;
}

export interface PrivacyIsolationKeyMaterial {
  readonly keyId: string;
  readonly key: string | Uint8Array;
}

export interface PrivacyIsolationKeyRingConfig {
  readonly version: 1;
  readonly bootstrapActiveKeyId: string;
  readonly keys: readonly PrivacyIsolationKeyMaterial[];
}

interface SessionTokenPayload {
  readonly version: 1;
  readonly keyId: string;
  readonly siteId: string;
  readonly nonce: string;
  readonly privacyDecisionDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

interface KeyEpoch {
  readonly keyId: string;
  readonly verifier: string;
  readonly activatedAt: string;
  readonly deactivatedAt: string | null;
}

interface KeyControlPayload {
  readonly version: 1;
  readonly policyDigest: string;
  readonly generation: number;
  readonly active: KeyEpoch;
  readonly previous: readonly KeyEpoch[];
}

interface KeyControlRecord extends KeyControlPayload {
  readonly id: string;
  readonly digest: string;
  readonly updatedAt: string;
  readonly revision: number;
}

export interface PrivacyIsolationKeyControlState {
  readonly generation: number;
  readonly digest: string;
  readonly activeKeyId: string;
  readonly activeActivatedAt: string;
  readonly previous: readonly Readonly<{ keyId: string; deactivatedAt: string; verificationUntil: string }>[];
}

interface RetentionSessionEntry {
  readonly sessionRef: string;
  readonly baseObjectId: string | null;
  readonly microObjectId: string | null;
}

interface RetentionPayload {
  readonly version: 1;
  readonly policyDigest: string;
  readonly windowStartedAt: string;
  readonly purgeAt: string;
  readonly sessions: readonly RetentionSessionEntry[];
}

interface RetentionRecord extends RetentionPayload {
  readonly id: string;
  readonly siteId: string;
  readonly digest: string;
  readonly updatedAt: string;
  readonly revision: number;
}

interface RetentionContext {
  readonly channel: "BASE" | "MICRO";
  readonly siteId: string;
  readonly sessionRef: string;
}

export type PrivacyIsolatedBehavioralEventInput = Omit<BehavioralSignalEventInput, "sessionId" | "privacyDecisionRef" | "collectionAllowed"> & {
  readonly sessionToken: string;
};

export type PrivacyIsolatedMicroInteractionInput = Omit<BehavioralMicroInteractionInput, "sessionId" | "privacyDecisionRef" | "collectionAllowed"> & {
  readonly sessionToken: string;
};

function hash(namespace: string, value: unknown): string {
  return `sha256:${createHash("sha256").update(`${namespace}\n${canonicalJson(value)}`, "utf8").digest("hex")}`;
}

function keyBytes(value: string | Uint8Array, field: string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  if (bytes.byteLength < 32 || bytes.byteLength > 4_096) throw new BehavioralSignalError("INVALID_INPUT", `${field} must contain 32..4096 bytes`);
  return bytes;
}

function identifier(value: string, field: string): string {
  if (typeof value !== "string") throw new BehavioralSignalError("INVALID_INPUT", `${field} must be a string`);
  const normalized = value.trim();
  if (!ID.test(normalized)) throw new BehavioralSignalError("INVALID_INPUT", `${field} is malformed`);
  return normalized;
}

function opaque(value: string, field: string): string {
  if (typeof value !== "string") throw new BehavioralSignalError("INVALID_INPUT", `${field} must be a string`);
  const normalized = value.trim();
  if (!OPAQUE.test(normalized)) throw new BehavioralSignalError("INVALID_INPUT", `${field} is malformed`);
  return normalized;
}

function canonicalUtc(value: string, field: string, code: "INVALID_INPUT" | "INTEGRITY_FAILURE" = "INVALID_INPUT"): number {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new BehavioralSignalError(code, `${field} must be canonical UTC`);
  return parsed.getTime();
}

function safeNow(now: () => number): number {
  const value = now();
  if (!Number.isFinite(value)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "privacy isolation clock is invalid");
  return value;
}

function exactKeys(value: object, allowed: ReadonlySet<string>, label: string, code: "INVALID_INPUT" | "INTEGRITY_FAILURE" = "INVALID_INPUT"): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new BehavioralSignalError(code, `${label} contains unsupported field ${key}`);
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

function privacySchema(scope: OntologyScope): ValidatedSchema {
  const value: SchemaVersion = {
    version: "cortex-behavioral-privacy-isolation-v1",
    scope,
    properties: [
      property(KEY_CONTROL.payload, "BehavioralPrivacyKeyControlPayload", "JSON"),
      property(KEY_CONTROL.digest, "BehavioralPrivacyKeyControlDigest", "STRING"),
      property(KEY_CONTROL.updatedAt, "BehavioralPrivacyKeyControlUpdatedAt", "DATETIME"),
      property(RETENTION.siteId, "BehavioralPrivacyRetentionSiteId", "STRING", true),
      property(RETENTION.payload, "BehavioralPrivacyRetentionPayload", "JSON"),
      property(RETENTION.digest, "BehavioralPrivacyRetentionDigest", "STRING"),
      property(RETENTION.updatedAt, "BehavioralPrivacyRetentionUpdatedAt", "DATETIME"),
    ],
    interfaces: [],
    objects: [
      { id: KEY_CONTROL_TYPE, name: "CortexBehavioralPrivacyKeyControl", propertyIds: Object.values(KEY_CONTROL), interfaceIds: [] },
      { id: RETENTION_TYPE, name: "CortexBehavioralPrivacyRetentionIndex", propertyIds: Object.values(RETENTION), interfaceIds: [] },
    ],
    relationships: [],
    actions: [],
    functions: [],
    events: [],
  };
  return validateSchema(value);
}

function combineSchemas(base: ValidatedSchema, privacy: ValidatedSchema): ValidatedSchema {
  const value: SchemaVersion = {
    version: `privacy-${base.version}`.slice(0, 120),
    scope: base.scope,
    properties: [...base.properties, ...privacy.properties],
    interfaces: [...base.interfaces, ...privacy.interfaces],
    objects: [...base.objects, ...privacy.objects],
    relationships: [...base.relationships, ...privacy.relationships],
    actions: [...base.actions, ...privacy.actions],
    functions: [...base.functions, ...privacy.functions],
    events: [...base.events, ...privacy.events],
  };
  return validateSchema(value);
}

export function createPrivacyIsolationPolicy(input: CreatePrivacyIsolationPolicyInput): PrivacyIsolationPolicy {
  if (input.version !== 1) throw new BehavioralSignalError("INVALID_INPUT", "privacy isolation policy version must be 1");
  if (!Number.isSafeInteger(input.sessionTtlMs) || input.sessionTtlMs < 60_000 || input.sessionTtlMs > 4 * 60 * 60 * 1000) throw new BehavioralSignalError("INVALID_INPUT", "sessionTtlMs must be 60000..14400000");
  if (!Number.isSafeInteger(input.aggregateRetentionMs) || input.aggregateRetentionMs < input.sessionTtlMs || input.aggregateRetentionMs > 30 * 24 * 60 * 60 * 1000) throw new BehavioralSignalError("INVALID_INPUT", "aggregateRetentionMs must be >= sessionTtlMs and <= 2592000000");
  if (!Number.isSafeInteger(input.retentionSweepIntervalMs) || input.retentionSweepIntervalMs < 10_000 || input.retentionSweepIntervalMs > 15 * 60_000 || input.retentionSweepIntervalMs > input.aggregateRetentionMs) throw new BehavioralSignalError("INVALID_INPUT", "retentionSweepIntervalMs must be 10000..900000 and <= aggregateRetentionMs");
  if (!Number.isSafeInteger(input.maxTrackedSessionsPerSite) || input.maxTrackedSessionsPerSite < 1 || input.maxTrackedSessionsPerSite > 4_096) throw new BehavioralSignalError("INVALID_INPUT", "maxTrackedSessionsPerSite must be 1..4096");
  if (!Number.isSafeInteger(input.maxActiveKeyAgeMs) || input.maxActiveKeyAgeMs < input.sessionTtlMs || input.maxActiveKeyAgeMs > 90 * 24 * 60 * 60 * 1000) throw new BehavioralSignalError("INVALID_INPUT", "maxActiveKeyAgeMs must be >= sessionTtlMs and <= 7776000000");
  if (!Array.isArray(input.allowedSiteIds) || input.allowedSiteIds.length < 1 || input.allowedSiteIds.length > 128) throw new BehavioralSignalError("INVALID_INPUT", "allowedSiteIds must contain 1..128 items");
  const allowedSiteIds = Object.freeze(input.allowedSiteIds.map((siteId) => identifier(siteId, "allowedSiteId")).sort((a, b) => a.localeCompare(b, "en")));
  if (new Set(allowedSiteIds).size !== allowedSiteIds.length) throw new BehavioralSignalError("INVALID_INPUT", "allowedSiteIds must be unique");
  const core = { version: 1 as const, sessionTtlMs: input.sessionTtlMs, aggregateRetentionMs: input.aggregateRetentionMs, retentionSweepIntervalMs: input.retentionSweepIntervalMs, maxTrackedSessionsPerSite: input.maxTrackedSessionsPerSite, maxActiveKeyAgeMs: input.maxActiveKeyAgeMs, allowedSiteIds };
  return Object.freeze({ ...core, digest: hash("cortex-behavioral-privacy-policy-v1", core) });
}

function buildKeyRing(config: PrivacyIsolationKeyRingConfig): { readonly bootstrapActiveKeyId: string; readonly keys: ReadonlyMap<string, Buffer> } {
  if (config.version !== 1) throw new BehavioralSignalError("INVALID_INPUT", "privacy keyring version must be 1");
  const bootstrapActiveKeyId = identifier(config.bootstrapActiveKeyId, "bootstrapActiveKeyId");
  if (!Array.isArray(config.keys) || config.keys.length < 1 || config.keys.length > 4) throw new BehavioralSignalError("INVALID_INPUT", "privacy keyring must contain 1..4 keys");
  const keys = new Map<string, Buffer>();
  const materialDigests = new Set<string>();
  for (const entry of config.keys) {
    const keyId = identifier(entry.keyId, "privacy keyId");
    if (keys.has(keyId)) throw new BehavioralSignalError("INVALID_INPUT", "privacy keyring keyIds must be unique");
    const key = keyBytes(entry.key, `privacy key ${keyId}`);
    const materialDigest = createHash("sha256").update(key).digest("hex");
    if (materialDigests.has(materialDigest)) throw new BehavioralSignalError("INVALID_INPUT", "privacy keyring key material must be distinct");
    materialDigests.add(materialDigest);
    keys.set(keyId, key);
  }
  if (!keys.has(bootstrapActiveKeyId)) throw new BehavioralSignalError("INVALID_INPUT", "bootstrapActiveKeyId is not present in privacy keyring");
  return Object.freeze({ bootstrapActiveKeyId, keys });
}

function keyVerifier(keyId: string, key: Buffer): string {
  return `hmac-sha256:${createHmac("sha256", key).update(`cortex-behavioral-privacy-key-verifier-v1\n${keyId}`, "utf8").digest("hex")}`;
}

function epochJson(epoch: KeyEpoch): JsonValue {
  return json({ keyId: epoch.keyId, verifier: epoch.verifier, activatedAt: epoch.activatedAt, deactivatedAt: epoch.deactivatedAt }, "privacy.keyEpoch");
}

function keyPayloadJson(payload: KeyControlPayload): JsonValue {
  return json({ version: 1, policyDigest: payload.policyDigest, generation: payload.generation, active: epochJson(payload.active), previous: payload.previous.map(epochJson) }, "privacy.keyControl.payload");
}

function keyControlDigest(payload: KeyControlPayload, updatedAt: string): string {
  return hash("cortex-behavioral-privacy-key-control-v1", { payload: keyPayloadJson(payload), updatedAt });
}

function keyControlProperties(payload: KeyControlPayload, updatedAt: string): Record<string, JsonValue> {
  return { [KEY_CONTROL.payload]: keyPayloadJson(payload), [KEY_CONTROL.digest]: keyControlDigest(payload, updatedAt), [KEY_CONTROL.updatedAt]: updatedAt };
}

function parseEpoch(value: JsonValue, field: string, active: boolean): KeyEpoch {
  const raw = object(value, field);
  exactKeys(raw as unknown as object, new Set(["keyId", "verifier", "activatedAt", "deactivatedAt"]), field, "INTEGRITY_FAILURE");
  if (typeof raw.keyId !== "string" || typeof raw.verifier !== "string" || typeof raw.activatedAt !== "string") throw new BehavioralSignalError("INTEGRITY_FAILURE", `${field} fields invalid`);
  const keyId = identifier(raw.keyId, `${field}.keyId`);
  if (!HMAC256.test(raw.verifier)) throw new BehavioralSignalError("INTEGRITY_FAILURE", `${field}.verifier invalid`);
  canonicalUtc(raw.activatedAt, `${field}.activatedAt`, "INTEGRITY_FAILURE");
  if (active) {
    if (raw.deactivatedAt !== null) throw new BehavioralSignalError("INTEGRITY_FAILURE", `${field}.deactivatedAt must be null`);
  } else {
    if (typeof raw.deactivatedAt !== "string") throw new BehavioralSignalError("INTEGRITY_FAILURE", `${field}.deactivatedAt invalid`);
    if (canonicalUtc(raw.deactivatedAt, `${field}.deactivatedAt`, "INTEGRITY_FAILURE") < canonicalUtc(raw.activatedAt, `${field}.activatedAt`, "INTEGRITY_FAILURE")) throw new BehavioralSignalError("INTEGRITY_FAILURE", `${field} deactivation precedes activation`);
  }
  return Object.freeze({ keyId, verifier: raw.verifier, activatedAt: raw.activatedAt, deactivatedAt: raw.deactivatedAt as string | null });
}

function parseKeyControl(record: ObjectRecord): KeyControlRecord {
  if (record.typeId !== KEY_CONTROL_TYPE) throw new BehavioralSignalError("INTEGRITY_FAILURE", "privacy key control type mismatch");
  exactKeys(record.properties as unknown as object, new Set(Object.values(KEY_CONTROL)), "privacy key control record", "INTEGRITY_FAILURE");
  const raw = object(record.properties[KEY_CONTROL.payload], "privacy key control payload");
  exactKeys(raw as unknown as object, new Set(["version", "policyDigest", "generation", "active", "previous"]), "privacy key control payload", "INTEGRITY_FAILURE");
  if (raw.version !== 1 || typeof raw.policyDigest !== "string" || !SHA256.test(raw.policyDigest)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "privacy key control policy binding invalid");
  if (typeof raw.generation !== "number" || !Number.isSafeInteger(raw.generation) || raw.generation < 1) throw new BehavioralSignalError("INTEGRITY_FAILURE", "privacy key control generation invalid");
  const active = parseEpoch(raw.active!, "privacy key control active", true);
  if (!Array.isArray(raw.previous) || raw.previous.length > 3) throw new BehavioralSignalError("INTEGRITY_FAILURE", "privacy key control previous epochs invalid");
  const previous = Object.freeze(raw.previous.map((item, index) => parseEpoch(item, `privacy key control previous[${index}]`, false)).sort((a, b) => a.keyId.localeCompare(b.keyId, "en")));
  const ids = [active.keyId, ...previous.map((item) => item.keyId)];
  if (new Set(ids).size !== ids.length) throw new BehavioralSignalError("INTEGRITY_FAILURE", "privacy key control contains duplicate keyIds");
  const updatedValue = record.properties[KEY_CONTROL.updatedAt];
  const digestValue = record.properties[KEY_CONTROL.digest];
  if (typeof updatedValue !== "string" || typeof digestValue !== "string" || !SHA256.test(digestValue)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "privacy key control metadata invalid");
  canonicalUtc(updatedValue, "privacy key control updatedAt", "INTEGRITY_FAILURE");
  const payload: KeyControlPayload = Object.freeze({ version: 1, policyDigest: raw.policyDigest, generation: raw.generation, active, previous });
  if (digestValue !== keyControlDigest(payload, updatedValue)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "privacy key control digest mismatch");
  return Object.freeze({ id: record.id, ...payload, digest: digestValue, updatedAt: updatedValue, revision: record.revision });
}

function conflict(error: unknown): boolean {
  return error instanceof OntologyTransactionError && error.code === "CONFLICT";
}

export class PrivacyIsolationKeyLifecycle {
  readonly policy: PrivacyIsolationPolicy;
  private readonly schema: ValidatedSchema;
  private readonly controlId: string;
  private readonly ring: ReadonlyMap<string, Buffer>;
  private readonly bootstrapActiveKeyId: string;

  constructor(
    private readonly transactions: OntologyTransactionPort,
    readonly scope: OntologyScope,
    policy: PrivacyIsolationPolicy,
    keyRingConfig: PrivacyIsolationKeyRingConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.policy = createPrivacyIsolationPolicy(policy);
    this.schema = privacySchema(scope);
    this.controlId = ontologyId("cortex-behavioral-privacy-key-control-v1", { scope });
    const ring = buildKeyRing(keyRingConfig);
    this.ring = ring.keys;
    this.bootstrapActiveKeyId = ring.bootstrapActiveKeyId;
    this.ensureControl();
    this.assertConfiguredMaterial(this.requireControl());
  }

  private clock(): { readonly ms: number; readonly iso: string } {
    const ms = safeNow(this.now);
    return Object.freeze({ ms, iso: new Date(ms).toISOString() });
  }

  private readControl(): KeyControlRecord | undefined {
    const raw = this.transactions.getObject(this.scope, this.controlId);
    return raw ? parseKeyControl(raw) : undefined;
  }

  private requireControl(): KeyControlRecord {
    const record = this.readControl();
    if (!record) throw new BehavioralSignalError("INTEGRITY_FAILURE", "privacy key control is missing");
    if (record.policyDigest !== this.policy.digest) throw new BehavioralSignalError("POLICY_VIOLATION", "privacy policy differs from durable key control; explicit migration is required");
    return record;
  }

  private material(keyId: string): Buffer {
    const key = this.ring.get(keyId);
    if (!key) throw new BehavioralSignalError("POLICY_VIOLATION", `privacy key ${keyId} is required by durable control but missing from keyring`);
    return key;
  }

  private assertEpochMaterial(epoch: KeyEpoch): void {
    const key = this.material(epoch.keyId);
    if (keyVerifier(epoch.keyId, key) !== epoch.verifier) throw new BehavioralSignalError("INTEGRITY_FAILURE", `privacy key ${epoch.keyId} does not match its durable verifier`);
  }

  private assertConfiguredMaterial(record: KeyControlRecord): void {
    this.assertEpochMaterial(record.active);
    const now = this.clock().ms;
    for (const epoch of record.previous) {
      const deactivated = canonicalUtc(epoch.deactivatedAt!, "privacy previous deactivatedAt", "INTEGRITY_FAILURE");
      if (now < deactivated + this.policy.sessionTtlMs) this.assertEpochMaterial(epoch);
    }
  }

  private ensureControl(): void {
    if (this.readControl()) return;
    const clock = this.clock();
    const key = this.material(this.bootstrapActiveKeyId);
    const active: KeyEpoch = Object.freeze({ keyId: this.bootstrapActiveKeyId, verifier: keyVerifier(this.bootstrapActiveKeyId, key), activatedAt: clock.iso, deactivatedAt: null });
    const payload: KeyControlPayload = Object.freeze({ version: 1, policyDigest: this.policy.digest, generation: 1, active, previous: Object.freeze([]) });
    const operation: TransactionOperation = { kind: "CREATE_OBJECT", record: { id: this.controlId, typeId: KEY_CONTROL_TYPE, scope: this.scope, properties: keyControlProperties(payload, clock.iso) } };
    try { this.transactions.transact(this.scope, this.schema, [operation]); }
    catch (error) {
      if (conflict(error)) { this.requireControl(); return; }
      throw error;
    }
  }

  controlState(): PrivacyIsolationKeyControlState {
    const record = this.requireControl();
    return Object.freeze({
      generation: record.generation,
      digest: record.digest,
      activeKeyId: record.active.keyId,
      activeActivatedAt: record.active.activatedAt,
      previous: Object.freeze(record.previous.map((epoch) => Object.freeze({ keyId: epoch.keyId, deactivatedAt: epoch.deactivatedAt!, verificationUntil: new Date(canonicalUtc(epoch.deactivatedAt!, "deactivatedAt", "INTEGRITY_FAILURE") + this.policy.sessionTtlMs).toISOString() }))),
    });
  }

  activeMaterial(): Readonly<{ keyId: string; key: Buffer }> {
    const record = this.requireControl();
    this.assertEpochMaterial(record.active);
    const now = this.clock().ms;
    const activated = canonicalUtc(record.active.activatedAt, "privacy active activatedAt", "INTEGRITY_FAILURE");
    if (now >= activated + this.policy.maxActiveKeyAgeMs) throw new BehavioralSignalError("POLICY_VIOLATION", "active privacy key exceeded maxActiveKeyAgeMs and must be rotated");
    return Object.freeze({ keyId: record.active.keyId, key: Buffer.from(this.material(record.active.keyId)) });
  }

  verificationMaterial(keyIdInput: string): Buffer {
    const keyId = identifier(keyIdInput, "privacy token keyId");
    const record = this.requireControl();
    if (record.active.keyId === keyId) {
      this.assertEpochMaterial(record.active);
      return Buffer.from(this.material(keyId));
    }
    const previous = record.previous.find((epoch) => epoch.keyId === keyId);
    if (!previous) throw new BehavioralSignalError("POLICY_VIOLATION", "privacy token key is not active or in the verification grace set");
    const deactivated = canonicalUtc(previous.deactivatedAt!, "privacy token key deactivatedAt", "INTEGRITY_FAILURE");
    if (this.clock().ms >= deactivated + this.policy.sessionTtlMs) throw new BehavioralSignalError("POLICY_VIOLATION", "privacy token key verification grace has expired");
    this.assertEpochMaterial(previous);
    return Buffer.from(this.material(keyId));
  }

  activate(keyIdInput: string, expectedControlDigest: string): PrivacyIsolationKeyControlState {
    const keyId = identifier(keyIdInput, "privacy keyId");
    if (!SHA256.test(expectedControlDigest)) throw new BehavioralSignalError("INVALID_INPUT", "expectedControlDigest is malformed");
    const current = this.requireControl();
    if (current.digest !== expectedControlDigest) throw new BehavioralSignalError("CONFLICT", "privacy key control changed before activation");
    if (current.active.keyId === keyId) return this.controlState();
    const nextKey = this.material(keyId);
    const clock = this.clock();
    const previous = current.previous.filter((epoch) => clock.ms < canonicalUtc(epoch.deactivatedAt!, "previous.deactivatedAt", "INTEGRITY_FAILURE") + this.policy.sessionTtlMs);
    if (previous.some((epoch) => epoch.keyId === keyId)) throw new BehavioralSignalError("POLICY_VIOLATION", "cannot reactivate a key while its previous epoch is still in verification grace");
    const retiredActive: KeyEpoch = Object.freeze({ ...current.active, deactivatedAt: clock.iso });
    const nextPrevious = Object.freeze([...previous, retiredActive].sort((a, b) => a.keyId.localeCompare(b.keyId, "en")));
    if (nextPrevious.length > 3) throw new BehavioralSignalError("POLICY_VIOLATION", "privacy key rotation requires retiring an expired previous epoch first");
    const active: KeyEpoch = Object.freeze({ keyId, verifier: keyVerifier(keyId, nextKey), activatedAt: clock.iso, deactivatedAt: null });
    const payload: KeyControlPayload = Object.freeze({ version: 1, policyDigest: this.policy.digest, generation: current.generation + 1, active, previous: nextPrevious });
    const operation: TransactionOperation = { kind: "UPDATE_OBJECT", id: current.id, expectedRevision: current.revision, properties: keyControlProperties(payload, clock.iso) };
    try { this.transactions.transact(this.scope, this.schema, [operation]); }
    catch (error) { if (conflict(error)) throw new BehavioralSignalError("CONFLICT", "privacy key activation conflicted"); throw error; }
    return this.controlState();
  }

  retire(keyIdInput: string, expectedControlDigest: string): PrivacyIsolationKeyControlState {
    const keyId = identifier(keyIdInput, "privacy keyId");
    if (!SHA256.test(expectedControlDigest)) throw new BehavioralSignalError("INVALID_INPUT", "expectedControlDigest is malformed");
    const current = this.requireControl();
    if (current.digest !== expectedControlDigest) throw new BehavioralSignalError("CONFLICT", "privacy key control changed before retirement");
    if (current.active.keyId === keyId) throw new BehavioralSignalError("POLICY_VIOLATION", "active privacy key cannot be retired");
    const target = current.previous.find((epoch) => epoch.keyId === keyId);
    if (!target) throw new BehavioralSignalError("POLICY_VIOLATION", "privacy key is not a previous epoch");
    const clock = this.clock();
    const deactivated = canonicalUtc(target.deactivatedAt!, "privacy previous deactivatedAt", "INTEGRITY_FAILURE");
    if (clock.ms < deactivated + this.policy.sessionTtlMs) throw new BehavioralSignalError("POLICY_VIOLATION", "privacy key cannot be retired before all tokens from its epoch expire");
    const payload: KeyControlPayload = Object.freeze({ version: 1, policyDigest: this.policy.digest, generation: current.generation + 1, active: current.active, previous: Object.freeze(current.previous.filter((epoch) => epoch.keyId !== keyId)) });
    const operation: TransactionOperation = { kind: "UPDATE_OBJECT", id: current.id, expectedRevision: current.revision, properties: keyControlProperties(payload, clock.iso) };
    try { this.transactions.transact(this.scope, this.schema, [operation]); }
    catch (error) { if (conflict(error)) throw new BehavioralSignalError("CONFLICT", "privacy key retirement conflicted"); throw error; }
    return this.controlState();
  }
}

function payloadJson(payload: SessionTokenPayload): string {
  return JSON.stringify({ version: 1, keyId: payload.keyId, siteId: payload.siteId, nonce: payload.nonce, privacyDecisionDigest: payload.privacyDecisionDigest, issuedAt: payload.issuedAt, expiresAt: payload.expiresAt });
}

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function parsePayload(encoded: string): SessionTokenPayload {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown; }
  catch { throw new BehavioralSignalError("INVALID_INPUT", "privacy isolation session token payload is malformed"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) throw new BehavioralSignalError("INVALID_INPUT", "privacy isolation session token payload must be a plain object");
  const raw = parsed as Record<string, unknown>;
  const keys = new Set(["version", "keyId", "siteId", "nonce", "privacyDecisionDigest", "issuedAt", "expiresAt"]);
  if (Object.keys(raw).length !== keys.size || [...keys].some((key) => !(key in raw))) throw new BehavioralSignalError("INVALID_INPUT", "privacy isolation session token payload fields are invalid");
  if (raw.version !== 1 || typeof raw.keyId !== "string" || typeof raw.siteId !== "string" || typeof raw.nonce !== "string" || typeof raw.privacyDecisionDigest !== "string" || typeof raw.issuedAt !== "string" || typeof raw.expiresAt !== "string") throw new BehavioralSignalError("INVALID_INPUT", "privacy isolation session token payload types are invalid");
  if (!/^[a-f0-9]{32}$/u.test(raw.nonce)) throw new BehavioralSignalError("INVALID_INPUT", "privacy isolation session nonce is malformed");
  if (!/^privacy:[0-9a-f]{64}$/u.test(raw.privacyDecisionDigest)) throw new BehavioralSignalError("INVALID_INPUT", "privacy isolation decision digest is malformed");
  return Object.freeze({ version: 1, keyId: identifier(raw.keyId, "session keyId"), siteId: identifier(raw.siteId, "session siteId"), nonce: raw.nonce, privacyDecisionDigest: raw.privacyDecisionDigest, issuedAt: raw.issuedAt, expiresAt: raw.expiresAt });
}

export interface PrivacyIsolationSessionServiceOptions {
  readonly keyLifecycle: PrivacyIsolationKeyLifecycle;
  readonly now?: () => number;
  readonly random?: (bytes: number) => Buffer;
}

export class PrivacyIsolationSessionService {
  readonly policy: PrivacyIsolationPolicy;
  private readonly now: () => number;
  private readonly random: (bytes: number) => Buffer;

  constructor(private readonly options: PrivacyIsolationSessionServiceOptions) {
    this.policy = options.keyLifecycle.policy;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? randomBytes;
  }

  private signature(payload: string, key: Buffer): Buffer {
    return createHmac("sha256", key).update(`cortex-privacy-isolation-session-v1\n${payload}`, "utf8").digest();
  }

  issue(siteIdValue: string, privacyDecisionRefValue: string, collectionAllowed: boolean): string {
    if (collectionAllowed !== true) throw new BehavioralSignalError("POLICY_VIOLATION", "privacy isolation session cannot be issued when upstream collection is denied");
    const siteId = identifier(siteIdValue, "siteId");
    if (!this.policy.allowedSiteIds.includes(siteId)) throw new BehavioralSignalError("POLICY_VIOLATION", "siteId is not allowlisted for privacy-isolated telemetry");
    const privacyDecisionRef = opaque(privacyDecisionRefValue, "privacyDecisionRef");
    const active = this.options.keyLifecycle.activeMaterial();
    const now = safeNow(this.now);
    const nonceBytes = this.random(16);
    if (!Buffer.isBuffer(nonceBytes) || nonceBytes.byteLength !== 16) throw new BehavioralSignalError("INTEGRITY_FAILURE", "privacy isolation random source must return exactly 16 bytes");
    const privacyDecisionDigest = `privacy:${createHmac("sha256", active.key).update(`cortex-privacy-isolation-consent-v1\n${siteId}\n${privacyDecisionRef}`, "utf8").digest("hex")}`;
    const payload = b64url(payloadJson({ version: 1, keyId: active.keyId, siteId, nonce: nonceBytes.toString("hex"), privacyDecisionDigest, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + this.policy.sessionTtlMs).toISOString() }));
    return `${payload}.${b64url(this.signature(payload, active.key))}`;
  }

  verify(token: string, expectedSiteIdValue: string): SessionTokenPayload {
    const expectedSiteId = identifier(expectedSiteIdValue, "siteId");
    if (typeof token !== "string" || token.length < 64 || token.length > 2_048) throw new BehavioralSignalError("INVALID_INPUT", "privacy isolation session token is malformed");
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new BehavioralSignalError("INVALID_INPUT", "privacy isolation session token is malformed");
    const payload = parsePayload(parts[0]);
    const key = this.options.keyLifecycle.verificationMaterial(payload.keyId);
    let signature: Buffer;
    try { signature = Buffer.from(parts[1], "base64url"); }
    catch { throw new BehavioralSignalError("INVALID_INPUT", "privacy isolation session token signature is malformed"); }
    const expected = this.signature(parts[0], key);
    if (signature.byteLength !== expected.byteLength || !timingSafeEqual(signature, expected)) throw new BehavioralSignalError("POLICY_VIOLATION", "privacy isolation session token signature is invalid");
    if (payload.siteId !== expectedSiteId) throw new BehavioralSignalError("POLICY_VIOLATION", "privacy isolation session token belongs to another site");
    if (!this.policy.allowedSiteIds.includes(payload.siteId)) throw new BehavioralSignalError("POLICY_VIOLATION", "privacy isolation session token site is no longer allowlisted");
    const issuedAt = canonicalUtc(payload.issuedAt, "session issuedAt");
    const expiresAt = canonicalUtc(payload.expiresAt, "session expiresAt");
    if (expiresAt - issuedAt !== this.policy.sessionTtlMs) throw new BehavioralSignalError("POLICY_VIOLATION", "privacy isolation session token lifetime is invalid");
    const now = safeNow(this.now);
    if (now < issuedAt || now >= expiresAt) throw new BehavioralSignalError("POLICY_VIOLATION", "privacy isolation session token is not currently valid");
    return payload;
  }

  scopedOpaqueId(namespace: "session" | "event", payload: SessionTokenPayload, raw: string): string {
    const input = opaque(raw, namespace === "event" ? "eventId" : "session seed");
    const key = this.options.keyLifecycle.verificationMaterial(payload.keyId);
    const digest = createHmac("sha256", key).update(`cortex-privacy-isolation-${namespace}-v1\n${payload.keyId}\n${payload.siteId}\n${payload.nonce}\n${input}`, "utf8").digest("hex");
    return `${namespace}:${digest}`;
  }
}

function retentionPayloadJson(payload: RetentionPayload): JsonValue {
  return json({ version: 1, policyDigest: payload.policyDigest, windowStartedAt: payload.windowStartedAt, purgeAt: payload.purgeAt, sessions: payload.sessions.map((entry) => ({ sessionRef: entry.sessionRef, baseObjectId: entry.baseObjectId, microObjectId: entry.microObjectId })) }, "privacy.retention.payload");
}

function retentionDigest(siteId: string, payload: RetentionPayload, updatedAt: string): string {
  return hash("cortex-behavioral-privacy-retention-v1", { siteId, payload: retentionPayloadJson(payload), updatedAt });
}

function retentionProperties(siteId: string, payload: RetentionPayload, updatedAt: string): Record<string, JsonValue> {
  return { [RETENTION.siteId]: siteId, [RETENTION.payload]: retentionPayloadJson(payload), [RETENTION.digest]: retentionDigest(siteId, payload, updatedAt), [RETENTION.updatedAt]: updatedAt };
}

function storedObjectId(value: JsonValue | undefined, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length < 8 || value.length > 512 || /\s/u.test(value)) throw new BehavioralSignalError("INTEGRITY_FAILURE", `${field} invalid`);
  return value;
}

function parseRetention(record: ObjectRecord): RetentionRecord {
  if (record.typeId !== RETENTION_TYPE) throw new BehavioralSignalError("INTEGRITY_FAILURE", "privacy retention index type mismatch");
  exactKeys(record.properties as unknown as object, new Set(Object.values(RETENTION)), "privacy retention record", "INTEGRITY_FAILURE");
  const siteValue = record.properties[RETENTION.siteId];
  const payloadRaw = object(record.properties[RETENTION.payload], "privacy retention payload");
  if (typeof siteValue !== "string") throw new BehavioralSignalError("INTEGRITY_FAILURE", "privacy retention siteId invalid");
  const siteId = identifier(siteValue, "privacy retention siteId");
  exactKeys(payloadRaw as unknown as object, new Set(["version", "policyDigest", "windowStartedAt", "purgeAt", "sessions"]), "privacy retention payload", "INTEGRITY_FAILURE");
  if (payloadRaw.version !== 1 || typeof payloadRaw.policyDigest !== "string" || !SHA256.test(payloadRaw.policyDigest) || typeof payloadRaw.windowStartedAt !== "string" || typeof payloadRaw.purgeAt !== "string" || !Array.isArray(payloadRaw.sessions)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "privacy retention payload fields invalid");
  const started = canonicalUtc(payloadRaw.windowStartedAt, "privacy retention windowStartedAt", "INTEGRITY_FAILURE");
  const purge = canonicalUtc(payloadRaw.purgeAt, "privacy retention purgeAt", "INTEGRITY_FAILURE");
  if (purge <= started) throw new BehavioralSignalError("INTEGRITY_FAILURE", "privacy retention window is invalid");
  const sessions = Object.freeze(payloadRaw.sessions.map((item, index) => {
    const raw = object(item, `privacy retention sessions[${index}]`);
    exactKeys(raw as unknown as object, new Set(["sessionRef", "baseObjectId", "microObjectId"]), `privacy retention sessions[${index}]`, "INTEGRITY_FAILURE");
    if (typeof raw.sessionRef !== "string" || !SESSION_REF.test(raw.sessionRef)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "privacy retention sessionRef invalid");
    return Object.freeze({ sessionRef: raw.sessionRef, baseObjectId: storedObjectId(raw.baseObjectId, "baseObjectId"), microObjectId: storedObjectId(raw.microObjectId, "microObjectId") });
  }).sort((a, b) => a.sessionRef.localeCompare(b.sessionRef, "en")));
  if (new Set(sessions.map((entry) => entry.sessionRef)).size !== sessions.length) throw new BehavioralSignalError("INTEGRITY_FAILURE", "privacy retention sessionRefs must be unique");
  const payload: RetentionPayload = Object.freeze({ version: 1, policyDigest: payloadRaw.policyDigest, windowStartedAt: payloadRaw.windowStartedAt, purgeAt: payloadRaw.purgeAt, sessions });
  const updatedValue = record.properties[RETENTION.updatedAt];
  const digestValue = record.properties[RETENTION.digest];
  if (typeof updatedValue !== "string" || typeof digestValue !== "string" || !SHA256.test(digestValue)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "privacy retention metadata invalid");
  canonicalUtc(updatedValue, "privacy retention updatedAt", "INTEGRITY_FAILURE");
  if (digestValue !== retentionDigest(siteId, payload, updatedValue)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "privacy retention digest mismatch");
  return Object.freeze({ id: record.id, siteId, ...payload, digest: digestValue, updatedAt: updatedValue, revision: record.revision });
}

export class PrivacyRetainingTransactionPort implements OntologyTransactionPort {
  readonly policy: PrivacyIsolationPolicy;
  private readonly schema: ValidatedSchema;
  private readonly combined = new Map<string, ValidatedSchema>();
  private context: RetentionContext | null = null;

  constructor(
    private readonly delegate: OntologyTransactionPort,
    readonly scope: OntologyScope,
    policy: PrivacyIsolationPolicy,
    private readonly now: () => number = Date.now,
  ) {
    this.policy = createPrivacyIsolationPolicy(policy);
    this.schema = privacySchema(scope);
  }

  getObject(scope: OntologyScope, id: string): ObjectRecord | undefined { return this.delegate.getObject(scope, id); }
  getRelationship(scope: OntologyScope, id: string) { return this.delegate.getRelationship(scope, id); }

  private clock(): { readonly ms: number; readonly iso: string } {
    const ms = safeNow(this.now);
    return Object.freeze({ ms, iso: new Date(ms).toISOString() });
  }

  private retentionId(siteId: string): string { return ontologyId("cortex-behavioral-privacy-retention-v1", { scope: this.scope, siteId }); }
  private baseSiteId(siteId: string): string { return ontologyId("cortex-behavioral-site-v1", { scope: this.scope, siteId }); }
  private microSiteId(siteId: string): string { return ontologyId("cortex-behavioral-micro-site-v1", { scope: this.scope, siteId }); }

  private readRetention(siteId: string): RetentionRecord | undefined {
    const raw = this.delegate.getObject(this.scope, this.retentionId(siteId));
    if (!raw) return undefined;
    const parsed = parseRetention(raw);
    if (parsed.policyDigest !== this.policy.digest) throw new BehavioralSignalError("POLICY_VIOLATION", "privacy retention policy differs from durable index; explicit migration is required");
    return parsed;
  }

  private assertNoUntrackedLegacyState(siteId: string): void {
    if (this.readRetention(siteId)) return;
    if (this.delegate.getObject(this.scope, this.baseSiteId(siteId)) || this.delegate.getObject(this.scope, this.microSiteId(siteId))) {
      throw new BehavioralSignalError("POLICY_VIOLATION", `site ${siteId} contains behavioral state created before CORTEX #26 retention tracking; use a clean private state store or perform an explicit purge migration`);
    }
  }

  sweepSite(siteIdInput: string): Readonly<{ purged: boolean; deletedObjects: number }> {
    const siteId = identifier(siteIdInput, "siteId");
    if (!this.policy.allowedSiteIds.includes(siteId)) throw new BehavioralSignalError("POLICY_VIOLATION", "siteId is not allowlisted for privacy retention");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const record = this.readRetention(siteId);
      if (!record) { this.assertNoUntrackedLegacyState(siteId); return Object.freeze({ purged: false, deletedObjects: 0 }); }
      const clock = this.clock();
      if (clock.ms < canonicalUtc(record.purgeAt, "privacy retention purgeAt", "INTEGRITY_FAILURE")) return Object.freeze({ purged: false, deletedObjects: 0 });
      const ids = new Set<string>([this.baseSiteId(siteId), this.microSiteId(siteId)]);
      for (const entry of record.sessions) {
        if (entry.baseObjectId) ids.add(entry.baseObjectId);
        if (entry.microObjectId) ids.add(entry.microObjectId);
      }
      const operations: TransactionOperation[] = [];
      for (const id of [...ids].sort((a, b) => a.localeCompare(b, "en"))) {
        const current = this.delegate.getObject(this.scope, id);
        if (current) operations.push({ kind: "DELETE_OBJECT", id, expectedRevision: current.revision });
      }
      operations.push({ kind: "DELETE_OBJECT", id: record.id, expectedRevision: record.revision });
      try {
        this.delegate.transact(this.scope, this.schema, operations);
        return Object.freeze({ purged: true, deletedObjects: operations.length - 1 });
      } catch (error) {
        if (conflict(error) && attempt < 3) continue;
        if (conflict(error)) throw new BehavioralSignalError("CONFLICT", "privacy retention sweep conflicted");
        throw error;
      }
    }
    throw new BehavioralSignalError("CONFLICT", "privacy retention sweep exhausted retries");
  }

  sweepAll(): Readonly<{ purgedSites: number; deletedObjects: number }> {
    let purgedSites = 0;
    let deletedObjects = 0;
    for (const siteId of this.policy.allowedSiteIds) {
      const result = this.sweepSite(siteId);
      if (result.purged) purgedSites += 1;
      deletedObjects += result.deletedObjects;
    }
    return Object.freeze({ purgedSites, deletedObjects });
  }

  withSessionContext<T>(context: RetentionContext, operation: () => T): T {
    if (this.context) throw new BehavioralSignalError("INTEGRITY_FAILURE", "privacy retention context cannot be nested");
    const siteId = identifier(context.siteId, "siteId");
    if (!this.policy.allowedSiteIds.includes(siteId)) throw new BehavioralSignalError("POLICY_VIOLATION", "siteId is not allowlisted for privacy retention");
    if (!SESSION_REF.test(context.sessionRef)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "privacy retention sessionRef is malformed");
    this.sweepSite(siteId);
    this.context = Object.freeze({ ...context, siteId });
    try { return operation(); }
    finally { this.context = null; }
  }

  private findSessionObjectId(operations: readonly TransactionOperation[], channel: "BASE" | "MICRO"): string | null {
    const expectedType = channel === "BASE" ? BASE_SESSION_TYPE : MICRO_SESSION_TYPE;
    const matches: string[] = [];
    for (const operation of operations) {
      if (operation.kind === "CREATE_OBJECT" && operation.record.typeId === expectedType) matches.push(operation.record.id);
      if (operation.kind === "UPDATE_OBJECT") {
        const current = this.delegate.getObject(this.scope, operation.id);
        if (current?.typeId === expectedType) matches.push(operation.id);
      }
    }
    const unique = [...new Set(matches)];
    if (unique.length > 1) throw new BehavioralSignalError("INTEGRITY_FAILURE", "behavioral transaction touched multiple session aggregates under one privacy context");
    return unique[0] ?? null;
  }

  private retentionOperation(context: RetentionContext, sessionObjectId: string): TransactionOperation {
    const clock = this.clock();
    const current = this.readRetention(context.siteId);
    let payload: RetentionPayload;
    if (!current) {
      this.assertNoUntrackedLegacyState(context.siteId);
      payload = Object.freeze({ version: 1, policyDigest: this.policy.digest, windowStartedAt: clock.iso, purgeAt: new Date(clock.ms + this.policy.aggregateRetentionMs).toISOString(), sessions: Object.freeze([]) });
    } else {
      if (clock.ms >= canonicalUtc(current.purgeAt, "privacy retention purgeAt", "INTEGRITY_FAILURE")) throw new BehavioralSignalError("INTEGRITY_FAILURE", "expired privacy retention window reached transaction boundary without sweep");
      payload = current;
    }
    const existing = payload.sessions.find((entry) => entry.sessionRef === context.sessionRef);
    if (!existing && payload.sessions.length >= this.policy.maxTrackedSessionsPerSite) throw new BehavioralSignalError("POLICY_VIOLATION", "privacy retention index capacity reached; refusing untracked behavioral session");
    const nextEntry: RetentionSessionEntry = Object.freeze({
      sessionRef: context.sessionRef,
      baseObjectId: context.channel === "BASE" ? sessionObjectId : existing?.baseObjectId ?? null,
      microObjectId: context.channel === "MICRO" ? sessionObjectId : existing?.microObjectId ?? null,
    });
    if (existing) {
      if (context.channel === "BASE" && existing.baseObjectId && existing.baseObjectId !== sessionObjectId) throw new BehavioralSignalError("INTEGRITY_FAILURE", "privacy retention base session object changed identity");
      if (context.channel === "MICRO" && existing.microObjectId && existing.microObjectId !== sessionObjectId) throw new BehavioralSignalError("INTEGRITY_FAILURE", "privacy retention micro session object changed identity");
    }
    const sessions = Object.freeze([...payload.sessions.filter((entry) => entry.sessionRef !== context.sessionRef), nextEntry].sort((a, b) => a.sessionRef.localeCompare(b.sessionRef, "en")));
    const nextPayload: RetentionPayload = Object.freeze({ version: 1, policyDigest: this.policy.digest, windowStartedAt: payload.windowStartedAt, purgeAt: payload.purgeAt, sessions });
    const properties = retentionProperties(context.siteId, nextPayload, clock.iso);
    return current
      ? { kind: "UPDATE_OBJECT", id: current.id, expectedRevision: current.revision, properties }
      : { kind: "CREATE_OBJECT", record: { id: this.retentionId(context.siteId), typeId: RETENTION_TYPE, scope: this.scope, properties } };
  }

  transact(scope: OntologyScope, schema: ValidatedSchema, operations: readonly TransactionOperation[]): TransactionResult {
    if (!this.context) return this.delegate.transact(scope, schema, operations);
    const sessionObjectId = this.findSessionObjectId(operations, this.context.channel);
    if (!sessionObjectId) return this.delegate.transact(scope, schema, operations);
    let combined = this.combined.get(schema.version);
    if (!combined) { combined = combineSchemas(schema, this.schema); this.combined.set(schema.version, combined); }
    const retention = this.retentionOperation(this.context, sessionObjectId);
    return this.delegate.transact(scope, combined, [...operations, retention]);
  }
}

export class PrivacyIsolatedBehavioralSignalAdapter {
  constructor(
    private readonly runtime: CortexBehavioralSignalRuntime,
    private readonly sessions: PrivacyIsolationSessionService,
    private readonly retention: PrivacyRetainingTransactionPort,
  ) {}

  ingest(input: PrivacyIsolatedBehavioralEventInput): BehavioralSignalIngestResult {
    exactKeys(input as object, BASE_KEYS, "privacy-isolated behavioral event");
    const session = this.sessions.verify(input.sessionToken, input.siteId);
    const sessionRef = this.sessions.scopedOpaqueId("session", session, session.nonce);
    const isolated: BehavioralSignalEventInput = {
      eventId: this.sessions.scopedOpaqueId("event", session, opaque(input.eventId, "eventId")),
      sessionId: sessionRef,
      siteId: input.siteId,
      kind: input.kind,
      occurredAt: input.occurredAt,
      surfaceId: input.surfaceId,
      ...(input.elementId === undefined ? {} : { elementId: input.elementId }),
      ...(input.engagementMs === undefined ? {} : { engagementMs: input.engagementMs }),
      ...(input.scrollDepthPercent === undefined ? {} : { scrollDepthPercent: input.scrollDepthPercent }),
      collectionAllowed: true,
      privacyDecisionRef: session.privacyDecisionDigest,
      ...(input.mode === undefined ? {} : { mode: input.mode }),
    };
    return this.retention.withSessionContext({ channel: "BASE", siteId: input.siteId, sessionRef }, () => this.runtime.ingest(isolated));
  }

  ingestMicroInteraction(input: PrivacyIsolatedMicroInteractionInput): BehavioralMicroInteractionResult {
    exactKeys(input as object, MICRO_KEYS, "privacy-isolated micro interaction");
    const session = this.sessions.verify(input.sessionToken, input.siteId);
    const sessionRef = this.sessions.scopedOpaqueId("session", session, session.nonce);
    const isolated: BehavioralMicroInteractionInput = {
      eventId: this.sessions.scopedOpaqueId("event", session, opaque(input.eventId, "eventId")),
      sessionId: sessionRef,
      siteId: input.siteId,
      kind: input.kind,
      occurredAt: input.occurredAt,
      surfaceId: input.surfaceId,
      ...(input.elementId === undefined ? {} : { elementId: input.elementId }),
      ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
      collectionAllowed: true,
      privacyDecisionRef: session.privacyDecisionDigest,
      ...(input.mode === undefined ? {} : { mode: input.mode }),
    };
    return this.retention.withSessionContext({ channel: "MICRO", siteId: input.siteId, sessionRef }, () => this.runtime.ingestMicroInteraction(isolated));
  }
}
