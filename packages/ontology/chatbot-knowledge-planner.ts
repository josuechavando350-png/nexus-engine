import type { OntologyScope, ValidatedSchema } from "./index.js";
import type { ObjectQuery, OntologyReadPort } from "./persistence-query.js";
import type { ObjectRecord, TransactionOperation } from "./transaction.js";

import {
  CLAIM_CLASSES,
  ENTITY_KINDS,
  ENTITY_TYPE,
  EVIDENCE_KINDS,
  EVIDENCE_TYPE,
  FACT_EVIDENCE_REL,
  FACT_OBJECT_REL,
  FACT_STATUSES,
  FACT_SUBJECT_REL,
  FACT_TYPE,
  P,
  KnowledgeGraphError,
  assertEnum,
  canonicalUtc,
  normalizeIdentifier,
  sortUnique,
  type AddKnowledgeEvidenceInput,
  type KnowledgeFactStatus,
  type KnowledgeMutationPlan,
  type UpsertKnowledgeEntityInput,
  type UpsertKnowledgeFactInput,
} from "./chatbot-knowledge-types.js";
import {
  entityId,
  entityPayload,
  evidenceId,
  evidencePayload,
  factIdentity,
  factPayload,
  projectEntity,
  projectEvidence,
  projectFact,
} from "./chatbot-knowledge-codec.js";
import {
  chatbotKnowledgeSchema,
  expectedFactRelationships,
  intervalOverlaps,
  plan,
  sameEndpoints,
  sameFactObject,
} from "./chatbot-knowledge-schema.js";

async function collectObjects(read: OntologyReadPort, scope: OntologyScope, query: ObjectQuery, maximum = 10_000): Promise<ObjectRecord[]> {
  const output: ObjectRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = read.queryObjects(scope, { ...query, limit: Math.min(1000, maximum - output.length), ...(cursor ? { cursor } : {}) });
    output.push(...page.items);
    cursor = page.nextCursor;
    if (output.length >= maximum && cursor) throw new KnowledgeGraphError("CAPACITY_EXCEEDED", `knowledge scan exceeded ${maximum} objects`);
  } while (cursor);
  return output;
}

export class KnowledgeGraphPlanner {
  readonly schema: ValidatedSchema;

  constructor(private readonly read: OntologyReadPort, readonly scope: OntologyScope) {
    this.schema = chatbotKnowledgeSchema(scope);
  }

  planEntityUpsert(input: UpsertKnowledgeEntityInput): KnowledgeMutationPlan {
    assertEnum(input.kind, ENTITY_KINDS, "entity.kind");
    const id = entityId(input);
    const current = this.read.getObject(this.scope, id);
    if (current && current.typeId !== ENTITY_TYPE) throw new KnowledgeGraphError("TYPE_MISMATCH", `object ${id} already exists with type ${current.typeId}`);
    const createdAt = current ? projectEntity(current).createdAt : canonicalUtc(input.observedAt, "observedAt");
    const properties = entityPayload(input, createdAt);
    const operation: TransactionOperation = current
      ? { kind: "UPDATE_OBJECT", id, expectedRevision: current.revision, properties }
      : { kind: "CREATE_OBJECT", record: { id, typeId: ENTITY_TYPE, scope: this.scope, properties } };
    return plan(this.scope, this.schema, [operation]);
  }

  planEvidenceAdd(input: AddKnowledgeEvidenceInput): KnowledgeMutationPlan {
    assertEnum(input.kind, EVIDENCE_KINDS, "evidence.kind");
    const id = evidenceId(input);
    const properties = evidencePayload(input);
    const current = this.read.getObject(this.scope, id);
    if (!current) return plan(this.scope, this.schema, [{ kind: "CREATE_OBJECT", record: { id, typeId: EVIDENCE_TYPE, scope: this.scope, properties } }]);
    if (current.typeId !== EVIDENCE_TYPE) throw new KnowledgeGraphError("TYPE_MISMATCH", `object ${id} already exists with type ${current.typeId}`);
    const existing = projectEvidence(current);
    const incoming = properties[P.recordDigest];
    if (existing.digest !== incoming) throw new KnowledgeGraphError("CONFLICT", `evidence ${id} is immutable; create new evidence instead of rewriting provenance`);
    return plan(this.scope, this.schema, []);
  }

