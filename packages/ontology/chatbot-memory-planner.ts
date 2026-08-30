import type { OntologyScope, ValidatedSchema } from "./index.js";
import type { OntologyReadPort } from "./persistence-query.js";
import type { TransactionOperation } from "./transaction.js";

import { ENTITY_TYPE } from "./chatbot-knowledge-types.js";
import { projectEntity } from "./chatbot-knowledge-codec.js";
import {
  MEMORY_TYPE,
  MP,
  LongTermMemoryError,
  type LongTermMemoryPolicy,
  type MemoryMutationPlan,
  type PurgeLongTermMemoryInput,
  type RevokeLongTermMemoryInput,
  type UpsertLongTermMemoryInput,
} from "./chatbot-memory-types.js";
import { createDefaultLongTermMemoryPolicy, verifyLongTermMemoryPolicy } from "./chatbot-memory-policy.js";
import { memoryIdentity, memoryPayload, memoryStatusPayload, projectLongTermMemory } from "./chatbot-memory-codec.js";
import { chatbotLongTermMemorySchema, memoryPlan } from "./chatbot-memory-schema.js";

export class LongTermMemoryPlanner {
  readonly schema: ValidatedSchema;

  constructor(
    private readonly read: OntologyReadPort,
    readonly scope: OntologyScope,
    readonly policy: LongTermMemoryPolicy = createDefaultLongTermMemoryPolicy(),
  ) {
    verifyLongTermMemoryPolicy(policy);
    this.schema = chatbotLongTermMemorySchema(scope);
  }

  private assertMemorySubject(subjectId: string): void {
    const subject = this.read.getObject(this.scope, subjectId);
    if (!subject) throw new LongTermMemoryError("NOT_FOUND", `memory subject ${subjectId} does not exist`);
    if (subject.typeId !== ENTITY_TYPE) throw new LongTermMemoryError("TYPE_MISMATCH", `memory subject ${subjectId} is not a knowledge entity`);
    const entity = projectEntity(subject);
    if (entity.kind !== "PERSON" && entity.kind !== "ORGANIZATION") {
      throw new LongTermMemoryError("TYPE_MISMATCH", `memory subject ${subjectId} must be a PERSON or ORGANIZATION knowledge entity`);
    }
  }

  private assertActiveCapacity(subjectId: string, excludingId?: string): void {
    const page = this.read.queryObjects(this.scope, {
      typeId: MEMORY_TYPE,
      propertyEquals: { [MP.subjectId]: subjectId, [MP.status]: "ACTIVE" },
      limit: Math.min(1000, this.policy.maxRecordsPerSubject + 1),
    });
    if (page.nextCursor) throw new LongTermMemoryError("CAPACITY_EXCEEDED", `memory subject ${subjectId} exceeds the configured scan capacity`);
    const count = page.items.filter((item) => item.id !== excludingId).length;
    if (count >= this.policy.maxRecordsPerSubject) {
      throw new LongTermMemoryError("CAPACITY_EXCEEDED", `memory subject ${subjectId} already has ${count} active memories`);
    }
  }

  planUpsert(input: UpsertLongTermMemoryInput): MemoryMutationPlan {
    verifyLongTermMemoryPolicy(this.policy);
    const identity = memoryIdentity(input);
    this.assertMemorySubject(identity.subjectId);
    const current = this.read.getObject(this.scope, identity.id);
    if (current && current.typeId !== MEMORY_TYPE) {
      throw new LongTermMemoryError("TYPE_MISMATCH", `object ${identity.id} already exists with type ${current.typeId}`);
    }

    const existing = current ? projectLongTermMemory(current, this.policy) : undefined;
    if (existing && existing.category !== input.category) {
      throw new LongTermMemoryError("CONFLICT", `memory ${identity.memoryKey} category is immutable; use a different memory key`);
    }
    if (existing && Date.parse(input.observedAt) < Date.parse(existing.updatedAt)) {
      throw new LongTermMemoryError("CONFLICT", `memory ${identity.memoryKey} rejects an older observation over a newer revision`);
    }

    const createdAt = existing?.createdAt ?? input.observedAt;
    const properties = memoryPayload(input, this.policy, createdAt, "ACTIVE");
    const incomingDigest = properties[MP.recordDigest];
    if (existing && existing.digest === incomingDigest) return memoryPlan(this.scope, this.schema, []);
    if (existing && Date.parse(input.observedAt) === Date.parse(existing.updatedAt)) {
      throw new LongTermMemoryError("CONFLICT", `memory ${identity.memoryKey} has a different value at the same observation time`);
    }

    if (!existing || existing.status !== "ACTIVE") this.assertActiveCapacity(identity.subjectId, existing?.id);
    const operation: TransactionOperation = existing
      ? { kind: "UPDATE_OBJECT", id: existing.id, expectedRevision: existing.revision, properties }
      : { kind: "CREATE_OBJECT", record: { id: identity.id, typeId: MEMORY_TYPE, scope: this.scope, properties } };
    return memoryPlan(this.scope, this.schema, [operation]);
  }

  planRevoke(input: RevokeLongTermMemoryInput): MemoryMutationPlan {
    verifyLongTermMemoryPolicy(this.policy);
    const identity = memoryIdentity(input);
    const current = this.read.getObject(this.scope, identity.id);
    if (!current) throw new LongTermMemoryError("NOT_FOUND", `memory ${identity.memoryKey} does not exist`);
    const existing = projectLongTermMemory(current, this.policy);
    if (existing.subjectId !== identity.subjectId || existing.memoryKey !== identity.memoryKey) {
      throw new LongTermMemoryError("INTEGRITY_FAILURE", `memory ${identity.id} identity mismatch`);
    }
    if (existing.status === "REVOKED") return memoryPlan(this.scope, this.schema, []);
    const observedAt = new Date(input.observedAt);
    if (!Number.isFinite(observedAt.getTime()) || observedAt.toISOString() !== input.observedAt) {
      throw new LongTermMemoryError("INVALID_INPUT", "observedAt must be canonical ISO-8601 UTC");
    }
    if (observedAt.getTime() < Date.parse(existing.updatedAt)) {
      throw new LongTermMemoryError("CONFLICT", `memory ${identity.memoryKey} rejects an older revocation over a newer revision`);
    }
    const properties = memoryStatusPayload(existing, "REVOKED", input.observedAt);
    return memoryPlan(this.scope, this.schema, [{ kind: "UPDATE_OBJECT", id: existing.id, expectedRevision: existing.revision, properties }]);
  }

  planPurge(input: PurgeLongTermMemoryInput): MemoryMutationPlan {
    verifyLongTermMemoryPolicy(this.policy);
    const identity = memoryIdentity(input);
    const current = this.read.getObject(this.scope, identity.id);
    if (!current) return memoryPlan(this.scope, this.schema, []);
    const existing = projectLongTermMemory(current, this.policy);
    if (existing.subjectId !== identity.subjectId || existing.memoryKey !== identity.memoryKey) {
      throw new LongTermMemoryError("INTEGRITY_FAILURE", `memory ${identity.id} identity mismatch`);
    }
    return memoryPlan(this.scope, this.schema, [{ kind: "DELETE_OBJECT", id: existing.id, expectedRevision: existing.revision }]);
  }
}
