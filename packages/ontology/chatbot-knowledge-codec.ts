import type { ObjectRecord, PropertyValue } from "./transaction.js";

import {
  CLAIM_CLASSES,
  ENTITY_KINDS,
  ENTITY_TYPE,
  EVIDENCE_KINDS,
  EVIDENCE_TYPE,
  FACT_STATUSES,
  FACT_TYPE,
  P,
  KnowledgeGraphError,
  assertJsonValue,
  canonicalUtc,
  checkedConfidence,
  hash,
  nonEmpty,
  normalizeIdentifier,
  normalizePredicate,
  nullableUtc,
  sortUnique,
  type AddKnowledgeEvidenceInput,
  type KnowledgeEntity,
  type KnowledgeEvidence,
  type KnowledgeFact,
  type KnowledgeFactObject,
  type UpsertKnowledgeEntityInput,
  type UpsertKnowledgeFactInput,
} from "./chatbot-knowledge-types.js";

function storedEnum<T extends string>(value: string, values: readonly T[], field: string): T {
  if (!values.includes(value as T)) throw new KnowledgeGraphError("INTEGRITY_FAILURE", `${field} contains unsupported value ${value}`);
  return value as T;
}
function stringProperty(record: ObjectRecord, id: string, optional = false): string | null {
  const value = record.properties[id];
  if ((value === undefined || value === null) && optional) return null;
  if (typeof value !== "string" || !value) throw new KnowledgeGraphError("INTEGRITY_FAILURE", `${record.id}.${id} is not a valid string`);
  return value;
}
function stringArrayProperty(record: ObjectRecord, id: string, allowEmpty: boolean): string[] {
  const value = record.properties[id];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new KnowledgeGraphError("INTEGRITY_FAILURE", `${record.id}.${id} is not a string array`);
  const result = sortUnique(value as string[]);
  if (!allowEmpty && !result.length) throw new KnowledgeGraphError("INTEGRITY_FAILURE", `${record.id}.${id} must not be empty`);
  return result;
}
function numberProperty(record: ObjectRecord, id: string): number {
  const value = record.properties[id];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new KnowledgeGraphError("INTEGRITY_FAILURE", `${record.id}.${id} is not a valid number`);
  return value;
}
function metadataProperty(record: ObjectRecord): Readonly<Record<string, PropertyValue>> {
  const value = record.properties[P.metadata];
  if (value === undefined || value === null) return {};
  if (Array.isArray(value) || typeof value !== "object") throw new KnowledgeGraphError("INTEGRITY_FAILURE", `${record.id}.${P.metadata} is not an object`);
  return value as Readonly<Record<string, PropertyValue>>;
}

export function normalizeFactObject(object: KnowledgeFactObject): KnowledgeFactObject {
  if (object.kind === "ENTITY") return { kind: "ENTITY", entityId: normalizeIdentifier(object.entityId, "object.entityId") };
  if (object.value === undefined) throw new KnowledgeGraphError("INVALID_INPUT", "literal fact object value must not be undefined");
  return { kind: "LITERAL", value: assertJsonValue(object.value, "object.value") };
}

export function entityId(input: UpsertKnowledgeEntityInput): string {
  if (input.id) return normalizeIdentifier(input.id, "entity.id");
  return hash("kge", { kind: input.kind, key: input.externalKey?.trim() ?? input.name.trim().normalize("NFKC").toLowerCase() });
}
export function evidenceId(input: AddKnowledgeEvidenceInput): string {
  if (input.id) return normalizeIdentifier(input.id, "evidence.id");
  return hash("kgev", { kind: input.kind, source: input.source.trim(), sourceDigest: input.sourceDigest ?? null, excerpt: input.excerpt ?? null, observedAt: input.observedAt, metadata: input.metadata ?? {} });
}
export function factIdentity(input: UpsertKnowledgeFactInput): { id: string; subjectId: string; predicate: string; object: KnowledgeFactObject } {
  const subjectId = normalizeIdentifier(input.subjectId, "subjectId");
  const predicate = normalizePredicate(input.predicate);
  const object = normalizeFactObject(input.object);
  return { id: input.id ? normalizeIdentifier(input.id, "fact.id") : hash("kgf", { subjectId, predicate, object }), subjectId, predicate, object };
}

