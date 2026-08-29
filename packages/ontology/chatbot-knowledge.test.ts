import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { canonicalJson, type OntologyScope } from "./index.js";
import {
  InMemoryOntologyPersistence,
  type ObjectQuery,
  type OntologyReadPort,
  type QueryPage,
  type RelationshipQuery,
} from "./persistence-query.js";
import {
  InMemoryOntologyTransactionStore,
  type ObjectRecord,
  type RelationshipRecord,
} from "./transaction.js";
import {
  CHATBOT_KNOWLEDGE_IDS,
  KnowledgeGraphError,
  KnowledgeGraphPlanner,
  KnowledgeGraphReader,
  chatbotKnowledgeSchema,
  type KnowledgeMutationPlan,
} from "./chatbot-knowledge.js";

const scope: OntologyScope = { tenantId: "tenant-a", organizationId: "org-a", brandId: "brand-a" };
const T0 = "2026-08-29T12:00:00.000Z";
const T1 = "2026-08-30T12:00:00.000Z";

class Harness implements OntologyReadPort {
  private readonly tx = new InMemoryOntologyTransactionStore();
  private persistence = new InMemoryOntologyPersistence();
  readonly schema = chatbotKnowledgeSchema(scope);

  getObject(requestScope: OntologyScope, id: string): ObjectRecord | undefined { return this.persistence.getObject(requestScope, id); }
  getRelationship(requestScope: OntologyScope, id: string): RelationshipRecord | undefined { return this.persistence.getRelationship(requestScope, id); }
  queryObjects(requestScope: OntologyScope, query?: ObjectQuery): QueryPage<ObjectRecord> { return this.persistence.queryObjects(requestScope, query); }
  queryRelationships(requestScope: OntologyScope, query?: RelationshipQuery): QueryPage<RelationshipRecord> { return this.persistence.queryRelationships(requestScope, query); }

  apply(plan: KnowledgeMutationPlan): void {
    expect(plan.schemaId).toBe(this.schema.schemaId);
    if (plan.noop) return;
    this.tx.transact(scope, this.schema, plan.operations);
    const checkpoint = this.tx.checkpoint();
    const next = new InMemoryOntologyPersistence();
    for (const object of checkpoint.objects) next.upsertObject(object);
    for (const relationship of checkpoint.relationships) next.upsertRelationship(relationship);
    this.persistence = next;
  }

  unsafeObject(record: ObjectRecord): void { this.persistence.upsertObject(record); }
  unsafeRelationship(record: RelationshipRecord): void { this.persistence.upsertRelationship(record); }
  unsafeDeleteRelationship(id: string): void { this.persistence.deleteRelationship(scope, id); }
}

async function baseGraph() {
  const harness = new Harness();
  const planner = new KnowledgeGraphPlanner(harness, scope);
  const reader = new KnowledgeGraphReader(harness, scope);
  harness.apply(planner.planEntityUpsert({
    id: "business:nexus", kind: "ORGANIZATION", name: "NEXUS Bot Studio",
    aliases: ["NEXUS", "Nexus Bot"], externalKey: "nexus-bot-studio", observedAt: T0,
  }));
  return { harness, planner, reader };
}

function addEvidence(harness: Harness, planner: KnowledgeGraphPlanner, id = "evidence:catalog"): string {
  harness.apply(planner.planEvidenceAdd({
    id, kind: "FIRST_PARTY", source: "client-approved-catalog", sourceDigest: "sha256:catalog-v1",
    excerpt: "Approved catalog facts", observedAt: T0, metadata: { owner: "client" },
  }));
  return id;
}

function relationshipId(typeId: string, endpoints: Readonly<Record<string, string>>): string {
  const canonical = { typeId, endpoints: Object.fromEntries(Object.entries(endpoints).sort(([a], [b]) => a.localeCompare(b, "en"))) };
  return `kgrl_${createHash("sha256").update(canonicalJson(canonical), "utf8").digest("hex")}`;
}

