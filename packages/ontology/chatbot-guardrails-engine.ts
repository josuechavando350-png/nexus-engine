import { hash, type GroundedFact, type GroundingContext, type GroundingRequest, type KnowledgeEvidence } from "./chatbot-knowledge-types.js";
import type { KnowledgeGraphReader } from "./chatbot-knowledge-reader.js";
import {
  GuardrailError,
  type FormalGuardrailPolicy,
  type GuardedGenerationContext,
  type GuardrailEnvelope,
  type GuardrailFactDecision,
  type GuardrailFactRejectionReason,
  type GuardrailResponsePlan,
  type RenderedGuardrailResponse,
} from "./chatbot-guardrails-types.js";
import { verifyGuardrailPolicy } from "./chatbot-guardrails-policy.js";

const SENSITIVE_INTENT_TERMS = Object.freeze({
  PRICE: ["precio", "precios", "costo", "costos", "cuesta", "cuestan", "cuanto", "vale", "cobran", "cotizacion", "price", "prices", "cost"],
  AVAILABILITY: ["disponible", "disponibilidad", "cupo", "stock", "availability", "available"],
  POLICY: ["politica", "politicas", "terminos", "condiciones", "cancelacion", "reembolso", "privacidad", "policy", "policies", "terms", "refund"],
  GUARANTEE: ["garantia", "garantias", "garantiza", "garantizado", "asegura", "aseguran", "guarantee", "guarantees", "guaranteed"],
  CREDENTIAL: ["credencial", "credenciales", "cedula", "licencia", "certificacion", "certificado", "credential", "credentials", "license", "certification"],
  LEGAL: ["legal", "ley", "contrato", "obligacion", "responsabilidad", "law", "contract", "obligation", "liability"],
  CONTACT: ["contacto", "telefono", "whatsapp", "correo", "email", "contact", "phone"],
  SCHEDULE: ["horario", "horarios", "hora", "abren", "cierran", "schedule", "hours", "open", "close"],
  PROMOTION: ["descuento", "descuentos", "promocion", "promociones", "promo", "oferta", "porcentaje", "discount", "promotion", "deal"],
} as const);

function normalizeIntentText(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9$%]+/g, " ").trim();
}

export function inferGuardrailSensitiveClaimClasses(message: string): Exclude<GroundedFact["claimClass"], "GENERAL">[] {
  const normalized = normalizeIntentText(message);
  const tokenSet = new Set(normalized.split(/\s+/).filter(Boolean));
  const inferred = (Object.keys(SENSITIVE_INTENT_TERMS) as Exclude<GroundedFact["claimClass"], "GENERAL">[]).filter((claimClass) =>
    SENSITIVE_INTENT_TERMS[claimClass].some((term) => tokenSet.has(term)),
  );
  if ((tokenSet.has("$") || tokenSet.has("mxn") || tokenSet.has("usd") || tokenSet.has("pesos") || tokenSet.has("dolares")) && !inferred.includes("PRICE")) inferred.push("PRICE");
  if ((normalized.includes("%") || tokenSet.has("porciento")) && !inferred.includes("PROMOTION")) inferred.push("PROMOTION");
  return inferred.sort((a, b) => a.localeCompare(b, "en"));
}

function canonicalUtc(value: string, field: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new GuardrailError("INVALID_INPUT", `${field} must be canonical ISO-8601 UTC`);
  return value;
}

function groundingCore(grounding: GroundingContext): Omit<GroundingContext, "digest"> {
  return { status: grounding.status, facts: grounding.facts, evidence: grounding.evidence, conflicts: grounding.conflicts, matchedEntityIds: grounding.matchedEntityIds, instructions: grounding.instructions };
}