export function entityPayload(input: UpsertKnowledgeEntityInput, createdAt: string): Readonly<Record<string, PropertyValue>> {
  const core = { kind: input.kind, name: nonEmpty(input.name, "name"), aliases: sortUnique(input.aliases ?? []), externalKey: input.externalKey === undefined || input.externalKey === null ? null : nonEmpty(input.externalKey, "externalKey"), createdAt, updatedAt: canonicalUtc(input.observedAt, "observedAt") };
  return { [P.entityKind]: core.kind, [P.name]: core.name, [P.aliases]: core.aliases, [P.externalKey]: core.externalKey, [P.createdAt]: core.createdAt, [P.updatedAt]: core.updatedAt, [P.recordDigest]: hash("kgr", core) };
}
export function evidencePayload(input: AddKnowledgeEvidenceInput): Readonly<Record<string, PropertyValue>> {
  const metadata = input.metadata ?? {};
  for (const [key, value] of Object.entries(metadata)) assertJsonValue(value, `metadata.${key}`);
  const core = { kind: input.kind, source: nonEmpty(input.source, "source"), sourceDigest: input.sourceDigest === undefined || input.sourceDigest === null ? null : nonEmpty(input.sourceDigest, "sourceDigest"), excerpt: input.excerpt === undefined || input.excerpt === null ? null : nonEmpty(input.excerpt, "excerpt"), observedAt: canonicalUtc(input.observedAt, "observedAt"), metadata };
  return { [P.sourceKind]: core.kind, [P.source]: core.source, [P.sourceDigest]: core.sourceDigest, [P.excerpt]: core.excerpt, [P.observedAt]: core.observedAt, [P.metadata]: core.metadata, [P.recordDigest]: hash("kgr", core) };
}
export function factPayload(input: UpsertKnowledgeFactInput): Readonly<Record<string, PropertyValue>> {
  const object = normalizeFactObject(input.object);
  const evidenceIds = sortUnique(input.evidenceIds.map((id) => normalizeIdentifier(id, "evidenceId")));
  if (!evidenceIds.length) throw new KnowledgeGraphError("INVALID_INPUT", "a knowledge fact requires at least one evidence id");
  const validFrom = nullableUtc(input.validFrom, "validFrom"), validUntil = nullableUtc(input.validUntil, "validUntil");
  if (validFrom && validUntil && Date.parse(validFrom) > Date.parse(validUntil)) throw new KnowledgeGraphError("INVALID_INPUT", "validFrom must be before or equal to validUntil");
  const core = { subjectId: normalizeIdentifier(input.subjectId, "subjectId"), predicate: normalizePredicate(input.predicate), object, evidenceIds, confidence: checkedConfidence(input.confidence ?? 1), validFrom, validUntil, status: input.status ?? "ACTIVE", claimClass: input.claimClass ?? "GENERAL", updatedAt: canonicalUtc(input.observedAt, "observedAt") };
  return { [P.subjectId]: core.subjectId, [P.predicate]: core.predicate, [P.objectKind]: core.object.kind, [P.objectEntityId]: core.object.kind === "ENTITY" ? core.object.entityId : null, [P.objectLiteral]: core.object.kind === "LITERAL" ? core.object.value : null, [P.evidenceIds]: core.evidenceIds, [P.confidence]: core.confidence, [P.validFrom]: core.validFrom, [P.validUntil]: core.validUntil, [P.status]: core.status, [P.claimClass]: core.claimClass, [P.updatedAt]: core.updatedAt, [P.recordDigest]: hash("kgr", core) };
}

