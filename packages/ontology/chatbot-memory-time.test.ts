import { describe, expect, it } from "vitest";

import type { OntologyScope } from "./index.js";
import { InMemoryOntologyPersistence } from "./persistence-query.js";
import { entityId, entityPayload } from "./chatbot-knowledge-codec.js";
import { ENTITY_TYPE, type UpsertKnowledgeEntityInput } from "./chatbot-knowledge-types.js";
import { LongTermMemoryPlanner } from "./chatbot-memory-planner.js";
import { createDefaultLongTermMemoryPolicy } from "./chatbot-memory-policy.js";
import type { MemoryMutationPlan, UpsertLongTermMemoryInput } from "./chatbot-memory-types.js";

const SCOPE: OntologyScope = { tenantId: "tenant:time", organizationId: "org:time" };
const NOW = "2026-08-30T01:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function customer(read: InMemoryOntologyPersistence): string {
  const input: UpsertKnowledgeEntityInput = { id: "customer:time", kind: "PERSON", name: "Customer", aliases: [], observedAt: "2026-08-30T00:00:00.000Z" };
  const id = entityId(input);
  read.upsertObject({ id, typeId: ENTITY_TYPE, scope: SCOPE, properties: entityPayload(input, input.observedAt), revision: 1 });
  return id;
}

function input(subjectId: string, overrides: Partial<UpsertLongTermMemoryInput> = {}): UpsertLongTermMemoryInput {
  return {
    subjectId,
    memoryKey: "time-context",
    category: "CONTEXT",
    value: "asked for a callback",
    sourceKind: "CUSTOMER_EXPLICIT",
    sourceRef: "conversation:time",
    sourceDigest: "sha256:time",
    retentionBasis: "USER_REQUEST",
    sensitivity: "STANDARD",
    confidence: 1,
    observedAt: "2026-08-30T00:00:00.000Z",
    expiresAt: "2026-09-30T00:00:00.000Z",
    ...overrides,
  };
}

function apply(read: InMemoryOntologyPersistence, plan: MemoryMutationPlan): void {
  for (const operation of plan.operations) {
    if (operation.kind === "CREATE_OBJECT") read.upsertObject({ ...operation.record, revision: 1 });
    else if (operation.kind === "UPDATE_OBJECT") {
      const current = read.getObject(plan.scope, operation.id);
      if (!current) throw new Error(`missing ${operation.id}`);
      read.upsertObject({ ...current, properties: operation.properties, revision: current.revision + 1 });
    } else throw new Error(`unexpected operation ${operation.kind}`);
  }
}

describe("long-term memory clock integrity", () => {
  it("rejects future-dated observations and already-expired active writes", () => {
    const read = new InMemoryOntologyPersistence();
    const id = customer(read);
    const planner = new LongTermMemoryPlanner(read, SCOPE, createDefaultLongTermMemoryPolicy(), () => NOW_MS);
    expect(() => planner.planUpsert(input(id, { observedAt: "2026-08-30T02:00:00.000Z", expiresAt: "2026-09-30T02:00:00.000Z" }))).toThrow(/future observation/i);
    expect(() => planner.planUpsert(input(id, { observedAt: "2026-08-29T00:00:00.000Z", expiresAt: "2026-08-30T00:30:00.000Z" }))).toThrow(/after its expiry/i);
  });

  it("rejects a future-dated revocation instead of applying it immediately", () => {
    const read = new InMemoryOntologyPersistence();
    const id = customer(read);
    const planner = new LongTermMemoryPlanner(read, SCOPE, createDefaultLongTermMemoryPolicy(), () => NOW_MS);
    apply(read, planner.planUpsert(input(id)));
    expect(() => planner.planRevoke({ subjectId: id, memoryKey: "time-context", observedAt: "2026-08-30T02:00:00.000Z" })).toThrow(/future observation/i);
  });
});
