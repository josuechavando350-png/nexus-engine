import { canonicalJson } from "./index.js";
import type { ObjectRecord, PropertyValue } from "./transaction.js";

import {
  MEMORY_CATEGORIES,
  MEMORY_RETENTION_BASES,
  MEMORY_SENSITIVITIES,
  MEMORY_SOURCE_KINDS,
  MEMORY_STATUSES,
  MEMORY_TYPE,
  MP,
  LongTermMemoryError,
  type LongTermMemoryPolicy,
  type LongTermMemoryRecord,
  type MemoryCategory,
  type MemoryRetentionBasis,
  type MemorySensitivity,
  type MemorySourceKind,
  type MemoryStatus,
  type UpsertLongTermMemoryInput,
} from "./chatbot-memory-types.js";
import { maximumMemoryAge } from "./chatbot-memory-policy.js";
import {
  assertJsonValue,
  canonicalUtc,
  checkedConfidence,
  hash,
  nonEmpty,
  normalizeIdentifier,
} from "./chatbot-knowledge-types.js";

const FORBIDDEN_MEMORY_KEY_TERMS = [
  "password", "passwd", "contrasena", "secret", "api-key", "apikey", "private-key", "privatekey",
  "access-token", "refresh-token", "auth-token", "cvv", "pin", "otp", "one-time-password",
] as const;

const SECRET_VALUE_PATTERN = /\b(?:password|passwd|contrasena|cvv|otp|one[ -]?time[ -]?password|api[ -]?key|access[ -]?token|refresh[ -]?token|auth[ -]?token|private[ -]?key)\b/i;
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i;
const PAYMENT_CARD_PATTERN = /(?:\d[ -]*?){13,19}/;
const SENSITIVE_TOPIC_PATTERN = /\b(?:salud|medic[oa]|diagnostic[oa]|health|medical|diagnosis|religion|religious|politic[oa]|partido politico|political|sexual|biometric[oa]|biometric|raza|race|etnia|ethnicity|antecedentes penales|criminal history)\b/i;

function violation(stored: boolean, message: string): never {
  throw new LongTermMemoryError(stored ? "INTEGRITY_FAILURE" : "POLICY_VIOLATION", message);
}

function storedEnum<T extends string>(value: string, values: readonly T[], field: string): T {
  if (!values.includes(value as T)) throw new LongTermMemoryError("INTEGRITY_FAILURE", `${field} contains unsupported value ${value}`);
  return value as T;
}

function stringProperty(record: ObjectRecord, id: string): string {
  const value = record.properties[id];
  if (typeof value !== "string" || !value.trim()) throw new LongTermMemoryError("INTEGRITY_FAILURE", `${record.id}.${id} is not a valid string`);
  return value;
}

function numberProperty(record: ObjectRecord, id: string): number {
  const value = record.properties[id];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new LongTermMemoryError("INTEGRITY_FAILURE", `${record.id}.${id} is not a valid number`);
  return value;
}

function jsonProperty(record: ObjectRecord, id: string): PropertyValue {
  const value = record.properties[id];
  if (value === undefined) throw new LongTermMemoryError("INTEGRITY_FAILURE", `${record.id}.${id} is missing`);
  return value;
}

