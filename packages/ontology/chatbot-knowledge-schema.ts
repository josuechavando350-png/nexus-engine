import { canonicalJson, validateSchema, type OntologyScope, type SchemaVersion, type ValidatedSchema } from "./index.js";
import type { OntologyReadPort, RelationshipQuery } from "./persistence-query.js";
import type { RelationshipRecord, TransactionOperation } from "./transaction.js";

import {
  ENTITY_TYPE,
  EVIDENCE_TYPE,
  FACT_EVIDENCE_REL,
  FACT_OBJECT_REL,
  FACT_SUBJECT_REL,
  FACT_TYPE,
  P,
  KnowledgeGraphError,
  hash,
  type KnowledgeConflict,
  type KnowledgeFact,
  type KnowledgeFactObject,
  type KnowledgeMutationPlan,
} from "./chatbot-knowledge-types.js";

function property(id: string, name: string, valueKind: "STRING" | "NUMBER" | "BOOLEAN" | "DATETIME" | "JSON", cardinality: "REQUIRED" | "OPTIONAL", options: { unique?: boolean; immutable?: boolean } = {}) {
  return { id, name, valueKind, cardinality, unique: options.unique ?? false, immutable: options.immutable ?? false } as const;
}

export function chatbotKnowledgeSchema(scope: OntologyScope): ValidatedSchema {
  const schema: SchemaVersion = {
    version: "chatbot-knowledge-v1", scope,
    properties: [
      property(P.name, "KnowledgeName", "STRING", "REQUIRED"), property(P.aliases, "KnowledgeAliases", "JSON", "REQUIRED"),
      property(P.entityKind, "KnowledgeEntityKind", "STRING", "REQUIRED"), property(P.externalKey, "KnowledgeExternalKey", "STRING", "OPTIONAL", { unique: true }),
      property(P.createdAt, "KnowledgeCreatedAt", "DATETIME", "REQUIRED", { immutable: true }), property(P.updatedAt, "KnowledgeUpdatedAt", "DATETIME", "REQUIRED"),
      property(P.sourceKind, "KnowledgeSourceKind", "STRING", "REQUIRED"), property(P.source, "KnowledgeSource", "STRING", "REQUIRED"),
      property(P.sourceDigest, "KnowledgeSourceDigest", "STRING", "OPTIONAL"), property(P.excerpt, "KnowledgeExcerpt", "STRING", "OPTIONAL"),
      property(P.observedAt, "KnowledgeObservedAt", "DATETIME", "REQUIRED", { immutable: true }), property(P.metadata, "KnowledgeMetadata", "JSON", "REQUIRED"),
      property(P.subjectId, "KnowledgeSubjectId", "STRING", "REQUIRED", { immutable: true }), property(P.predicate, "KnowledgePredicate", "STRING", "REQUIRED", { immutable: true }),
      property(P.objectKind, "KnowledgeObjectKind", "STRING", "REQUIRED", { immutable: true }), property(P.objectEntityId, "KnowledgeObjectEntityId", "STRING", "OPTIONAL", { immutable: true }),
      property(P.objectLiteral, "KnowledgeObjectLiteral", "JSON", "OPTIONAL", { immutable: true }), property(P.evidenceIds, "KnowledgeEvidenceIds", "JSON", "REQUIRED"),
      property(P.confidence, "KnowledgeConfidence", "NUMBER", "REQUIRED"), property(P.validFrom, "KnowledgeValidFrom", "DATETIME", "OPTIONAL"),
      property(P.validUntil, "KnowledgeValidUntil", "DATETIME", "OPTIONAL"), property(P.status, "KnowledgeFactStatus", "STRING", "REQUIRED"),
      property(P.claimClass, "KnowledgeClaimClass", "STRING", "REQUIRED"), property(P.recordDigest, "KnowledgeRecordDigest", "STRING", "REQUIRED"),
    ], interfaces: [],
    objects: [
      { id: ENTITY_TYPE, name: "KnowledgeEntity", propertyIds: [P.name, P.aliases, P.entityKind, P.externalKey, P.createdAt, P.updatedAt, P.recordDigest], interfaceIds: [] },
      { id: EVIDENCE_TYPE, name: "KnowledgeEvidence", propertyIds: [P.sourceKind, P.source, P.sourceDigest, P.excerpt, P.observedAt, P.metadata, P.recordDigest], interfaceIds: [] },
      { id: FACT_TYPE, name: "KnowledgeFact", propertyIds: [P.subjectId, P.predicate, P.objectKind, P.objectEntityId, P.objectLiteral, P.evidenceIds, P.confidence, P.validFrom, P.validUntil, P.status, P.claimClass, P.updatedAt, P.recordDigest], interfaceIds: [] },
    ],
    relationships: [
      { id: FACT_SUBJECT_REL, name: "FactSubject", roles: [{ name: "fact", endpointTypeIds: [FACT_TYPE] }, { name: "entity", endpointTypeIds: [ENTITY_TYPE] }] },
      { id: FACT_OBJECT_REL, name: "FactObject", roles: [{ name: "fact", endpointTypeIds: [FACT_TYPE] }, { name: "entity", endpointTypeIds: [ENTITY_TYPE] }] },
      { id: FACT_EVIDENCE_REL, name: "FactEvidence", roles: [{ name: "fact", endpointTypeIds: [FACT_TYPE] }, { name: "evidence", endpointTypeIds: [EVIDENCE_TYPE] }] },
    ], actions: [], functions: [], events: [],
  };
  return validateSchema(schema);
}