function verifyEvidence(evidence: KnowledgeEvidence): void {
  const core = { kind: evidence.kind, source: evidence.source, sourceDigest: evidence.sourceDigest, excerpt: evidence.excerpt, observedAt: evidence.observedAt, metadata: evidence.metadata };
  if (hash("kgr", core) !== evidence.digest) throw new GuardrailError("INTEGRITY_FAILURE", `evidence ${evidence.id} digest mismatch`);
  canonicalUtc(evidence.observedAt, `evidence ${evidence.id}.observedAt`);
}

function verifyFact(fact: GroundedFact): void {
  const core = { factId: fact.factId, subjectId: fact.subjectId, subjectName: fact.subjectName, predicate: fact.predicate, object: fact.object, displayValue: fact.displayValue, evidenceIds: fact.evidenceIds, confidence: fact.confidence, claimClass: fact.claimClass, validFrom: fact.validFrom, validUntil: fact.validUntil };
  if (hash("kground", core) !== fact.digest) throw new GuardrailError("INTEGRITY_FAILURE", `grounded fact ${fact.factId} digest mismatch`);
  if (!Number.isFinite(fact.confidence) || fact.confidence < 0 || fact.confidence > 1) throw new GuardrailError("INTEGRITY_FAILURE", `fact ${fact.factId} has invalid confidence`);
}

function verifyGrounding(grounding: GroundingContext): void {
  if (hash("kgcontext", groundingCore(grounding)) !== grounding.digest) throw new GuardrailError("INTEGRITY_FAILURE", "grounding context digest mismatch");
  for (const evidence of grounding.evidence) verifyEvidence(evidence);
  for (const fact of grounding.facts) verifyFact(fact);
  const evidenceIds = new Set(grounding.evidence.map((item) => item.id));
  for (const fact of grounding.facts) for (const evidenceId of fact.evidenceIds) if (!evidenceIds.has(evidenceId)) throw new GuardrailError("INTEGRITY_FAILURE", `fact ${fact.factId} references evidence ${evidenceId} absent from grounding context`);
}

function factDecision(fact: GroundedFact, grounding: GroundingContext, policy: FormalGuardrailPolicy, evidenceMap: ReadonlyMap<string, KnowledgeEvidence>, nowMs: number): GuardrailFactDecision {
  const rule = policy.claimPolicies[fact.claimClass];
  const reasons: GuardrailFactRejectionReason[] = [];
  if (grounding.status === "CONFLICTED") reasons.push("GROUNDING_CONFLICT");
  if (grounding.status === "UNSUPPORTED") reasons.push("GROUNDING_UNSUPPORTED");
  if (fact.confidence < rule.minimumConfidence) reasons.push("LOW_CONFIDENCE");
  if (grounding.status === "PARTIALLY_SUPPORTED" && !rule.allowPartialSupport) reasons.push("PARTIAL_SUPPORT_NOT_ALLOWED");

  const evidence = fact.evidenceIds.map((id) => evidenceMap.get(id)).filter((item): item is KnowledgeEvidence => item !== undefined);
  if (evidence.length !== fact.evidenceIds.length) reasons.push("INTEGRITY_FAILURE");
  if (evidence.length < rule.minimumEvidenceCount) reasons.push("INSUFFICIENT_EVIDENCE");
  if (evidence.some((item) => !rule.allowedEvidenceKinds.includes(item.kind))) reasons.push("UNAPPROVED_EVIDENCE_KIND");
  if (rule.requiredEvidenceKinds?.length && !evidence.some((item) => rule.requiredEvidenceKinds!.includes(item.kind))) reasons.push("MISSING_REQUIRED_EVIDENCE_KIND");
  if (rule.requireSourceDigest && evidence.some((item) => !item.sourceDigest?.trim())) reasons.push("MISSING_SOURCE_DIGEST");
  if (evidence.some((item) => Date.parse(item.observedAt) > nowMs)) reasons.push("FUTURE_EVIDENCE");
  if (rule.maxEvidenceAgeMs !== undefined && evidence.some((item) => nowMs - Date.parse(item.observedAt) > rule.maxEvidenceAgeMs!)) reasons.push("STALE_EVIDENCE");

  const uniqueReasons = [...new Set(reasons)];
  const disposition: GuardrailFactDecision["disposition"] = uniqueReasons.length ? "REJECT" : grounding.status === "PARTIALLY_SUPPORTED" ? "QUALIFY" : "ALLOW";
  const core = { factId: fact.factId, claimClass: fact.claimClass, risk: rule.risk, disposition, reasons: uniqueReasons };
  return { ...core, digest: hash("kgdecision", core) };
}