function normalizedSearchText(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function assertAllowedMemoryKey(memoryKey: string, stored = false): void {
  const normalized = normalizedSearchText(memoryKey);
  if (FORBIDDEN_MEMORY_KEY_TERMS.some((term) => normalized.includes(normalizedSearchText(term)))) {
    violation(stored, "credential, authentication, payment-secret, or private-key material must not be stored in long-term memory");
  }
}

function assertSafeMemoryValue(value: PropertyValue, sensitivity: MemorySensitivity, stored = false): void {
  if (value === null) {
    if (stored) throw new LongTermMemoryError("INTEGRITY_FAILURE", "stored long-term memory value must not be null");
    throw new LongTermMemoryError("INVALID_INPUT", "long-term memory value must not be null");
  }
  const text = normalizedSearchText(canonicalJson(value));
  if (SECRET_VALUE_PATTERN.test(text) || PRIVATE_KEY_PATTERN.test(text) || PAYMENT_CARD_PATTERN.test(text)) {
    violation(stored, "credential, authentication, payment-card, or private-key material must not be stored in long-term memory");
  }
  if (SENSITIVE_TOPIC_PATTERN.test(text) && sensitivity !== "SENSITIVE") {
    violation(stored, "memory containing sensitive-topic data must be explicitly classified as SENSITIVE");
  }
}

function assertSourceCategory(sourceKind: MemorySourceKind, category: MemoryCategory, stored = false): void {
  if (sourceKind === "CUSTOMER_IMPLICIT" && (category === "PROFILE" || category === "COMMITMENT")) {
    violation(stored, "implicit customer inference cannot create PROFILE or COMMITMENT long-term memory");
  }
  if (sourceKind === "SYSTEM_SUMMARY" && category !== "CONTEXT" && category !== "INTERACTION_SUMMARY") {
    violation(stored, "system summaries may only create CONTEXT or INTERACTION_SUMMARY long-term memory");
  }
}

function assertPolicyForMemory(
  policy: LongTermMemoryPolicy,
  sensitivity: MemorySensitivity,
  retentionBasis: MemoryRetentionBasis,
  sourceKind: MemorySourceKind,
  observedAt: string,
  expiresAt: string,
  stored = false,
): void {
  if (sensitivity === "SENSITIVE") {
    if (!policy.allowSensitive) violation(stored, "sensitive long-term memory is disabled by policy");
    if (retentionBasis !== "USER_REQUEST" && retentionBasis !== "OPERATOR_APPROVED") {
      violation(stored, "sensitive memory requires USER_REQUEST or OPERATOR_APPROVED retention basis");
    }
    if (sourceKind === "CUSTOMER_IMPLICIT" || sourceKind === "SYSTEM_SUMMARY") {
      violation(stored, "sensitive memory cannot be created from implicit inference or a system summary");
    }
  }
  if (sensitivity === "PERSONAL" && policy.requireUserRequestForPersonal && retentionBasis === "SERVICE_CONTEXT") {
    violation(stored, "personal memory requires USER_REQUEST or OPERATOR_APPROVED retention basis under the active policy");
  }
  const ttl = Date.parse(expiresAt) - Date.parse(observedAt);
  if (ttl <= 0) {
    if (stored) throw new LongTermMemoryError("INTEGRITY_FAILURE", "stored expiresAt must be later than observedAt");
    throw new LongTermMemoryError("INVALID_INPUT", "expiresAt must be later than observedAt");
  }
  if (ttl > maximumMemoryAge(policy, sensitivity)) {
    violation(stored, `memory retention exceeds the configured maximum for ${sensitivity}`);
  }
}

function effectiveConfidence(sourceKind: MemorySourceKind, value: number | undefined): number {
  const confidence = checkedConfidence(value ?? (sourceKind === "CUSTOMER_EXPLICIT" || sourceKind === "OPERATOR" ? 1 : 0.8));
  if (sourceKind === "CUSTOMER_IMPLICIT" && confidence > 0.85) {
    throw new LongTermMemoryError("POLICY_VIOLATION", "implicit customer memory confidence cannot exceed 0.85");
  }
  if (sourceKind === "SYSTEM_SUMMARY" && confidence > 0.9) {
    throw new LongTermMemoryError("POLICY_VIOLATION", "system-summary memory confidence cannot exceed 0.9");
  }
  return confidence;
}

export function memoryIdentity(input: Pick<UpsertLongTermMemoryInput, "subjectId" | "memoryKey">): { id: string; subjectId: string; memoryKey: string } {
  const subjectId = normalizeIdentifier(input.subjectId, "subjectId");
  const memoryKey = normalizeIdentifier(input.memoryKey, "memoryKey");
  assertAllowedMemoryKey(memoryKey);
  return { id: hash("ltm", { subjectId, memoryKey }), subjectId, memoryKey };
}

export function memoryPayload(
  input: UpsertLongTermMemoryInput,
  policy: LongTermMemoryPolicy,
  createdAt: string,
  status: MemoryStatus = "ACTIVE",
): Readonly<Record<string, PropertyValue>> {
  const identity = memoryIdentity(input);
  if (!MEMORY_CATEGORIES.includes(input.category)) throw new LongTermMemoryError("INVALID_INPUT", `unsupported memory category ${String(input.category)}`);
  if (!MEMORY_SOURCE_KINDS.includes(input.sourceKind)) throw new LongTermMemoryError("INVALID_INPUT", `unsupported memory source kind ${String(input.sourceKind)}`);
  if (!MEMORY_RETENTION_BASES.includes(input.retentionBasis)) throw new LongTermMemoryError("INVALID_INPUT", `unsupported retention basis ${String(input.retentionBasis)}`);
  const sensitivity = input.sensitivity ?? "STANDARD";
  if (!MEMORY_SENSITIVITIES.includes(sensitivity)) throw new LongTermMemoryError("INVALID_INPUT", `unsupported memory sensitivity ${String(sensitivity)}`);
  if (!MEMORY_STATUSES.includes(status)) throw new LongTermMemoryError("INVALID_INPUT", `unsupported memory status ${String(status)}`);
  const observedAt = canonicalUtc(input.observedAt, "observedAt");
  const expiresAt = canonicalUtc(input.expiresAt, "expiresAt");
  const canonicalCreatedAt = canonicalUtc(createdAt, "createdAt");
  const value = assertJsonValue(input.value, "value");
  const sourceRef = nonEmpty(input.sourceRef, "sourceRef");
  const sourceDigest = nonEmpty(input.sourceDigest, "sourceDigest");
  const confidence = effectiveConfidence(input.sourceKind, input.confidence);
  assertSourceCategory(input.sourceKind, input.category);
  assertSafeMemoryValue(value, sensitivity);
  assertPolicyForMemory(policy, sensitivity, input.retentionBasis, input.sourceKind, observedAt, expiresAt);
  const core = {
    subjectId: identity.subjectId,
    memoryKey: identity.memoryKey,
    category: input.category,
    value,
    sourceKind: input.sourceKind,
    sourceRef,
    sourceDigest,
    retentionBasis: input.retentionBasis,
    sensitivity,
    confidence,
    observedAt,
    expiresAt,
    status,
    createdAt: canonicalCreatedAt,
    updatedAt: observedAt,
  };
  return {
    [MP.subjectId]: core.subjectId,
    [MP.memoryKey]: core.memoryKey,
    [MP.category]: core.category,
    [MP.value]: core.value,
    [MP.sourceKind]: core.sourceKind,
    [MP.sourceRef]: core.sourceRef,
    [MP.sourceDigest]: core.sourceDigest,
    [MP.retentionBasis]: core.retentionBasis,
    [MP.sensitivity]: core.sensitivity,
    [MP.confidence]: core.confidence,
    [MP.observedAt]: core.observedAt,
    [MP.expiresAt]: core.expiresAt,
    [MP.status]: core.status,
    [MP.createdAt]: core.createdAt,
    [MP.updatedAt]: core.updatedAt,
    [MP.recordDigest]: hash("ltmrecord", core),
  };
}

export function memoryStatusPayload(record: LongTermMemoryRecord, status: MemoryStatus, updatedAt: string): Readonly<Record<string, PropertyValue>> {
  if (!MEMORY_STATUSES.includes(status)) throw new LongTermMemoryError("INVALID_INPUT", `unsupported memory status ${String(status)}`);
  const time = canonicalUtc(updatedAt, "updatedAt");
  const core = {
    subjectId: record.subjectId,
    memoryKey: record.memoryKey,
    category: record.category,
    value: record.value,
    sourceKind: record.sourceKind,
    sourceRef: record.sourceRef,
    sourceDigest: record.sourceDigest,
    retentionBasis: record.retentionBasis,
    sensitivity: record.sensitivity,
    confidence: record.confidence,
    observedAt: record.observedAt,
    expiresAt: record.expiresAt,
    status,
    createdAt: record.createdAt,
    updatedAt: time,
  };
  return {
    [MP.subjectId]: core.subjectId,
    [MP.memoryKey]: core.memoryKey,
    [MP.category]: core.category,
    [MP.value]: core.value,
    [MP.sourceKind]: core.sourceKind,
    [MP.sourceRef]: core.sourceRef,
    [MP.sourceDigest]: core.sourceDigest,
    [MP.retentionBasis]: core.retentionBasis,
    [MP.sensitivity]: core.sensitivity,
    [MP.confidence]: core.confidence,
    [MP.observedAt]: core.observedAt,
    [MP.expiresAt]: core.expiresAt,
    [MP.status]: core.status,
    [MP.createdAt]: core.createdAt,
    [MP.updatedAt]: core.updatedAt,
    [MP.recordDigest]: hash("ltmrecord", core),
  };
}

export function projectLongTermMemory(record: ObjectRecord, policy: LongTermMemoryPolicy): LongTermMemoryRecord {
  if (record.typeId !== MEMORY_TYPE) throw new LongTermMemoryError("TYPE_MISMATCH", `${record.id} is not a long-term memory record`);
  const subjectId = normalizeIdentifier(stringProperty(record, MP.subjectId), MP.subjectId);
  const memoryKey = normalizeIdentifier(stringProperty(record, MP.memoryKey), MP.memoryKey);
  assertAllowedMemoryKey(memoryKey, true);
  const category = storedEnum(stringProperty(record, MP.category), MEMORY_CATEGORIES, MP.category) as MemoryCategory;
  const sourceKind = storedEnum(stringProperty(record, MP.sourceKind), MEMORY_SOURCE_KINDS, MP.sourceKind) as MemorySourceKind;
  const retentionBasis = storedEnum(stringProperty(record, MP.retentionBasis), MEMORY_RETENTION_BASES, MP.retentionBasis) as MemoryRetentionBasis;
  const sensitivity = storedEnum(stringProperty(record, MP.sensitivity), MEMORY_SENSITIVITIES, MP.sensitivity) as MemorySensitivity;
  const status = storedEnum(stringProperty(record, MP.status), MEMORY_STATUSES, MP.status) as MemoryStatus;
  const observedAt = canonicalUtc(stringProperty(record, MP.observedAt), MP.observedAt);
  const expiresAt = canonicalUtc(stringProperty(record, MP.expiresAt), MP.expiresAt);
  const createdAt = canonicalUtc(stringProperty(record, MP.createdAt), MP.createdAt);
  const updatedAt = canonicalUtc(stringProperty(record, MP.updatedAt), MP.updatedAt);
  const confidence = checkedConfidence(numberProperty(record, MP.confidence), true);
  const value = jsonProperty(record, MP.value);
  assertJsonValue(value, MP.value);
  const sourceRef = stringProperty(record, MP.sourceRef);
  const sourceDigest = stringProperty(record, MP.sourceDigest);
  assertSourceCategory(sourceKind, category, true);
  assertSafeMemoryValue(value, sensitivity, true);
  assertPolicyForMemory(policy, sensitivity, retentionBasis, sourceKind, observedAt, expiresAt, true);
  if (sourceKind === "CUSTOMER_IMPLICIT" && confidence > 0.85) throw new LongTermMemoryError("INTEGRITY_FAILURE", `memory ${record.id} has impossible implicit confidence`);
  if (sourceKind === "SYSTEM_SUMMARY" && confidence > 0.9) throw new LongTermMemoryError("INTEGRITY_FAILURE", `memory ${record.id} has impossible summary confidence`);
  const expectedId = hash("ltm", { subjectId, memoryKey });
  if (record.id !== expectedId) throw new LongTermMemoryError("INTEGRITY_FAILURE", `memory ${record.id} identity digest mismatch`);
  const core = { subjectId, memoryKey, category, value, sourceKind, sourceRef, sourceDigest, retentionBasis, sensitivity, confidence, observedAt, expiresAt, status, createdAt, updatedAt };
  const digest = hash("ltmrecord", core);
  if (stringProperty(record, MP.recordDigest) !== digest) throw new LongTermMemoryError("INTEGRITY_FAILURE", `memory ${record.id} record digest mismatch`);
  return { id: record.id, ...core, digest, revision: record.revision };
}
