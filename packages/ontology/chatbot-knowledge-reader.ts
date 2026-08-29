import type { OntologyScope } from "./index.js";
import type { ObjectQuery, OntologyReadPort } from "./persistence-query.js";
import type { ObjectRecord, PropertyValue } from "./transaction.js";

import {
  CLAIM_CLASSES,
  ENTITY_TYPE,
  FACT_TYPE,
  P,
  KnowledgeGraphError,
  canonicalUtc,
  checkedConfidence,
  hash,
  normalizeIdentifier,
  normalizePredicate,
  sortUnique,
  type GroundedFact,
  type GroundingContext,
  type GroundingRequest,
  type KnowledgeClaimClass,
  type KnowledgeEntity,
  type KnowledgeEvidence,
  type KnowledgeFact,
  type KnowledgeFactQuery,
} from "./chatbot-knowledge-types.js";
import { projectEntity, projectEvidence, projectFact } from "./chatbot-knowledge-codec.js";
import { assertFactRelationshipIntegrity, detectConflicts, validAt } from "./chatbot-knowledge-schema.js";

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

function normalizeText(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokens(value: string): string[] {
  return [...new Set(normalizeText(value).split(/\s+/).filter((token) => token.length >= 2))];
}

function lexicalScore(needleTokens: readonly string[], haystack: string): number {
  if (!needleTokens.length) return 0;
  const normalized = ` ${normalizeText(haystack)} `;
  let score = 0;
  for (const token of needleTokens) {
    if (normalized.includes(` ${token} `)) score += 2;
    else if (normalized.includes(token)) score += 1;
  }
  return score;
}

const CLAIM_INTENT_TERMS: Readonly<Record<KnowledgeClaimClass, readonly string[]>> = Object.freeze({
  GENERAL: ["servicio", "servicios", "ofrece", "ofrecen", "vende", "venden", "service", "services", "offer", "offers"],
  PRICE: ["precio", "precios", "costo", "costos", "cuesta", "cuestan", "price", "prices", "cost"],
  AVAILABILITY: ["disponible", "disponibilidad", "availability", "available"],
  POLICY: ["politica", "politicas", "terminos", "condiciones", "policy", "policies", "terms"],
  GUARANTEE: ["garantia", "garantias", "garantiza", "garantizado", "guarantee", "guarantees", "guaranteed"],
  CREDENTIAL: ["credencial", "credenciales", "cedula", "licencia", "credential", "credentials", "license"],
  LEGAL: ["legal", "ley", "contrato", "obligacion", "law", "contract", "obligation"],
  CONTACT: ["contacto", "telefono", "whatsapp", "correo", "email", "contact", "phone"],
  SCHEDULE: ["horario", "horarios", "hora", "abren", "cierran", "schedule", "hours", "open", "close"],
  PROMOTION: ["descuento", "descuentos", "promocion", "promociones", "promo", "oferta", "discount", "promotion", "deal"],
});

function inferClaimClasses(message: string): KnowledgeClaimClass[] {
  const messageTokens = new Set(tokens(message));
  return CLAIM_CLASSES.filter((claimClass) => CLAIM_INTENT_TERMS[claimClass].some((term) => messageTokens.has(normalizeText(term))));
}

function displayLiteral(value: PropertyValue): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  return JSON.stringify(value);
}

export class KnowledgeGraphReader {
  constructor(private readonly read: OntologyReadPort, readonly scope: OntologyScope) {}

  entity(id: string): KnowledgeEntity | null {
    const record = this.read.getObject(this.scope, normalizeIdentifier(id, "entityId"));
    return record ? projectEntity(record) : null;
  }

  evidence(id: string): KnowledgeEvidence | null {
    const record = this.read.getObject(this.scope, normalizeIdentifier(id, "evidenceId"));
    return record ? projectEvidence(record) : null;
  }

