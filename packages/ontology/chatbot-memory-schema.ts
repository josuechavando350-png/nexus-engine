import { validateSchema, type OntologyScope, type SchemaVersion, type ValidatedSchema } from "./index.js";
import { hash } from "./chatbot-knowledge-types.js";
import { MEMORY_TYPE, MP, type MemoryMutationPlan } from "./chatbot-memory-types.js";
import type { TransactionOperation } from "./transaction.js";

function property(
  id: string,
  name: string,
  valueKind: "STRING" | "NUMBER" | "BOOLEAN" | "DATETIME" | "JSON",
  cardinality: "REQUIRED" | "OPTIONAL",
  options: { unique?: boolean; immutable?: boolean } = {},
) {
  return {
    id,
    name,
    valueKind,
    cardinality,
    unique: options.unique ?? false,
    immutable: options.immutable ?? false,
  } as const;
}

export function chatbotLongTermMemorySchema(scope: OntologyScope): ValidatedSchema {
  const schema: SchemaVersion = {
    version: "chatbot-long-term-memory-v1",
    scope,
    properties: [
      property(MP.subjectId, "MemorySubjectId", "STRING", "REQUIRED", { immutable: true }),
      property(MP.memoryKey, "MemoryKey", "STRING", "REQUIRED", { immutable: true }),
      property(MP.category, "MemoryCategory", "STRING", "REQUIRED", { immutable: true }),
      property(MP.value, "MemoryValue", "JSON", "REQUIRED"),
      property(MP.sourceKind, "MemorySourceKind", "STRING", "REQUIRED"),
      property(MP.sourceRef, "MemorySourceRef", "STRING", "REQUIRED"),
      property(MP.sourceDigest, "MemorySourceDigest", "STRING", "REQUIRED"),
      property(MP.retentionBasis, "MemoryRetentionBasis", "STRING", "REQUIRED"),
      property(MP.sensitivity, "MemorySensitivity", "STRING", "REQUIRED"),
      property(MP.confidence, "MemoryConfidence", "NUMBER", "REQUIRED"),
      property(MP.observedAt, "MemoryObservedAt", "DATETIME", "REQUIRED"),
      property(MP.expiresAt, "MemoryExpiresAt", "DATETIME", "REQUIRED"),
      property(MP.status, "MemoryStatus", "STRING", "REQUIRED"),
      property(MP.createdAt, "MemoryCreatedAt", "DATETIME", "REQUIRED", { immutable: true }),
      property(MP.updatedAt, "MemoryUpdatedAt", "DATETIME", "REQUIRED"),
      property(MP.recordDigest, "MemoryRecordDigest", "STRING", "REQUIRED"),
    ],
    interfaces: [],
    objects: [
      {
        id: MEMORY_TYPE,
        name: "LongTermMemory",
        propertyIds: [
          MP.subjectId,
          MP.memoryKey,
          MP.category,
          MP.value,
          MP.sourceKind,
          MP.sourceRef,
          MP.sourceDigest,
          MP.retentionBasis,
          MP.sensitivity,
          MP.confidence,
          MP.observedAt,
          MP.expiresAt,
          MP.status,
          MP.createdAt,
          MP.updatedAt,
          MP.recordDigest,
        ],
        interfaceIds: [],
      },
    ],
    relationships: [],
    actions: [],
    functions: [],
    events: [],
  };
  return validateSchema(schema);
}

export function memoryPlan(scope: OntologyScope, schema: ValidatedSchema, operations: readonly TransactionOperation[]): MemoryMutationPlan {
  const core = {
    scope,
    schemaId: schema.schemaId,
    requiredPermission: "chatbot.memory.write" as const,
    noop: operations.length === 0,
    operations,
  };
  return { ...core, digest: hash("ltmplan", core) };
}