function verifyEnvelopeDigest(envelope: GuardrailEnvelope, policy: FormalGuardrailPolicy, grounding: GroundingContext): void {
  if (envelope.policyDigest !== policy.digest || envelope.policyId !== policy.policyId || envelope.policyVersion !== policy.version) throw new GuardrailError("INTEGRITY_FAILURE", "guardrail envelope policy mismatch");
  if (envelope.groundingDigest !== grounding.digest || envelope.groundingStatus !== grounding.status) throw new GuardrailError("INTEGRITY_FAILURE", "guardrail envelope grounding mismatch");
  const { digest, ...core } = envelope;
  if (hash("kgenvelope", core) !== digest) throw new GuardrailError("INTEGRITY_FAILURE", "guardrail envelope digest mismatch");
}

export class FormalGuardrailEngine {
  private readonly issuedContexts = new WeakSet<object>();
  private readonly issuedResponses = new WeakSet<object>();

  constructor(
    private readonly reader: KnowledgeGraphReader,
    readonly policy: FormalGuardrailPolicy,
    private readonly now: () => number = Date.now,
  ) {
    verifyGuardrailPolicy(policy);
  }

  private currentTime(): { nowMs: number; nowIso: string } {
    const nowMs = this.now();
    if (!Number.isFinite(nowMs) || nowMs < 0) throw new GuardrailError("INTEGRITY_FAILURE", "guardrail clock returned an invalid timestamp");
    return { nowMs, nowIso: new Date(nowMs).toISOString() };
  }

  async prepare(request: GroundingRequest): Promise<GuardedGenerationContext> {
    verifyGuardrailPolicy(this.policy);
    const { nowMs, nowIso: createdAt } = this.currentTime();
    if (request.at !== undefined && !this.policy.allowHistoricalGrounding) throw new GuardrailError("INVALID_INPUT", "historical grounding is disabled by guardrail policy");
    const grounding = await this.reader.grounding(request);
    verifyGrounding(grounding);
    const requestDigest = hash("kgrequest", request);
    const requestedClaimClasses = inferGuardrailSensitiveClaimClasses(request.userMessage);
    const evidenceMap = new Map(grounding.evidence.map((item) => [item.id, item]));
    const decisions = grounding.facts.map((fact) => factDecision(fact, grounding, this.policy, evidenceMap, nowMs));
    const allowedFactIds = decisions.filter((item) => item.disposition === "ALLOW").map((item) => item.factId).sort((a, b) => a.localeCompare(b, "en"));
    const qualifiedFactIds = decisions.filter((item) => item.disposition === "QUALIFY").map((item) => item.factId).sort((a, b) => a.localeCompare(b, "en"));
    const rejectedFacts = decisions.filter((item) => item.disposition === "REJECT").sort((a, b) => a.factId.localeCompare(b.factId, "en"));
    const usableCount = allowedFactIds.length + qualifiedFactIds.length;
    const usableIds = new Set([...allowedFactIds, ...qualifiedFactIds]);
    const missingRequestedClass = requestedClaimClasses.some((claimClass) => !grounding.facts.some((fact) => fact.claimClass === claimClass && usableIds.has(fact.factId)));
    const rejectedHighRisk = rejectedFacts.some((item) => item.risk === "HIGH" || item.risk === "CRITICAL");
    const suppressFacts = grounding.status === "UNSUPPORTED" || grounding.status === "CONFLICTED";
    const requiredEscalation = suppressFacts || usableCount === 0 || missingRequestedClass || rejectedHighRisk;
    const disposition: GuardrailEnvelope["disposition"] = requiredEscalation ? "ESCALATE" : qualifiedFactIds.length ? "QUALIFY" : "ALLOW";
    const envelopeCore = { policyId: this.policy.policyId, policyVersion: this.policy.version, policyDigest: this.policy.digest, groundingDigest: grounding.digest, requestDigest, requestedClaimClasses, groundingStatus: grounding.status, disposition, allowedFactIds, qualifiedFactIds, rejectedFacts, facts: grounding.facts, requiredEscalation, suppressFacts, createdAt };
    const envelope: GuardrailEnvelope = Object.freeze({ ...envelopeCore, digest: hash("kgenvelope", envelopeCore) });
    const contextCore = { grounding, envelope };
    const context: GuardedGenerationContext = Object.freeze({ ...contextCore, digest: hash("kgprepared", { requestDigest, groundingDigest: grounding.digest, envelopeDigest: envelope.digest }) });
    this.issuedContexts.add(context);
    return context;
  }

