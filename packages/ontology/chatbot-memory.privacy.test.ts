import { describe, expect, it } from "vitest";

import type { OntologyScope } from "./index.js";
import { InMemoryOntologyPersistence } from "./persistence-query.js";
import { ENTITY_TYPE, hash, type UpsertKnowledgeEntityInput } from "./chatbot-knowledge-types.js";
import { entityId, entityPayload } from "./chatbot-knowledge-codec.js";
import { LongTermMemoryPlanner } from "./chatbot-memory-planner.js";
import { createDefaultLongTermMemoryPolicy } from "./chatbot-memory-policy.js";
import { MEMORY_TYPE, MP, type MemoryMutationPlan, type UpsertLongTermMemoryInput } from "./chatbot-memory-types.js";

const SCOPE: OntologyScope = { tenantId: "tenant:privacy", organizationId: "org:privacy" };
const NOW = "2026-08-30T01:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function addCustomer(read: InMemoryOntologyPersistence): string {
  const input: UpsertKnowledgeEntityInput = { id: "customer:privacy", kind: "PERSON", name: "Customer", aliases: [], observedAt: "2026-08-30T00:00:00.000Z" };
  const id = entityId(input);
  read.upsertObject({ id, typeId: ENTITY_TYPE, scope: SCOPE, properties: entityPayload(input, input.observedAt), revision: 1 });
  return id;
}

function memory(subjectId: string, key: string, value: string): UpsertLongTermMemoryInput {
  return {
    subjectId,
    memoryKey: key,
    category: "CONTEXT",
    value,
    sourceKind: "CUSTOMER_EXPLICIT",
    sourceRef: `conversation:${key}`,
    sourceDigest: `sha256:${key}`,
    retentionBasis: "USER_REQUEST",
    sensitivity: "STANDARD",
    confidence: 1,
    observedAt: "2026-08-30T00:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
  };
}

function apply(read: InMemoryOntologyPersistence, plan: MemoryMutationPlan): void {
  for (const operation of plan.operations) {
    if (operation.kind === "CREATE_OBJECT") read.upsertObject({ ...operation.record, revision: 1 });
    else if (operation.kind === "UPDATE_OBJECT") {
      const current = read.getObject(plan.scope, operation.id);
      if (!current) throw new Error(`missing ${operation.id}`);
      read.upsertObject({ ...current, properties: operation.properties, revision: current.revision + 1 });
    } else if (operation.kind === "DELETE_OBJECT") read.deleteObject(plan.scope, operation.id);
    else throw new Error(`unexpected operation ${operation.kind}`);
  }
}

describe("long-term memory privacy deletion and migration", () => {
  it("can delete all stored memories for a customer in bounded batches", () => {
    const read = new InMemoryOntologyPersistence();
    const customer = addCustomer(read);
    const planner = new LongTermMemoryPlanner(read, SCOPE, createDefaultLongTermMemoryPolicy(), () => NOW_MS);
    apply(read, planner.planUpsert(memory(customer, "context-a", "A")));
    apply(read, planner.planUpsert(memory(customer, "context-b", "B")));
    apply(read, planner.planUpsert(memory(customer, "context-c", "C")));

    const first = planner.planPurgeSubject({ subjectId: customer, maxDeletes: 2 });
    expect(first.operations).toHaveLength(2);
    apply(read, first);
    const second = planner.planPurgeSubject({ subjectId: customer, maxDeletes: 2 });
    expect(second.operations).toHaveLength(1);
    apply(read, second);
    expect(planner.planPurgeSubject({ subjectId: customer }).noop).toBe(true);
  });

  it("can replace a legacy record that violates the current admission policy with a compliant newer value", () => {
    const read = new InMemoryOntologyPersistence();
    const customer = addCustomer(read);
    const memoryKey = "case-context";
    const id = hash("ltm", { subjectId: customer, memoryKey });
    const core = {
      subjectId: customer,
      memoryKey,
      category: "CONTEXT" as const,
      value: "medical diagnosis",
      sourceKind: "CUSTOMER_EXPLICIT" as const,
      sourceRef: "legacy",
      sourceDigest: "sha256:legacy",
      retentionBasis: "USER_REQUEST" as const,
      sensitivity: "STANDARD" as const,
      confidence: 1,
      observedAt: "2026-08-29T00:00:00.000Z",
      expiresAt: "2026-12-01T00:00:00.000Z",
      status: "ACTIVE" as const,
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
    };
    read.upsertObject({
      id,
      typeId: MEMORY_TYPE,
      scope: SCOPE,
      revision: 1,
      properties: {
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
      },
    });

    const planner = new LongTermMemoryPlanner(read, SCOPE, createDefaultLongTermMemoryPolicy(), () => NOW_MS);
    const replacement = planner.planUpsert({
      ...memory(customer, memoryKey, "customer asked for an appointment"),
      observedAt: NOW,
    });
    expect(replacement.operations[0]?.kind).toBe("UPDATE_OBJECT");
  });
});