describe("chatbot knowledge graph", () => {
  it("builds a deterministic schema on the existing ontology kernel", () => {
    const a = chatbotKnowledgeSchema(scope), b = chatbotKnowledgeSchema(scope);
    expect(a.schemaId).toBe(b.schemaId);
    expect(a.objects.map((item) => item.id)).toEqual([
      CHATBOT_KNOWLEDGE_IDS.entityType, CHATBOT_KNOWLEDGE_IDS.evidenceType, CHATBOT_KNOWLEDGE_IDS.factType,
    ]);
  });

  it("creates and updates canonical entities without a parallel store", async () => {
    const { harness, planner, reader } = await baseGraph();
    expect(reader.entity("business:nexus")?.revision).toBe(1);
    harness.apply(planner.planEntityUpsert({
      id: "business:nexus", kind: "ORGANIZATION", name: "NEXUS Bot Studio",
      aliases: ["NEXUS", "Nexus Bot", "NEXUS AI"], externalKey: "nexus-bot-studio", observedAt: T1,
    }));
    const updated = reader.entity("business:nexus");
    expect(updated?.aliases).toContain("NEXUS AI");
    expect(updated?.createdAt).toBe(T0);
    expect(updated?.revision).toBe(2);
  });

  it("keeps provenance immutable and makes identical evidence a no-op", async () => {
    const { harness, planner } = await baseGraph();
    const id = addEvidence(harness, planner);
    const same = planner.planEvidenceAdd({
      id, kind: "FIRST_PARTY", source: "client-approved-catalog", sourceDigest: "sha256:catalog-v1",
      excerpt: "Approved catalog facts", observedAt: T0, metadata: { owner: "client" },
    });
    expect(same.noop).toBe(true);
    expect(() => planner.planEvidenceAdd({ id, kind: "FIRST_PARTY", source: "rewritten", sourceDigest: "sha256:v2", observedAt: T0 })).toThrow(/immutable/i);
  });

  it("requires real subject/evidence and rejects non-finite knowledge", async () => {
    const { harness, planner } = await baseGraph();
    await expect(planner.planFactUpsert({
      subjectId: "business:missing", predicate: "offers", object: { kind: "LITERAL", value: "Chatbot" },
      evidenceIds: ["evidence:missing"], observedAt: T0,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const evidenceId = addEvidence(harness, planner);
    await expect(planner.planFactUpsert({
      id: "fact:bad", subjectId: "business:nexus", predicate: "bad", object: { kind: "LITERAL", value: Number.POSITIVE_INFINITY },
      evidenceIds: [evidenceId], observedAt: T0,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("creates graph-native subject/object/evidence relationships", async () => {
    const { harness, planner } = await baseGraph();
    const evidenceId = addEvidence(harness, planner);
    harness.apply(planner.planEntityUpsert({ id: "service:chatbot", kind: "SERVICE", name: "Chatbot empresarial", aliases: ["asistente virtual"], observedAt: T0 }));
    harness.apply(await planner.planFactUpsert({
      id: "fact:nexus-offers-chatbot", subjectId: "business:nexus", predicate: "offers",
      object: { kind: "ENTITY", entityId: "service:chatbot" }, evidenceIds: [evidenceId], observedAt: T0,
    }));
    const relationships = harness.queryRelationships(scope, { endpointId: "fact:nexus-offers-chatbot", limit: 100 }).items;
    expect(new Set(relationships.map((item) => item.typeId))).toEqual(new Set([
      CHATBOT_KNOWLEDGE_IDS.factSubjectRelationship,
      CHATBOT_KNOWLEDGE_IDS.factObjectRelationship,
      CHATBOT_KNOWLEDGE_IDS.factEvidenceRelationship,
    ]));
  });

  it("grounds commercial answers in exact facts/evidence", async () => {
    const { harness, planner, reader } = await baseGraph();
    const evidenceId = addEvidence(harness, planner);
    harness.apply(planner.planEntityUpsert({ id: "service:chatbot", kind: "SERVICE", name: "Chatbot empresarial", aliases: ["chatbot", "bot de ventas"], observedAt: T0 }));
    harness.apply(await planner.planFactUpsert({
      id: "fact:chatbot-price", subjectId: "service:chatbot", predicate: "base-price-mxn",
      object: { kind: "LITERAL", value: 3500 }, evidenceIds: [evidenceId], confidence: 1,
      claimClass: "PRICE", validFrom: T0, observedAt: T0,
    }));
    const context = await reader.grounding({ businessEntityId: "business:nexus", userMessage: "¿Cuál es el precio del chatbot?", at: T1 });
    expect(context.status).toBe("SUPPORTED");
    expect(context.facts.some((fact) => fact.displayValue === "3500" && fact.claimClass === "PRICE")).toBe(true);
    expect(context.evidence.map((item) => item.id)).toContain(evidenceId);
  });

  it("blocks overlapping competing truth but permits non-overlapping history", async () => {
    const { harness, planner, reader } = await baseGraph();
    const evidenceId = addEvidence(harness, planner);
    harness.apply(await planner.planFactUpsert({
      id: "fact:old", subjectId: "business:nexus", predicate: "base-price-mxn", object: { kind: "LITERAL", value: 2000 },
      evidenceIds: [evidenceId], claimClass: "PRICE", validFrom: "2026-01-01T00:00:00.000Z", validUntil: "2026-06-30T23:59:59.000Z", observedAt: T0,
    }));
    harness.apply(await planner.planFactUpsert({
      id: "fact:current", subjectId: "business:nexus", predicate: "base-price-mxn", object: { kind: "LITERAL", value: 3500 },
      evidenceIds: [evidenceId], claimClass: "PRICE", validFrom: "2026-07-01T00:00:00.000Z", observedAt: T1,
    }));
    await expect(planner.planFactUpsert({
      id: "fact:conflict", subjectId: "business:nexus", predicate: "base-price-mxn", object: { kind: "LITERAL", value: 9999 },
      evidenceIds: [evidenceId], claimClass: "PRICE", validFrom: "2026-07-01T00:00:00.000Z", observedAt: T1,
    })).rejects.toMatchObject({ code: "CONFLICT" });
    const result = await reader.queryFacts({ subjectId: "business:nexus", predicate: "base-price-mxn", at: T1 });
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]?.object).toEqual({ kind: "LITERAL", value: 3500 });
  });

  it("never repurposes an existing fact id for a different truth", async () => {
    const { harness, planner } = await baseGraph();
    const evidenceId = addEvidence(harness, planner);
    harness.apply(await planner.planFactUpsert({
      id: "fact:stable", subjectId: "business:nexus", predicate: "availability",
      object: { kind: "LITERAL", value: "AVAILABLE" }, evidenceIds: [evidenceId], claimClass: "AVAILABILITY", observedAt: T0,
    }));
    await expect(planner.planFactUpsert({
      id: "fact:stable", subjectId: "business:nexus", predicate: "availability",
      object: { kind: "LITERAL", value: "UNAVAILABLE" }, evidenceIds: [evidenceId], claimClass: "AVAILABILITY", observedAt: T1,
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("detects pre-existing conflicting truth on read", async () => {
    const { harness, planner, reader } = await baseGraph();
    const evidenceId = addEvidence(harness, planner);
    harness.apply(await planner.planFactUpsert({
      id: "fact:a", subjectId: "business:nexus", predicate: "availability", object: { kind: "LITERAL", value: "AVAILABLE" },
      evidenceIds: [evidenceId], claimClass: "AVAILABILITY", observedAt: T0,
    }));
    const first = harness.getObject(scope, "fact:a")!;
    const p = CHATBOT_KNOWLEDGE_IDS.properties;
    const core = { subjectId: "business:nexus", predicate: "availability", object: { kind: "LITERAL", value: "UNAVAILABLE" }, evidenceIds: [evidenceId], confidence: 1, validFrom: null, validUntil: null, status: "ACTIVE", claimClass: "AVAILABILITY", updatedAt: T0 };
    const digest = `kgr_${createHash("sha256").update(canonicalJson(core), "utf8").digest("hex")}`;
    harness.unsafeObject({ ...first, id: "fact:b", revision: 1, properties: { ...first.properties, [p.objectLiteral]: "UNAVAILABLE", [p.recordDigest]: digest } });
    const subjectEndpoints = { fact: "fact:b", entity: "business:nexus" };
    const evidenceEndpoints = { fact: "fact:b", evidence: evidenceId };
    harness.unsafeRelationship({ id: relationshipId(CHATBOT_KNOWLEDGE_IDS.factSubjectRelationship, subjectEndpoints), typeId: CHATBOT_KNOWLEDGE_IDS.factSubjectRelationship, scope, endpoints: subjectEndpoints, revision: 1 });
    harness.unsafeRelationship({ id: relationshipId(CHATBOT_KNOWLEDGE_IDS.factEvidenceRelationship, evidenceEndpoints), typeId: CHATBOT_KNOWLEDGE_IDS.factEvidenceRelationship, scope, endpoints: evidenceEndpoints, revision: 1 });
    const result = await reader.queryFacts({ subjectId: "business:nexus", predicate: "availability", at: T1 });
    expect(result.conflicts).toHaveLength(1);
  });

  it("fails closed on object or relationship integrity drift", async () => {
    const { harness, planner, reader } = await baseGraph();
    const evidenceId = addEvidence(harness, planner);
    harness.apply(await planner.planFactUpsert({
      id: "fact:contact", subjectId: "business:nexus", predicate: "contact-phone", object: { kind: "LITERAL", value: "+52 312 000 0000" },
      evidenceIds: [evidenceId], claimClass: "CONTACT", observedAt: T0,
    }));
    const relationships = harness.queryRelationships(scope, { endpointId: "fact:contact", limit: 100 }).items;
    harness.unsafeDeleteRelationship(relationships[0]!.id);
    await expect(reader.queryFacts({ subjectId: "business:nexus", at: T1 })).rejects.toMatchObject({ code: "INTEGRITY_FAILURE" });

    const business = harness.getObject(scope, "business:nexus")!;
    harness.unsafeObject({ ...business, properties: { ...business.properties, [CHATBOT_KNOWLEDGE_IDS.properties.name]: "TAMPERED" } });
    expect(() => reader.entity("business:nexus")).toThrow(KnowledgeGraphError);
  });

  it("keeps unrelated requests unsupported even if other facts exist", async () => {
    const { harness, planner, reader } = await baseGraph();
    const evidenceId = addEvidence(harness, planner);
    harness.apply(await planner.planFactUpsert({
      id: "fact:phone", subjectId: "business:nexus", predicate: "contact-phone", object: { kind: "LITERAL", value: "+52 312 000 0000" },
      evidenceIds: [evidenceId], claimClass: "CONTACT", observedAt: T0,
    }));
    const context = await reader.grounding({ businessEntityId: "business:nexus", userMessage: "¿Me garantizas triplicar mis ventas mañana?", at: T1 });
    expect(context.status).toBe("UNSUPPORTED");
    expect(context.facts).toHaveLength(0);
    expect(context.instructions.join(" ")).toMatch(/Do not invent/i);
  });
});