  fact(id: string): KnowledgeFact | null {
    const record = this.read.getObject(this.scope, normalizeIdentifier(id, "factId"));
    return record ? projectFact(record) : null;
  }

  async searchEntities(text: string, limit = 12): Promise<readonly KnowledgeEntity[]> {
    if (!Number.isInteger(limit) || limit <= 0 || limit > 100) throw new KnowledgeGraphError("INVALID_INPUT", "entity search limit must be 1..100");
    const queryTokens = tokens(text);
    if (!queryTokens.length) return [];
    const records = await collectObjects(this.read, this.scope, { typeId: ENTITY_TYPE });
    return records.map(projectEntity).map((entity) => ({
      entity,
      score: lexicalScore(queryTokens, [entity.name, ...entity.aliases, entity.externalKey ?? ""].join(" ")),
    })).filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.entity.id.localeCompare(b.entity.id, "en"))
      .slice(0, limit).map((item) => item.entity);
  }

  async queryFacts(query: KnowledgeFactQuery = {}): Promise<{ facts: readonly KnowledgeFact[]; conflicts: ReturnType<typeof detectConflicts>; digest: string }> {
    const at = query.at ? Date.parse(canonicalUtc(query.at, "at")) : Date.now();
    const minimumConfidence = checkedConfidence(query.minimumConfidence ?? 0);
    const propertyEquals: Record<string, string | number | boolean | null> = {};
    if (query.subjectId) propertyEquals[P.subjectId] = normalizeIdentifier(query.subjectId, "subjectId");
    if (query.predicate) propertyEquals[P.predicate] = normalizePredicate(query.predicate);
    const records = await collectObjects(this.read, this.scope, { typeId: FACT_TYPE, ...(Object.keys(propertyEquals).length ? { propertyEquals } : {}) });
    const facts = records.map(projectFact)
      .filter((fact) => query.includeRevoked ? true : validAt(fact, at))
      .filter((fact) => fact.confidence >= minimumConfidence)
      .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id, "en"));
    for (const fact of facts) await assertFactRelationshipIntegrity(this.read, this.scope, fact);
    const conflicts = detectConflicts(facts);
    const core = { facts, conflicts };
    return { ...core, digest: hash("kgquery", core) };
  }

  async grounding(request: GroundingRequest): Promise<GroundingContext> {
    const businessEntityId = normalizeIdentifier(request.businessEntityId, "businessEntityId");
    if (!this.entity(businessEntityId)) throw new KnowledgeGraphError("NOT_FOUND", `business entity ${businessEntityId} does not exist`);
    const minimumConfidence = checkedConfidence(request.minimumConfidence ?? 0.65);
    const maxFacts = request.maxFacts ?? 24;
    const maxMatchedEntities = request.maxMatchedEntities ?? 8;
    if (!Number.isInteger(maxFacts) || maxFacts <= 0 || maxFacts > 100) throw new KnowledgeGraphError("INVALID_INPUT", "maxFacts must be 1..100");
    if (!Number.isInteger(maxMatchedEntities) || maxMatchedEntities <= 0 || maxMatchedEntities > 50) throw new KnowledgeGraphError("INVALID_INPUT", "maxMatchedEntities must be 1..50");

    const matches = await this.searchEntities(request.userMessage, maxMatchedEntities);
    const subjectIds = [...new Set([businessEntityId, ...matches.map((entity) => entity.id)])];
    const factMap = new Map<string, KnowledgeFact>();
    for (const subjectId of subjectIds) {
      const result = await this.queryFacts({ subjectId, minimumConfidence, at: request.at });
      for (const fact of result.facts) factMap.set(fact.id, fact);
    }

    const allFacts = [...factMap.values()];
    const entityIds = new Set<string>(subjectIds);
    for (const fact of allFacts) if (fact.object.kind === "ENTITY") entityIds.add(fact.object.entityId);
    const entityMap = new Map<string, KnowledgeEntity>();
    for (const id of entityIds) {
      const entity = this.entity(id);
      if (entity) entityMap.set(id, entity);
    }

    const queryTokens = tokens(request.userMessage);
    const inferred = inferClaimClasses(request.userMessage);
    const scored = allFacts.map((fact) => {
      const objectText = fact.object.kind === "ENTITY" ? entityMap.get(fact.object.entityId)?.name ?? fact.object.entityId : displayLiteral(fact.object.value);
      const searchable = `${entityMap.get(fact.subjectId)?.name ?? fact.subjectId} ${fact.predicate} ${objectText} ${fact.claimClass}`;
      return { fact, score: lexicalScore(queryTokens, searchable), boost: inferred.includes(fact.claimClass) ? 3 : 0 };
    });

    const candidate = scored.filter((item) => item.score > 0 || item.boost > 0)
      .sort((a, b) => (b.score + b.boost) - (a.score + a.boost) || b.fact.confidence - a.fact.confidence || a.fact.id.localeCompare(b.fact.id, "en"))
      .slice(0, maxFacts);
    const keys = new Set(candidate.map(({ fact }) => `${fact.subjectId}\u0000${fact.predicate}`));
    const relevant = scored.filter(({ fact }) => keys.has(`${fact.subjectId}\u0000${fact.predicate}`))
      .sort((a, b) => (b.score + b.boost) - (a.score + a.boost) || b.fact.confidence - a.fact.confidence || a.fact.id.localeCompare(b.fact.id, "en"))
      .slice(0, maxFacts);

    const facts: GroundedFact[] = relevant.map(({ fact }) => {
      const displayValue = fact.object.kind === "ENTITY" ? entityMap.get(fact.object.entityId)?.name ?? fact.object.entityId : displayLiteral(fact.object.value);
      const core = {
        factId: fact.id, subjectId: fact.subjectId, subjectName: entityMap.get(fact.subjectId)?.name ?? fact.subjectId,
        predicate: fact.predicate, object: fact.object, displayValue, evidenceIds: fact.evidenceIds,
        confidence: fact.confidence, claimClass: fact.claimClass, validFrom: fact.validFrom, validUntil: fact.validUntil,
      };
      return { ...core, digest: hash("kground", core) };
    });

    const rawFacts = relevant.map(({ fact }) => fact);
    const conflicts = detectConflicts(rawFacts);
    const evidenceIds = sortUnique(rawFacts.flatMap((fact) => fact.evidenceIds));
    const evidence: KnowledgeEvidence[] = evidenceIds.map((id) => {
      const item = this.evidence(id);
      if (!item) throw new KnowledgeGraphError("INTEGRITY_FAILURE", `fact references missing evidence ${id}`);
      return item;
    });

    const status: GroundingContext["status"] = conflicts.length ? "CONFLICTED"
      : !facts.length ? "UNSUPPORTED"
        : facts.some((fact) => fact.confidence < 0.8) ? "PARTIALLY_SUPPORTED" : "SUPPORTED";
    const instructions: readonly string[] = status === "SUPPORTED"
      ? ["Use only supplied facts/evidence.", "Do not invent prices, discounts, availability, deadlines, credentials, guarantees, policies or outcomes.", "Preserve validity/confidence.", "If unsupported, say it is unavailable instead of guessing."]
      : status === "PARTIALLY_SUPPORTED"
        ? ["State uncertainty explicitly.", "Do not turn probable information into certainty.", "Do not make commercial commitments from partially supported facts."]
        : status === "CONFLICTED"
          ? ["Do not silently choose between conflicting facts.", "Escalate the disputed claim for operator confirmation."]
          : ["No verified fact supports the request.", "Do not invent an answer.", "Ask for clarification or escalate."];
    const core = { status, facts, evidence: evidence.sort((a, b) => a.id.localeCompare(b.id, "en")), conflicts, matchedEntityIds: matches.map((entity) => entity.id), instructions };
    return { ...core, digest: hash("kgcontext", core) };
  }
}
