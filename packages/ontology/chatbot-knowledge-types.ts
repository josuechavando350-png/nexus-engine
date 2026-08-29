import { createHash } from "node:crypto";
import { canonicalJson, type OntologyScope } from "./index.js";
import type { PropertyValue, TransactionOperation } from "./transaction.js";

export const ENTITY_TYPE = "chatbot.knowledge_entity";
export const EVIDENCE_TYPE = "chatbot.knowledge_evidence";
export const FACT_TYPE = "chatbot.knowledge_fact";
export const FACT_SUBJECT_REL = "chatbot.fact_subject";
export const FACT_OBJECT_REL = "chatbot.fact_object";
export const FACT_EVIDENCE_REL = "chatbot.fact_evidence";
export const P = Object.freeze({
  name: "chatbot.name", aliases: "chatbot.aliases", entityKind: "chatbot.entity_kind", externalKey: "chatbot.external_key",
  createdAt: "chatbot.created_at", updatedAt: "chatbot.updated_at", sourceKind: "chatbot.source_kind", source: "chatbot.source",
  sourceDigest: "chatbot.source_digest", excerpt: "chatbot.excerpt", observedAt: "chatbot.observed_at", metadata: "chatbot.metadata",
  subjectId: "chatbot.subject_id", predicate: "chatbot.predicate", objectKind: "chatbot.object_kind", objectEntityId: "chatbot.object_entity_id",
  objectLiteral: "chatbot.object_literal", evidenceIds: "chatbot.evidence_ids", confidence: "chatbot.confidence", validFrom: "chatbot.valid_from",
  validUntil: "chatbot.valid_until", status: "chatbot.status", claimClass: "chatbot.claim_class", recordDigest: "chatbot.record_digest",
});
export const CHATBOT_KNOWLEDGE_IDS = Object.freeze({ entityType: ENTITY_TYPE, evidenceType: EVIDENCE_TYPE, factType: FACT_TYPE,
  factSubjectRelationship: FACT_SUBJECT_REL, factObjectRelationship: FACT_OBJECT_REL, factEvidenceRelationship: FACT_EVIDENCE_REL, properties: P });

export type KnowledgeEntityKind = "ORGANIZATION" | "PERSON" | "SERVICE" | "PRODUCT" | "LOCATION" | "POLICY" | "PRICE" | "SCHEDULE" | "FAQ" | "CONCEPT" | "CUSTOM";
export type KnowledgeEvidenceKind = "FIRST_PARTY" | "CRM" | "WEBSITE" | "DOCUMENT" | "API" | "OPERATOR_APPROVED" | "CUSTOMER_PROVIDED" | "EXTERNAL_REFERENCE";
export type KnowledgeClaimClass = "GENERAL" | "PRICE" | "AVAILABILITY" | "POLICY" | "GUARANTEE" | "CREDENTIAL" | "LEGAL" | "CONTACT" | "SCHEDULE" | "PROMOTION";
export type KnowledgeFactStatus = "ACTIVE" | "REVOKED";
export type KnowledgeFactObject = { readonly kind: "ENTITY"; readonly entityId: string } | { readonly kind: "LITERAL"; readonly value: PropertyValue };

export interface KnowledgeEntity { readonly id: string; readonly kind: KnowledgeEntityKind; readonly name: string; readonly aliases: readonly string[]; readonly externalKey: string | null; readonly createdAt: string; readonly updatedAt: string; readonly digest: string; readonly revision: number; }
export interface KnowledgeEvidence { readonly id: string; readonly kind: KnowledgeEvidenceKind; readonly source: string; readonly sourceDigest: string | null; readonly excerpt: string | null; readonly observedAt: string; readonly metadata: Readonly<Record<string, PropertyValue>>; readonly digest: string; readonly revision: number; }
export interface KnowledgeFact { readonly id: string; readonly subjectId: string; readonly predicate: string; readonly object: KnowledgeFactObject; readonly evidenceIds: readonly string[]; readonly confidence: number; readonly validFrom: string | null; readonly validUntil: string | null; readonly status: KnowledgeFactStatus; readonly claimClass: KnowledgeClaimClass; readonly updatedAt: string; readonly digest: string; readonly revision: number; }
export interface GroundedFact { readonly factId: string; readonly subjectId: string; readonly subjectName: string; readonly predicate: string; readonly object: KnowledgeFactObject; readonly displayValue: string; readonly evidenceIds: readonly string[]; readonly confidence: number; readonly claimClass: KnowledgeClaimClass; readonly validFrom: string | null; readonly validUntil: string | null; readonly digest: string; }
export interface KnowledgeConflict { readonly subjectId: string; readonly predicate: string; readonly factIds: readonly string[]; readonly reason: "COMPETING_ACTIVE_VALUES"; readonly digest: string; }
export interface GroundingContext { readonly status: "SUPPORTED" | "PARTIALLY_SUPPORTED" | "UNSUPPORTED" | "CONFLICTED"; readonly facts: readonly GroundedFact[]; readonly evidence: readonly KnowledgeEvidence[]; readonly conflicts: readonly KnowledgeConflict[]; readonly matchedEntityIds: readonly string[]; readonly instructions: readonly string[]; readonly digest: string; }

