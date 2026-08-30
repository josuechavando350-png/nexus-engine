import type { OntologyScope, ValidatedSchema } from "./index.js";
import type { ObjectQuery, OntologyReadPort } from "./persistence-query.js";
import type { ObjectRecord, TransactionOperation } from "./transaction.js";

import { ENTITY_TYPE, normalizeIdentifier } from "./chatbot-knowledge-types.js";
import { projectEntity } from "./chatbot-knowledge-codec.js";
import {
  MEMORY_TYPE,
  MP,
  LongTermMemoryError,
  type LongTermMemoryPolicy,
  type MemoryMutationPlan,
  type PurgeLongTermMemoryInput,
  type PurgeSubjectLongTermMemoryInput,
  type RevokeLongTermMemoryInput,
  type SweepLongTermMemoryInput,
  type UpsertLongTermMemoryInput,
} from "./chatbot-memory-types.js";
import { createDefaultLongTermMemoryPolicy, verifyLongTermMemoryPolicy } from "./chatbot-memory-policy.js";
import { memoryDeletionIdentity, memoryIdentity, memoryPayload, memoryStatusPayload, projectLongTermMemory } from "./chatbot-memory-codec.js";
import { chatbotLongTermMemorySchema, memoryPlan } from "./chatbot-memory-schema.js";

const MAX_SWEEP_SCAN = 10_000;
const MAX_SWEEP_DELETE = 1_000;

function collectObjects(read: OntologyReadPort, scope: OntologyScope, query: ObjectQuery, maximum: number): ObjectRecord[] {
  const output: ObjectRecord[] = [];
  let cursor: string | undefined;
  do {
    const remaining = maximum + 1 - output.length;
    if (remaining <= 0) throw new LongTermMemoryError("CAPACITY_EXCEEDED", `memory scan exceeded ${maximum} records`);
    const page = read.queryObjects(scope, { ...query, limit: Math.min(1000, remaining), ...(cursor ? { cursor } : {}) });
    output.push(...page.items);
    cursor = page.nextCursor;
    if (output.length > maximum || (output.length === maximum && cursor)) {
      throw new LongTermMemoryError("CAPACITY_EXCEEDED", `memory scan exceeded ${maximum} records`);
    }
  } while (cursor);
  return output;
}

function deleteLimit(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0 || resolved > MAX_SWEEP_DELETE) {
    throw new LongTermMemoryError("INVALID_INPUT", `maxDeletes must be an integer from 1 to ${MAX_SWEEP_DELETE}`);
  }
  return resolved;
}

export class LongTermMemoryPlanner {
  readonly schema: ValidatedSchema;

  constructor(
    private readonly read: OntologyReadPort,
    readonly scope: OntologyScope,
    readonly policy: LongTermMemoryPolicy = createDefaultLongTermMemoryPolicy(),
    private readonly now: () => number = Date.now,
  ) {
    verifyLongTermMemoryPolicy(policy);
    this.schema = chatbotLongTermMemorySchema(scope);
  }

  private currentTime(): number {
    const nowMs = this.now();
    if (!Number.isFinite(nowMs) || nowMs < 0) throw new LongTermMemoryError("INTEGRITY_FAILURE", "long-term memory planner clock returned an invalid timestamp");
    return nowMs;
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
    const nowMs = this.currentTime();
    const records = collectObjects(this.read, this.scope, {
      typeId: MEMORY_TYPE,
      propertyEquals: { [MP.subjectId]: subjectId, [MP.status]: "ACTIVE" },
    }, MAX_SWEEP_SCAN);
    const active = records
      .filter((item) => item.id !== excludingId)
      .map((item) => projectLongTermMemory(item, this.policy, false))
      .filter((memory) => Date.parse(memory.expiresAt) > nowMs)
      .length;
    if (active >= this.policy.maxRecordsPerSubject) {
      throw new LongTermMemoryError("CAPACITY_EXCEEDED", `memory subject ${subjectId} already has ${active} active memories`);
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

    const existing = current ? projectLongTermMemory(current, this.policy, false) : undefined;
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

    if (!existing || existing.status !== "ACTIVE" || Date.parse(existing.expiresAt) <= this.currentTime()) {
      this.assertActiveCapacity(identity.subjectId, existing?.id);
    }
    const operation: TransactionOperation = existing
      ? { kind: "UPDATE_OBJECT", id: existing.id, expectedRevision: existing.revision, properties }
      : { kind: "CREATE_OBJECT", record: { id: identity.id, typeId: MEMORY_TYPE, scope: this.scope, properties } };
    return memoryPlan(this.scope, this.schema, [operation]);
  }

  planRevoke(input: RevokeLongTermMemoryInput): MemoryMutationPlan {
    verifyLongTermMemoryPolicy(this.policy);
    const identity = memoryDeletionIdentity(input);
    const current = this.read.getObject(this.scope, identity.id);
    if (!current) throw new LongTermMemoryError("NOT_FOUND", `memory ${identity.memoryKey} does not exist`);
    const existing = projectLongTermMemory(current, this.policy, false);
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
    const identity = memoryDeletionIdentity(input);
    const current = this.read.getObject(this.scope, identity.id);
    if (!current) return memoryPlan(this.scope, this.schema, []);
    if (current.typeId !== MEMORY_TYPE) throw new LongTermMemoryError("TYPE_MISMATCH", `object ${identity.id} is not a long-term memory record`);
    return memoryPlan(this.scope, this.schema, [{ kind: "DELETE_OBJECT", id: current.id, expectedRevision: current.revision }]);
  }

  planPurgeSubject(input: PurgeSubjectLongTermMemoryInput): MemoryMutationPlan {
    verifyLongTermMemoryPolicy(this.policy);
    const subjectId = normalizeIdentifier(input.subjectId, "subjectId");
    const maxDeletes = deleteLimit(input.maxDeletes, MAX_SWEEP_DELETE);
    const page = this.read.queryObjects(this.scope, {
      typeId: MEMORY_TYPE,
      propertyEquals: { [MP.subjectId]: subjectId },
      limit: maxDeletes,
    });
    const deletions = [...page.items]
      .sort((a, b) => a.id.localeCompare(b.id, "en"))
      .map((record): TransactionOperation => ({ kind: "DELETE_OBJECT", id: record.id, expectedRevision: record.revision }));
    return memoryPlan(this.scope, this.schema, deletions);
  }

  planRetentionSweep(input: SweepLongTermMemoryInput): MemoryMutationPlan {
    verifyLongTermMemoryPolicy(this.policy);
    const subjectId = normalizeIdentifier(input.subjectId, "subjectId");
    const maxDeletes = deleteLimit(input.maxDeletes, 100);
    const nowMs = this.currentTime();
    const records = collectObjects(this.read, this.scope, {
      typeId: MEMORY_TYPE,
      propertyEquals: { [MP.subjectId]: subjectId },
    }, MAX_SWEEP_SCAN);
    const deletions = records
      .map((record) => projectLongTermMemory(record, this.policy, false))
      .filter((memory) => memory.status === "REVOKED" || Date.parse(memory.expiresAt) <= nowMs)
      .sort((a, b) => a.id.localeCompare(b.id, "en"))
      .slice(0, maxDeletes)
      .map((memory): TransactionOperation => ({ kind: "DELETE_OBJECT", id: memory.id, expectedRevision: memory.revision }));
    return memoryPlan(this.scope, this.schema, deletions);
  }
}
