import { describe, expect, it } from "vitest";

import type { OntologyScope } from "./index.js";
import { InMemoryOntologyPersistence } from "./persistence-query.js";
import { ENTITY_TYPE, hash, type UpsertKnowledgeEntityInput } from "./chatbot-knowledge-types.js";
import { entityId, entityPayload } from "./chatbot-knowledge-codec.js";
import { LongTermMemoryPlanner } from "./chatbot-memory-planner.js";
import { LongTermMemoryReader } from "./chatbot-memory-reader.js";
import { createDefaultLongTermMemoryPolicy } from "./chatbot-memory-policy.js";
import { MEMORY_TYPE, MP, type MemoryMutationPlan, type UpsertLongTermMemoryInput } from "./chatbot-memory-types.js";

const SCOPE_A: OntologyScope = { tenantId: "tenant:a", organizationId: "org:a", brandId: "brand:a" };
const SCOPE_B: OntologyScope = { tenantId: "tenant:b", organizationId: "org:b", brandId: "brand:b" };
const NOW = "2026-08-30T01:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function addEntity(read: InMemoryOntologyPersistence, scope: OntologyScope, id: string, kind: "PERSON" | "ORGANIZATION" | "SERVICE" = "PERSON"): string {
  const input: UpsertKnowledgeEntityInput = { id, kind, name: id, aliases: [], observedAt: "2026-08-30T00:00:00.000Z" };
  const normalizedId = entityId(input);
  read.upsertObject({ id: normalizedId, typeId: ENTITY_TYPE, scope, properties: entityPayload(input, input.observedAt), revision: 1 });
  return normalizedId;
}

function input(subjectId: string, overrides: Partial<UpsertLongTermMemoryInput> = {}): UpsertLongTermMemoryInput {
  return {
    subjectId,
    memoryKey: "preferred-channel",
    category: "PREFERENCE",
    value: "WhatsApp",
    sourceKind: "CUSTOMER_EXPLICIT",
    sourceRef: "conversation:1:message:1",
    sourceDigest: "sha256:source",
    retentionBasis: "USER_REQUEST",
    sensitivity: "STANDARD",
    confidence: 1,
    observedAt: "2026-08-30T00:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
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
    } else if (operation.kind === "DELETE_OBJECT") read.deleteObject(plan.scope, operation.id);
    else throw new Error(`unexpected operation ${operation.kind}`);
  }
}

