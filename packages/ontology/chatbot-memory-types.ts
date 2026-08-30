import type { OntologyScope } from "./index.js";
import type { PropertyValue, TransactionOperation } from "./transaction.js";

export const MEMORY_TYPE = "chatbot.long_term_memory";
export const MP = Object.freeze({
  subjectId: "chatbot.memory_subject_id",
  memoryKey: "chatbot.memory_key",
  category: "chatbot.memory_category",
  value: "chatbot.memory_value",
  sourceKind: "chatbot.memory_source_kind",
  sourceRef: "chatbot.memory_source_ref",
  sourceDigest: "chatbot.memory_source_digest",
  retentionBasis: "chatbot.memory_retention_basis",
  sensitivity: "chatbot.memory_sensitivity",
  confidence: "chatbot.memory_confidence",
  observedAt: "chatbot.memory_observed_at",
  expiresAt: "chatbot.memory_expires_at",
  status: "chatbot.memory_status",
  createdAt: "chatbot.memory_created_at",
  updatedAt: "chatbot.memory_updated_at",
  recordDigest: "chatbot.memory_record_digest",
});

export const CHATBOT_MEMORY_IDS = Object.freeze({ memoryType: MEMORY_TYPE, properties: MP });

export type MemoryCategory = "PROFILE" | "PREFERENCE" | "GOAL" | "CONTEXT" | "COMMITMENT" | "INTERACTION_SUMMARY";
export type MemorySourceKind = "CUSTOMER_EXPLICIT" | "CUSTOMER_IMPLICIT" | "OPERATOR" | "SYSTEM_SUMMARY";
export type MemoryRetentionBasis = "USER_REQUEST" | "SERVICE_CONTEXT" | "OPERATOR_APPROVED";
export type MemorySensitivity = "STANDARD" | "PERSONAL" | "SENSITIVE";
export type MemoryStatus = "ACTIVE" | "REVOKED";

export interface LongTermMemoryPolicy {
  readonly policyId: string;
  readonly version: string;
  readonly maxRecordsPerSubject: number;
  readonly maxStandardAgeMs: number;
  readonly maxPersonalAgeMs: number;
  readonly maxSensitiveAgeMs: number;
  readonly allowSensitive: boolean;
  readonly requireUserRequestForPersonal: boolean;
  readonly digest: string;
}

export interface LongTermMemoryRecord {
  readonly id: string;
  readonly subjectId: string;
  readonly memoryKey: string;
  readonly category: MemoryCategory;
  readonly value: PropertyValue;
  readonly sourceKind: MemorySourceKind;
  readonly sourceRef: string;
  readonly sourceDigest: string;
  readonly retentionBasis: MemoryRetentionBasis;
  readonly sensitivity: MemorySensitivity;
  readonly confidence: number;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly status: MemoryStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly digest: string;
  readonly revision: number;
}

export interface UpsertLongTermMemoryInput {
  readonly subjectId: string;
  readonly memoryKey: string;
  readonly category: MemoryCategory;
  readonly value: PropertyValue;
  readonly sourceKind: MemorySourceKind;
  readonly sourceRef: string;
  readonly sourceDigest: string;
  readonly retentionBasis: MemoryRetentionBasis;
  readonly sensitivity?: MemorySensitivity;
  readonly confidence?: number;
  readonly observedAt: string;
  readonly expiresAt: string;
}

export interface RevokeLongTermMemoryInput {
  readonly subjectId: string;
  readonly memoryKey: string;
  readonly observedAt: string;
}

export interface PurgeLongTermMemoryInput {
  readonly subjectId: string;
  readonly memoryKey: string;
}

export interface PurgeSubjectLongTermMemoryInput {
  readonly subjectId: string;
  readonly maxDeletes?: number;
}

export interface SweepLongTermMemoryInput {
  readonly subjectId: string;
  readonly maxDeletes?: number;
}

export interface MemoryMutationPlan {
  readonly scope: OntologyScope;
  readonly schemaId: string;
  readonly requiredPermission: "chatbot.memory.write";
  readonly noop: boolean;
  readonly operations: readonly TransactionOperation[];
  readonly digest: string;
}

export interface MemoryRecallRequest {
  readonly subjectId: string;
  readonly userMessage: string;
  readonly maxItems?: number;
}

export interface RecalledMemory {
  readonly memory: LongTermMemoryRecord;
  readonly relevanceScore: number;
}

export interface MemoryRecallContext {
  readonly status: "FOUND" | "EMPTY";
  readonly authority: "PERSONALIZATION_ONLY";
  readonly subjectId: string;
  readonly recalledAt: string;
  readonly policyDigest: string;
  readonly scopeDigest: string;
  readonly items: readonly RecalledMemory[];
  readonly instructions: readonly string[];
  readonly digest: string;
}

export interface MemoryAwareGuardrailRequest {
  readonly businessEntityId: string;
  readonly customerEntityId: string;
  readonly userMessage: string;
  readonly minimumConfidence?: number;
  readonly maxFacts?: number;
  readonly maxMatchedEntities?: number;
  readonly maxMemories?: number;
}

export class LongTermMemoryError extends Error {
  constructor(
    public readonly code:
      | "INVALID_INPUT"
      | "NOT_FOUND"
      | "TYPE_MISMATCH"
      | "CONFLICT"
      | "INTEGRITY_FAILURE"
      | "POLICY_VIOLATION"
      | "CAPACITY_EXCEEDED",
    message: string,
  ) {
    super(message);
    this.name = "LongTermMemoryError";
  }
}

export const MEMORY_CATEGORIES = ["PROFILE", "PREFERENCE", "GOAL", "CONTEXT", "COMMITMENT", "INTERACTION_SUMMARY"] as const satisfies readonly MemoryCategory[];
export const MEMORY_SOURCE_KINDS = ["CUSTOMER_EXPLICIT", "CUSTOMER_IMPLICIT", "OPERATOR", "SYSTEM_SUMMARY"] as const satisfies readonly MemorySourceKind[];
export const MEMORY_RETENTION_BASES = ["USER_REQUEST", "SERVICE_CONTEXT", "OPERATOR_APPROVED"] as const satisfies readonly MemoryRetentionBasis[];
export const MEMORY_SENSITIVITIES = ["STANDARD", "PERSONAL", "SENSITIVE"] as const satisfies readonly MemorySensitivity[];
export const MEMORY_STATUSES = ["ACTIVE", "REVOKED"] as const satisfies readonly MemoryStatus[];
