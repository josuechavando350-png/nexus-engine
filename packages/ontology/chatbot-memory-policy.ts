import { hash } from "./chatbot-knowledge-types.js";
import { LongTermMemoryError, type LongTermMemoryPolicy, type MemorySensitivity } from "./chatbot-memory-types.js";

const DAY = 24 * 60 * 60 * 1000;
const MAX_RECORDS = 10_000;
const MAX_RETENTION = 5 * 365 * DAY;

function positiveInteger(value: number, field: string, maximum: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new LongTermMemoryError("INVALID_INPUT", `${field} must be an integer within 1..${maximum}`);
  }
  return value;
}

function positiveDuration(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_RETENTION) {
    throw new LongTermMemoryError("INVALID_INPUT", `${field} must be a positive duration not greater than ${MAX_RETENTION}`);
  }
  return value;
}

function normalizedPolicy(input: Omit<LongTermMemoryPolicy, "digest">): Omit<LongTermMemoryPolicy, "digest"> {
  const policyId = input.policyId.trim();
  const version = input.version.trim();
  if (!policyId || !version) throw new LongTermMemoryError("INVALID_INPUT", "memory policy id and version must be non-empty");
  if (typeof input.allowSensitive !== "boolean" || typeof input.requireUserRequestForPersonal !== "boolean") {
    throw new LongTermMemoryError("INVALID_INPUT", "memory policy boolean controls are invalid");
  }
  return {
    policyId,
    version,
    maxRecordsPerSubject: positiveInteger(input.maxRecordsPerSubject, "maxRecordsPerSubject", MAX_RECORDS),
    maxStandardAgeMs: positiveDuration(input.maxStandardAgeMs, "maxStandardAgeMs"),
    maxPersonalAgeMs: positiveDuration(input.maxPersonalAgeMs, "maxPersonalAgeMs"),
    maxSensitiveAgeMs: positiveDuration(input.maxSensitiveAgeMs, "maxSensitiveAgeMs"),
    allowSensitive: input.allowSensitive,
    requireUserRequestForPersonal: input.requireUserRequestForPersonal,
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.getOwnPropertyNames(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

export function finalizeLongTermMemoryPolicy(input: Omit<LongTermMemoryPolicy, "digest">): LongTermMemoryPolicy {
  const normalized = normalizedPolicy(input);
  return deepFreeze({ ...normalized, digest: hash("ltmpolicy", normalized) });
}

export function createDefaultLongTermMemoryPolicy(): LongTermMemoryPolicy {
  return finalizeLongTermMemoryPolicy({
    policyId: "nexus.chatbot.long-term-memory.default",
    version: "1.0.0",
    maxRecordsPerSubject: 256,
    maxStandardAgeMs: 365 * DAY,
    maxPersonalAgeMs: 180 * DAY,
    maxSensitiveAgeMs: 30 * DAY,
    allowSensitive: false,
    requireUserRequestForPersonal: true,
  });
}

export function verifyLongTermMemoryPolicy(policy: LongTermMemoryPolicy): void {
  const { digest, ...withoutDigest } = policy;
  const normalized = normalizedPolicy(withoutDigest);
  if (hash("ltmpolicy", normalized) !== digest) throw new LongTermMemoryError("INTEGRITY_FAILURE", "long-term memory policy digest mismatch");
}

export function maximumMemoryAge(policy: LongTermMemoryPolicy, sensitivity: MemorySensitivity): number {
  switch (sensitivity) {
    case "STANDARD": return policy.maxStandardAgeMs;
    case "PERSONAL": return policy.maxPersonalAgeMs;
    case "SENSITIVE": return policy.maxSensitiveAgeMs;
  }
}