describe("long-term memory adversarial audit", () => {
  it("isolates identical customer ids across ontology scopes", () => {
    const read = new InMemoryOntologyPersistence();
    const customerA = addEntity(read, SCOPE_A, "customer:same");
    const customerB = addEntity(read, SCOPE_B, "customer:same");
    const plannerA = new LongTermMemoryPlanner(read, SCOPE_A, createDefaultLongTermMemoryPolicy(), () => NOW_MS);
    apply(read, plannerA.planUpsert(input(customerA, { value: "WhatsApp" })));
    const readerB = new LongTermMemoryReader(read, SCOPE_B, createDefaultLongTermMemoryPolicy(), () => NOW_MS);
    const recalled = readerB.recall({ subjectId: customerB, userMessage: "¿Qué prefiero?" });
    expect(recalled.status).toBe("EMPTY");
    expect(recalled.items).toHaveLength(0);
  });

  it("does not allow a service/business object to masquerade as a customer memory subject", () => {
    const read = new InMemoryOntologyPersistence();
    const service = addEntity(read, SCOPE_A, "service:bot", "SERVICE");
    const planner = new LongTermMemoryPlanner(read, SCOPE_A, createDefaultLongTermMemoryPolicy(), () => NOW_MS);
    expect(() => planner.planUpsert(input(service))).toThrow(/PERSON or ORGANIZATION/i);
  });

  it("rejects secrets and payment-card shaped values even under innocent keys", () => {
    const read = new InMemoryOntologyPersistence();
    const customer = addEntity(read, SCOPE_A, "customer:ana");
    const planner = new LongTermMemoryPlanner(read, SCOPE_A, createDefaultLongTermMemoryPolicy(), () => NOW_MS);
    expect(() => planner.planUpsert(input(customer, { memoryKey: "note", category: "CONTEXT", value: "my password is swordfish" }))).toThrow(/must not be stored/i);
    expect(() => planner.planUpsert(input(customer, { memoryKey: "note", category: "CONTEXT", value: "4111 1111 1111 1111" }))).toThrow(/must not be stored/i);
  });

  it("requires explicit sensitive classification and still denies sensitive retention by default", () => {
    const read = new InMemoryOntologyPersistence();
    const customer = addEntity(read, SCOPE_A, "customer:ana");
    const planner = new LongTermMemoryPlanner(read, SCOPE_A, createDefaultLongTermMemoryPolicy(), () => NOW_MS);
    expect(() => planner.planUpsert(input(customer, { memoryKey: "case-note", category: "CONTEXT", value: "diagnóstico médico", sensitivity: "STANDARD" }))).toThrow(/classified as SENSITIVE/i);
    expect(() => planner.planUpsert(input(customer, { memoryKey: "case-note", category: "CONTEXT", value: "diagnóstico médico", sensitivity: "SENSITIVE" }))).toThrow(/sensitive long-term memory is disabled/i);
  });

  it("prevents summaries and implicit inference from solidifying into authoritative-looking memory categories", () => {
    const read = new InMemoryOntologyPersistence();
    const customer = addEntity(read, SCOPE_A, "customer:ana");
    const planner = new LongTermMemoryPlanner(read, SCOPE_A, createDefaultLongTermMemoryPolicy(), () => NOW_MS);
    expect(() => planner.planUpsert(input(customer, { sourceKind: "SYSTEM_SUMMARY", category: "PREFERENCE", confidence: 0.8 }))).toThrow(/only create CONTEXT or INTERACTION_SUMMARY/i);
    expect(() => planner.planUpsert(input(customer, { sourceKind: "CUSTOMER_IMPLICIT", category: "COMMITMENT", confidence: 0.8 }))).toThrow(/cannot create PROFILE or COMMITMENT/i);
  });

  it("deep-freezes recall output and labels it personalization-only", () => {
    const read = new InMemoryOntologyPersistence();
    const customer = addEntity(read, SCOPE_A, "customer:ana");
    const planner = new LongTermMemoryPlanner(read, SCOPE_A, createDefaultLongTermMemoryPolicy(), () => NOW_MS);
    apply(read, planner.planUpsert(input(customer)));
    const reader = new LongTermMemoryReader(read, SCOPE_A, createDefaultLongTermMemoryPolicy(), () => NOW_MS);
    const recalled = reader.recall({ subjectId: customer, userMessage: "WhatsApp" });
    expect(recalled.authority).toBe("PERSONALIZATION_ONLY");
    expect(Object.isFrozen(recalled)).toBe(true);
    expect(Object.isFrozen(recalled.items)).toBe(true);
    expect(Object.isFrozen(recalled.items[0]?.memory)).toBe(true);
    expect(() => ((recalled.items as unknown as Array<unknown>).push("tamper"))).toThrow(TypeError);
  });

  it("plans bounded physical cleanup for expired and revoked records while preserving active memory", () => {
    const read = new InMemoryOntologyPersistence();
    const customer = addEntity(read, SCOPE_A, "customer:ana");
    const planner = new LongTermMemoryPlanner(read, SCOPE_A, createDefaultLongTermMemoryPolicy(), () => NOW_MS);
    apply(read, planner.planUpsert(input(customer, { memoryKey: "expired", category: "CONTEXT", value: "old", expiresAt: "2026-08-30T00:30:00.000Z" })));
    apply(read, planner.planUpsert(input(customer, { memoryKey: "revoked", category: "CONTEXT", value: "old2" })));
    apply(read, planner.planRevoke({ subjectId: customer, memoryKey: "revoked", observedAt: NOW }));
    apply(read, planner.planUpsert(input(customer, { memoryKey: "active", category: "CONTEXT", value: "current" })));
    const sweep = planner.planRetentionSweep({ subjectId: customer, maxDeletes: 10 });
    expect(sweep.operations.filter((operation) => operation.kind === "DELETE_OBJECT")).toHaveLength(2);
    apply(read, sweep);
    const reader = new LongTermMemoryReader(read, SCOPE_A, createDefaultLongTermMemoryPolicy(), () => NOW_MS);
    const recalled = reader.recall({ subjectId: customer, userMessage: "current" });
    expect(recalled.items.map((item) => item.memory.memoryKey)).toEqual(["active"]);
  });

  it("can purge a legacy forbidden-key memory even after admission policy tightens", () => {
    const read = new InMemoryOntologyPersistence();
    const customer = addEntity(read, SCOPE_A, "customer:ana");
    const memoryKey = "customer-password";
    const observedAt = "2026-08-30T00:00:00.000Z";
    const core = {
      subjectId: customer,
      memoryKey,
      category: "CONTEXT" as const,
      value: "legacy-record",
      sourceKind: "CUSTOMER_EXPLICIT" as const,
      sourceRef: "legacy",
      sourceDigest: "sha256:legacy",
      retentionBasis: "USER_REQUEST" as const,
      sensitivity: "STANDARD" as const,
      confidence: 1,
      observedAt,
      expiresAt: "2026-12-01T00:00:00.000Z",
      status: "ACTIVE" as const,
      createdAt: observedAt,
      updatedAt: observedAt,
    };
    const id = hash("ltm", { subjectId: customer, memoryKey });
    read.upsertObject({
      id,
      typeId: MEMORY_TYPE,
      scope: SCOPE_A,
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
    const planner = new LongTermMemoryPlanner(read, SCOPE_A, createDefaultLongTermMemoryPolicy(), () => NOW_MS);
    const purge = planner.planPurge({ subjectId: customer, memoryKey });
    expect(purge.operations[0]?.kind).toBe("DELETE_OBJECT");
    apply(read, purge);
    expect(read.getObject(SCOPE_A, id)).toBeUndefined();
  });
});