export function relationId(typeId: string, endpoints: Readonly<Record<string, string>>): string {
  return hash("kgrl", { typeId, endpoints: Object.fromEntries(Object.entries(endpoints).sort(([a], [b]) => a.localeCompare(b, "en"))) });
}
export interface ManagedRelationshipSpec { readonly id: string; readonly typeId: string; readonly endpoints: Readonly<Record<string, string>>; }
export function expectedFactRelationships(fact: Pick<KnowledgeFact, "id" | "subjectId" | "object" | "evidenceIds">): readonly ManagedRelationshipSpec[] {
  const specs: ManagedRelationshipSpec[] = [];
  const subject = { fact: fact.id, entity: fact.subjectId };
  specs.push({ id: relationId(FACT_SUBJECT_REL, subject), typeId: FACT_SUBJECT_REL, endpoints: subject });
  if (fact.object.kind === "ENTITY") { const object = { fact: fact.id, entity: fact.object.entityId }; specs.push({ id: relationId(FACT_OBJECT_REL, object), typeId: FACT_OBJECT_REL, endpoints: object }); }
  for (const evidenceId of fact.evidenceIds) { const evidence = { fact: fact.id, evidence: evidenceId }; specs.push({ id: relationId(FACT_EVIDENCE_REL, evidence), typeId: FACT_EVIDENCE_REL, endpoints: evidence }); }
  return specs.sort((a, b) => a.id.localeCompare(b.id, "en"));
}
export const sameFactObject = (a: KnowledgeFactObject, b: KnowledgeFactObject): boolean => canonicalJson(a) === canonicalJson(b);
export const sameEndpoints = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean => canonicalJson(a) === canonicalJson(b);
export function intervalOverlaps(aFrom: string | null, aUntil: string | null, bFrom: string | null, bUntil: string | null): boolean {
  const af = aFrom ? Date.parse(aFrom) : Number.NEGATIVE_INFINITY, au = aUntil ? Date.parse(aUntil) : Number.POSITIVE_INFINITY;
  const bf = bFrom ? Date.parse(bFrom) : Number.NEGATIVE_INFINITY, bu = bUntil ? Date.parse(bUntil) : Number.POSITIVE_INFINITY;
  return af <= bu && bf <= au;
}
export function validAt(fact: KnowledgeFact, at: number): boolean {
  if (fact.status !== "ACTIVE") return false;
  const from = fact.validFrom ? Date.parse(fact.validFrom) : Number.NEGATIVE_INFINITY, until = fact.validUntil ? Date.parse(fact.validUntil) : Number.POSITIVE_INFINITY;
  return at >= from && at <= until;
}
export function detectConflicts(facts: readonly KnowledgeFact[]): KnowledgeConflict[] {
  const result: KnowledgeConflict[] = [];
  for (let i = 0; i < facts.length; i++) for (let j = i + 1; j < facts.length; j++) {
    const left = facts[i]!, right = facts[j]!;
    if (left.status !== "ACTIVE" || right.status !== "ACTIVE" || left.subjectId !== right.subjectId || left.predicate !== right.predicate) continue;
    if (sameFactObject(left.object, right.object) || !intervalOverlaps(left.validFrom, left.validUntil, right.validFrom, right.validUntil)) continue;
    const factIds = [left.id, right.id].sort((a, b) => a.localeCompare(b, "en")); const core = { subjectId: left.subjectId, predicate: left.predicate, factIds, reason: "COMPETING_ACTIVE_VALUES" as const };
    result.push({ ...core, digest: hash("kgconflict", core) });
  }
  return result.sort((a, b) => a.digest.localeCompare(b.digest, "en"));
}

async function collectRelationships(read: OntologyReadPort, scope: OntologyScope, query: RelationshipQuery, maximum = 10_000): Promise<RelationshipRecord[]> {
  const output: RelationshipRecord[] = []; let cursor: string | undefined;
  do { const page = read.queryRelationships(scope, { ...query, limit: Math.min(1000, maximum - output.length), ...(cursor ? { cursor } : {}) }); output.push(...page.items); cursor = page.nextCursor; if (output.length >= maximum && cursor) throw new KnowledgeGraphError("CAPACITY_EXCEEDED", `relationship scan exceeded ${maximum}`); } while (cursor);
  return output;
}
export async function assertFactRelationshipIntegrity(read: OntologyReadPort, scope: OntologyScope, fact: KnowledgeFact): Promise<void> {
  const managed = new Set([FACT_SUBJECT_REL, FACT_OBJECT_REL, FACT_EVIDENCE_REL]);
  const actual = (await collectRelationships(read, scope, { endpointId: fact.id })).filter((r) => managed.has(r.typeId)); const expected = expectedFactRelationships(fact);
  if (actual.length !== expected.length) throw new KnowledgeGraphError("INTEGRITY_FAILURE", `fact ${fact.id} relationship count mismatch`);
  const byId = new Map(actual.map((r) => [r.id, r]));
  for (const spec of expected) { const relation = byId.get(spec.id); if (!relation || relation.typeId !== spec.typeId || !sameEndpoints(relation.endpoints, spec.endpoints)) throw new KnowledgeGraphError("INTEGRITY_FAILURE", `fact ${fact.id} relationship ${spec.id} is missing or malformed`); }
}
export function plan(scope: OntologyScope, schema: ValidatedSchema, operations: readonly TransactionOperation[]): KnowledgeMutationPlan {
  const core = { scope, schemaId: schema.schemaId, requiredPermission: "chatbot.knowledge.write" as const, noop: operations.length === 0, operations };
  return { ...core, digest: hash("kgplan", core) };
}