export function projectEntity(record: ObjectRecord): KnowledgeEntity {
  if (record.typeId !== ENTITY_TYPE) throw new KnowledgeGraphError("TYPE_MISMATCH", `${record.id} is not a knowledge entity`);
  const core = { kind: storedEnum(stringProperty(record, P.entityKind)!, ENTITY_KINDS, P.entityKind), name: stringProperty(record, P.name)!, aliases: stringArrayProperty(record, P.aliases, true), externalKey: stringProperty(record, P.externalKey, true), createdAt: canonicalUtc(stringProperty(record, P.createdAt)!, P.createdAt), updatedAt: canonicalUtc(stringProperty(record, P.updatedAt)!, P.updatedAt) };
  const digest = hash("kgr", core);
  if (stringProperty(record, P.recordDigest)! !== digest) throw new KnowledgeGraphError("INTEGRITY_FAILURE", `entity ${record.id} digest mismatch`);
  return { id: record.id, ...core, digest, revision: record.revision };
}
export function projectEvidence(record: ObjectRecord): KnowledgeEvidence {
  if (record.typeId !== EVIDENCE_TYPE) throw new KnowledgeGraphError("TYPE_MISMATCH", `${record.id} is not knowledge evidence`);
  const core = { kind: storedEnum(stringProperty(record, P.sourceKind)!, EVIDENCE_KINDS, P.sourceKind), source: stringProperty(record, P.source)!, sourceDigest: stringProperty(record, P.sourceDigest, true), excerpt: stringProperty(record, P.excerpt, true), observedAt: canonicalUtc(stringProperty(record, P.observedAt)!, P.observedAt), metadata: metadataProperty(record) };
  const digest = hash("kgr", core);
  if (stringProperty(record, P.recordDigest)! !== digest) throw new KnowledgeGraphError("INTEGRITY_FAILURE", `evidence ${record.id} digest mismatch`);
  return { id: record.id, ...core, digest, revision: record.revision };
}
export function projectFact(record: ObjectRecord): KnowledgeFact {
  if (record.typeId !== FACT_TYPE) throw new KnowledgeGraphError("TYPE_MISMATCH", `${record.id} is not a knowledge fact`);
  const objectKind = stringProperty(record, P.objectKind)!;
  let object: KnowledgeFactObject;
  if (objectKind === "ENTITY") {
    if (record.properties[P.objectLiteral] !== null) throw new KnowledgeGraphError("INTEGRITY_FAILURE", `entity fact ${record.id} contains a literal`);
    object = { kind: "ENTITY", entityId: normalizeIdentifier(stringProperty(record, P.objectEntityId)!, P.objectEntityId) };
  } else if (objectKind === "LITERAL") {
    if (record.properties[P.objectEntityId] !== null || record.properties[P.objectLiteral] === undefined) throw new KnowledgeGraphError("INTEGRITY_FAILURE", `literal fact ${record.id} has malformed object fields`);
    object = { kind: "LITERAL", value: record.properties[P.objectLiteral]! };
  } else throw new KnowledgeGraphError("INTEGRITY_FAILURE", `${record.id}.${P.objectKind} is invalid`);
  const validFrom = stringProperty(record, P.validFrom, true), validUntil = stringProperty(record, P.validUntil, true);
  if (validFrom) canonicalUtc(validFrom, P.validFrom); if (validUntil) canonicalUtc(validUntil, P.validUntil);
  const core = { subjectId: normalizeIdentifier(stringProperty(record, P.subjectId)!, P.subjectId), predicate: normalizePredicate(stringProperty(record, P.predicate)!), object, evidenceIds: stringArrayProperty(record, P.evidenceIds, false).map((id) => normalizeIdentifier(id, "evidenceId")), confidence: checkedConfidence(numberProperty(record, P.confidence), true), validFrom, validUntil, status: storedEnum(stringProperty(record, P.status)!, FACT_STATUSES, P.status), claimClass: storedEnum(stringProperty(record, P.claimClass)!, CLAIM_CLASSES, P.claimClass), updatedAt: canonicalUtc(stringProperty(record, P.updatedAt)!, P.updatedAt) };
  const digest = hash("kgr", core);
  if (stringProperty(record, P.recordDigest)! !== digest) throw new KnowledgeGraphError("INTEGRITY_FAILURE", `fact ${record.id} digest mismatch`);
  return { id: record.id, ...core, digest, revision: record.revision };
}