  render(plan: GuardrailResponsePlan, context: GuardedGenerationContext): RenderedGuardrailResponse {
    verifyGuardrailPolicy(this.policy);
    if (!this.issuedContexts.has(context)) throw new GuardrailError("INTEGRITY_FAILURE", "generation context was not issued by this guardrail engine");
    const { grounding, envelope } = context;
    verifyGrounding(grounding);
    verifyEnvelopeDigest(envelope, this.policy, grounding);
    if (hash("kgprepared", { requestDigest: envelope.requestDigest, groundingDigest: grounding.digest, envelopeDigest: envelope.digest }) !== context.digest) throw new GuardrailError("INTEGRITY_FAILURE", "generation context digest mismatch");
    const { nowIso: renderedAt } = this.currentTime();
    if (!plan.planId.trim()) throw new GuardrailError("INVALID_INPUT", "planId must be non-empty");
    if (!plan.segments.length) throw new GuardrailError("INVALID_INPUT", "response plan must contain at least one segment");
    if (plan.segments.length > this.policy.maxSegments) throw new GuardrailError("OUTPUT_BUDGET_EXCEEDED", `response plan exceeds ${this.policy.maxSegments} segments`);

    const factMap = new Map(grounding.facts.map((fact) => [fact.factId, fact]));
    const allowed = new Set(envelope.allowedFactIds);
    const qualified = new Set(envelope.qualifiedFactIds);
    const copyMap = new Map(this.policy.copy.map((item) => [item.id, item]));
    const templateMap = new Map(this.policy.templates.map((item) => [item.id, item]));
    const parts: string[] = [];
    const usedFactIds: string[] = [];
    const usedCopyIds: string[] = [];
    let usedEscalation = false;

    for (const segment of plan.segments) {
      if (segment.kind === "COPY") {
        const copy = copyMap.get(segment.copyId);
        if (!copy || copy.locale !== this.policy.locale || !copy.allowedStatuses.includes(grounding.status)) throw new GuardrailError("COPY_NOT_ALLOWED", `copy ${segment.copyId} is not allowed`);
        if (copy.kind === "ESCALATION") usedEscalation = true;
        parts.push(copy.text.trim());
        usedCopyIds.push(copy.id);
        continue;
      }
      if (segment.kind !== "FACT") throw new GuardrailError("INVALID_INPUT", "response plan contains an unsupported segment kind");
      const fact = factMap.get(segment.factId);
      if (!fact) throw new GuardrailError("FACT_NOT_ALLOWED", `fact ${segment.factId} is absent from grounding context`);
      const isAllowed = allowed.has(fact.factId);
      const isQualified = qualified.has(fact.factId);
      if (!isAllowed && !isQualified) throw new GuardrailError("FACT_NOT_ALLOWED", `fact ${fact.factId} was rejected by guardrails`);
      const template = templateMap.get(segment.templateId);
      if (!template || template.locale !== this.policy.locale || template.claimClass !== fact.claimClass) throw new GuardrailError("TEMPLATE_NOT_ALLOWED", `template ${segment.templateId} is not valid for ${fact.claimClass}`);
      if (template.predicates?.length && !template.predicates.includes(fact.predicate)) throw new GuardrailError("TEMPLATE_NOT_ALLOWED", `template ${segment.templateId} does not allow predicate ${fact.predicate}`);
      if (template.qualified !== isQualified) throw new GuardrailError("TEMPLATE_NOT_ALLOWED", `template ${segment.templateId} qualification does not match guardrail decision`);
      const rendered = template.text.replaceAll("{subject}", fact.subjectName).replaceAll("{predicate}", fact.predicate).replaceAll("{value}", fact.displayValue).replaceAll("{confidence}", String(fact.confidence));
      parts.push(rendered.trim());
      usedFactIds.push(fact.factId);
    }

    const usedFactClasses = new Set(usedFactIds.map((id) => factMap.get(id)?.claimClass).filter((value): value is GroundedFact["claimClass"] => value !== undefined));
    const omittedRequestedClass = envelope.requestedClaimClasses.some((claimClass) => !usedFactClasses.has(claimClass));
    if (omittedRequestedClass && !usedEscalation) throw new GuardrailError("ESCALATION_REQUIRED", "response omitted a requested sensitive claim without escalating");
    if (envelope.requiredEscalation && !usedEscalation) throw new GuardrailError("ESCALATION_REQUIRED", "guardrail envelope requires an approved escalation segment");
    if (envelope.suppressFacts && usedFactIds.length) throw new GuardrailError("FACT_NOT_ALLOWED", "no factual claims may be emitted while grounding is unsupported or conflicted");
    const text = parts.join(" ").replace(/\s+/g, " ").trim();
    if (!text) throw new GuardrailError("INVALID_INPUT", "rendered response is empty");
    if (text.length > this.policy.maxResponseChars) throw new GuardrailError("OUTPUT_BUDGET_EXCEEDED", `rendered response exceeds ${this.policy.maxResponseChars} characters`);
    const responseCore = { planId: plan.planId, policyDigest: this.policy.digest, groundingDigest: grounding.digest, envelopeDigest: envelope.digest, text, usedFactIds: [...new Set(usedFactIds)].sort((a, b) => a.localeCompare(b, "en")), usedCopyIds: [...new Set(usedCopyIds)].sort((a, b) => a.localeCompare(b, "en")), renderedAt };
    const response: RenderedGuardrailResponse = Object.freeze({ ...responseCore, digest: hash("kgresponse", responseCore) });
    this.issuedResponses.add(response);
    return response;
  }

  verifyOutbound(response: RenderedGuardrailResponse, context: GuardedGenerationContext): void {
    verifyGuardrailPolicy(this.policy);
    if (!this.issuedContexts.has(context)) throw new GuardrailError("INTEGRITY_FAILURE", "generation context was not issued by this guardrail engine");
    if (!this.issuedResponses.has(response)) throw new GuardrailError("INTEGRITY_FAILURE", "outbound response was not issued by this guardrail engine");
    const { grounding, envelope } = context;
    verifyGrounding(grounding);
    verifyEnvelopeDigest(envelope, this.policy, grounding);
    if (response.policyDigest !== this.policy.digest || response.groundingDigest !== grounding.digest || response.envelopeDigest !== envelope.digest) throw new GuardrailError("INTEGRITY_FAILURE", "outbound response lineage mismatch");
    const { digest, ...core } = response;
    if (hash("kgresponse", core) !== digest) throw new GuardrailError("INTEGRITY_FAILURE", "outbound response digest mismatch");
    if (response.text.length > this.policy.maxResponseChars) throw new GuardrailError("OUTPUT_BUDGET_EXCEEDED", "outbound response exceeds configured character budget");
  }
}