export interface UpsertKnowledgeEntityInput { readonly id?: string; readonly kind: KnowledgeEntityKind; readonly name: string; readonly aliases?: readonly string[]; readonly externalKey?: string | null; readonly observedAt: string; }
export interface AddKnowledgeEvidenceInput { readonly id?: string; readonly kind: KnowledgeEvidenceKind; readonly source: string; readonly sourceDigest?: string | null; readonly excerpt?: string | null; readonly observedAt: string; readonly metadata?: Readonly<Record<string, PropertyValue>>; }
export interface UpsertKnowledgeFactInput { readonly id?: string; readonly subjectId: string; readonly predicate: string; readonly object: KnowledgeFactObject; readonly evidenceIds: readonly string[]; readonly confidence?: number; readonly validFrom?: string | null; readonly validUntil?: string | null; readonly status?: KnowledgeFactStatus; readonly claimClass?: KnowledgeClaimClass; readonly observedAt: string; }
export interface KnowledgeMutationPlan { readonly scope: OntologyScope; readonly schemaId: string; readonly requiredPermission: "chatbot.knowledge.write"; readonly noop: boolean; readonly operations: readonly TransactionOperation[]; readonly digest: string; }
export interface KnowledgeFactQuery { readonly subjectId?: string; readonly predicate?: string; readonly minimumConfidence?: number; readonly at?: string; readonly includeRevoked?: boolean; }
export interface GroundingRequest { readonly businessEntityId: string; readonly userMessage: string; readonly minimumConfidence?: number; readonly at?: string; readonly maxFacts?: number; readonly maxMatchedEntities?: number; }

export class KnowledgeGraphError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "NOT_FOUND" | "TYPE_MISMATCH" | "CONFLICT" | "INTEGRITY_FAILURE" | "CAPACITY_EXCEEDED", message: string) { super(message); this.name = "KnowledgeGraphError"; }
}
export const ENTITY_KINDS = ["ORGANIZATION", "PERSON", "SERVICE", "PRODUCT", "LOCATION", "POLICY", "PRICE", "SCHEDULE", "FAQ", "CONCEPT", "CUSTOM"] as const satisfies readonly KnowledgeEntityKind[];
export const EVIDENCE_KINDS = ["FIRST_PARTY", "CRM", "WEBSITE", "DOCUMENT", "API", "OPERATOR_APPROVED", "CUSTOMER_PROVIDED", "EXTERNAL_REFERENCE"] as const satisfies readonly KnowledgeEvidenceKind[];
export const CLAIM_CLASSES = ["GENERAL", "PRICE", "AVAILABILITY", "POLICY", "GUARANTEE", "CREDENTIAL", "LEGAL", "CONTACT", "SCHEDULE", "PROMOTION"] as const satisfies readonly KnowledgeClaimClass[];
export const FACT_STATUSES = ["ACTIVE", "REVOKED"] as const satisfies readonly KnowledgeFactStatus[];

export function hash(prefix: string, value: unknown): string { return `${prefix}_${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`; }
export function nonEmpty(value: string, field: string): string { const normalized = value.trim(); if (!normalized) throw new KnowledgeGraphError("INVALID_INPUT", `${field} must be non-empty`); return normalized; }
export function canonicalUtc(value: string, field: string): string { const parsed = new Date(value); if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new KnowledgeGraphError("INVALID_INPUT", `${field} must be canonical ISO-8601 UTC`); return value; }
export function nullableUtc(value: string | null | undefined, field: string): string | null { return value === null || value === undefined ? null : canonicalUtc(value, field); }
export function checkedConfidence(value: number, stored = false): number { if (!Number.isFinite(value) || value < 0 || value > 1) throw new KnowledgeGraphError(stored ? "INTEGRITY_FAILURE" : "INVALID_INPUT", "confidence must be a finite number between 0 and 1"); return value; }
export function assertJsonValue(value: PropertyValue, field: string): PropertyValue { if (value === null || typeof value === "string" || typeof value === "boolean") return value; if (typeof value === "number") { if (!Number.isFinite(value)) throw new KnowledgeGraphError("INVALID_INPUT", `${field} contains a non-finite number`); return Object.is(value, -0) ? 0 : value; } if (Array.isArray(value)) { value.forEach((item, i) => assertJsonValue(item, `${field}[${i}]`)); return value; } for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${field}.${key}`); return value; }
export function normalizeIdentifier(value: string, field: string): string { const normalized = nonEmpty(value, field).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}._:-]+/gu, "-").replace(/^-+|-+$/g, ""); if (!normalized) throw new KnowledgeGraphError("INVALID_INPUT", `${field} normalizes to an empty identifier`); return normalized; }
export const normalizePredicate = (value: string): string => normalizeIdentifier(value, "predicate");
export const sortUnique = (values: readonly string[]): string[] => [...new Set(values.map((value) => nonEmpty(value, "list item")))].sort((a, b) => a.localeCompare(b, "en"));
export function assertEnum<T extends string>(value: string, values: readonly T[], field: string): T { if (!values.includes(value as T)) throw new KnowledgeGraphError("INVALID_INPUT", `${field} contains unsupported value ${value}`); return value as T; }