  async planFactUpsert(input: UpsertKnowledgeFactInput): Promise<KnowledgeMutationPlan> {
    if (input.status) assertEnum(input.status, FACT_STATUSES, "fact.status");
    if (input.claimClass) assertEnum(input.claimClass, CLAIM_CLASSES, "fact.claimClass");
    const identity = factIdentity(input);
    const subject = this.read.getObject(this.scope, identity.subjectId);
    if (!subject) throw new KnowledgeGraphError("NOT_FOUND", `subject entity ${identity.subjectId} does not exist`);
    if (subject.typeId !== ENTITY_TYPE) throw new KnowledgeGraphError("TYPE_MISMATCH", `subject ${identity.subjectId} is not a knowledge entity`);
    projectEntity(subject);

    const evidenceIds = sortUnique(input.evidenceIds.map((id) => normalizeIdentifier(id, "evidenceId")));
    if (!evidenceIds.length) throw new KnowledgeGraphError("INVALID_INPUT", "a knowledge fact requires at least one evidence id");
    for (const id of evidenceIds) {
      const evidence = this.read.getObject(this.scope, id);
      if (!evidence) throw new KnowledgeGraphError("NOT_FOUND", `evidence ${id} does not exist`);
      if (evidence.typeId !== EVIDENCE_TYPE) throw new KnowledgeGraphError("TYPE_MISMATCH", `${id} is not knowledge evidence`);
      projectEvidence(evidence);
    }

    if (identity.object.kind === "ENTITY") {
      const object = this.read.getObject(this.scope, identity.object.entityId);
      if (!object) throw new KnowledgeGraphError("NOT_FOUND", `object entity ${identity.object.entityId} does not exist`);
      if (object.typeId !== ENTITY_TYPE) throw new KnowledgeGraphError("TYPE_MISMATCH", `${identity.object.entityId} is not a knowledge entity`);
      projectEntity(object);
    }

    const normalized: UpsertKnowledgeFactInput = { ...input, id: identity.id, subjectId: identity.subjectId, predicate: identity.predicate, object: identity.object, evidenceIds };
    const properties = factPayload(normalized);
    const validFrom = (properties[P.validFrom] as string | null) ?? null;
    const validUntil = (properties[P.validUntil] as string | null) ?? null;
    const status = properties[P.status] as KnowledgeFactStatus;

    if (status === "ACTIVE") {
      const records = await collectObjects(this.read, this.scope, {
        typeId: FACT_TYPE,
        propertyEquals: { [P.subjectId]: identity.subjectId, [P.predicate]: identity.predicate },
      });
      for (const record of records) {
        if (record.id === identity.id) continue;
        const fact = projectFact(record);
        if (fact.status !== "ACTIVE" || sameFactObject(fact.object, identity.object)) continue;
        if (intervalOverlaps(validFrom, validUntil, fact.validFrom, fact.validUntil)) {
          throw new KnowledgeGraphError("CONFLICT", `active fact ${fact.id} already asserts a different value for ${identity.subjectId}.${identity.predicate} in an overlapping validity window`);
        }
      }
    }

    const current = this.read.getObject(this.scope, identity.id);
    if (current && current.typeId !== FACT_TYPE) throw new KnowledgeGraphError("TYPE_MISMATCH", `object ${identity.id} already exists with type ${current.typeId}`);
    if (current) {
      const existing = projectFact(current);
      if (existing.subjectId !== identity.subjectId || existing.predicate !== identity.predicate || !sameFactObject(existing.object, identity.object)) {
        throw new KnowledgeGraphError("CONFLICT", `fact ${identity.id} identity is immutable; use a new fact id for a different subject, predicate or object`);
      }
    }

    const operations: TransactionOperation[] = [current
      ? { kind: "UPDATE_OBJECT", id: identity.id, expectedRevision: current.revision, properties }
      : { kind: "CREATE_OBJECT", record: { id: identity.id, typeId: FACT_TYPE, scope: this.scope, properties } }];

    const desired = new Map(expectedFactRelationships({ id: identity.id, subjectId: identity.subjectId, object: identity.object, evidenceIds }).map((r) => [r.id, r] as const));
    const existingRelationships = current ? this.read.queryRelationships(this.scope, { endpointId: identity.id, limit: 1000 }).items : [];
    if (existingRelationships.length === 1000) throw new KnowledgeGraphError("CAPACITY_EXCEEDED", `fact ${identity.id} has too many relationships`);
    const managedIds = new Set(existingRelationships
      .filter((r) => [FACT_SUBJECT_REL, FACT_OBJECT_REL, FACT_EVIDENCE_REL].includes(r.typeId))
      .map((r) => r.id));

    for (const relationship of existingRelationships) {
      if (!managedIds.has(relationship.id)) continue;
      const expected = desired.get(relationship.id);
      if (expected && (relationship.typeId !== expected.typeId || !sameEndpoints(relationship.endpoints, expected.endpoints))) {
        throw new KnowledgeGraphError("INTEGRITY_FAILURE", `managed relationship ${relationship.id} is malformed`);
      }
      if (!expected) operations.push({ kind: "DELETE_RELATIONSHIP", id: relationship.id, expectedRevision: relationship.revision });
    }

    for (const [id, relationship] of desired) {
      if (managedIds.has(id)) continue;
      operations.push({ kind: "CREATE_RELATIONSHIP", record: { id, typeId: relationship.typeId, scope: this.scope, endpoints: relationship.endpoints } });
    }
    return plan(this.scope, this.schema, operations);
  }
}
