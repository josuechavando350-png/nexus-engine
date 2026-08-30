import { CLAIM_CLASSES, EVIDENCE_KINDS, hash, type KnowledgeClaimClass, type KnowledgeEvidenceKind } from "./chatbot-knowledge-types.js";
import {
  GuardrailError,
  type ApprovedCopy,
  type ApprovedFactTemplate,
  type ClaimGuardrailPolicy,
  type FormalGuardrailPolicy,
  type GuardrailRisk,
} from "./chatbot-guardrails-types.js";

const AUTHORITATIVE = ["FIRST_PARTY", "CRM", "WEBSITE", "DOCUMENT", "API", "OPERATOR_APPROVED"] as const satisfies readonly KnowledgeEvidenceKind[];
const STRONG = ["FIRST_PARTY", "CRM", "API", "OPERATOR_APPROVED"] as const satisfies readonly KnowledgeEvidenceKind[];

const RISK: Readonly<Record<KnowledgeClaimClass, GuardrailRisk>> = Object.freeze({
  GENERAL: "LOW",
  PRICE: "HIGH",
  AVAILABILITY: "MEDIUM",
  POLICY: "HIGH",
  GUARANTEE: "CRITICAL",
  CREDENTIAL: "CRITICAL",
  LEGAL: "CRITICAL",
  CONTACT: "MEDIUM",
  SCHEDULE: "MEDIUM",
  PROMOTION: "HIGH",
});

function requiredKinds(claimClass: KnowledgeClaimClass): readonly KnowledgeEvidenceKind[] | undefined {
  if (claimClass === "GUARANTEE" || claimClass === "LEGAL") return ["OPERATOR_APPROVED"];
  if (claimClass === "CREDENTIAL") return ["FIRST_PARTY", "OPERATOR_APPROVED"];
  if (claimClass === "PRICE" || claimClass === "POLICY" || claimClass === "PROMOTION") return STRONG;
  return undefined;
}

function freshnessMs(claimClass: KnowledgeClaimClass): number {
  const day = 24 * 60 * 60 * 1000;
  switch (claimClass) {
    case "AVAILABILITY": return 30 * day;
    case "PROMOTION": return 45 * day;
    case "PRICE": case "LEGAL": case "SCHEDULE": return 180 * day;
    case "POLICY": case "GUARANTEE": case "CONTACT": return 365 * day;
    case "CREDENTIAL": case "GENERAL": return 730 * day;
  }
}

function claimPolicy(claimClass: KnowledgeClaimClass): ClaimGuardrailPolicy {
  const risk = RISK[claimClass];
  const requiredEvidenceKinds = requiredKinds(claimClass);
  return {
    claimClass,
    risk,
    minimumConfidence: risk === "CRITICAL" ? 0.95 : risk === "HIGH" ? 0.9 : risk === "MEDIUM" ? 0.8 : 0.75,
    minimumEvidenceCount: 1,
    allowedEvidenceKinds: AUTHORITATIVE,
    ...(requiredEvidenceKinds ? { requiredEvidenceKinds } : {}),
    allowPartialSupport: risk === "LOW" || risk === "MEDIUM",
    requireSourceDigest: risk === "HIGH" || risk === "CRITICAL",
    maxEvidenceAgeMs: freshnessMs(claimClass),
  };
}

const DEFAULT_COPY: readonly ApprovedCopy[] = Object.freeze([
  {
    id: "es.ask-clarify",
    locale: "es-MX",
    kind: "QUESTION",
    text: "¿Me compartes un poco más de información para darte una respuesta precisa?",
    allowedStatuses: ["UNSUPPORTED", "PARTIALLY_SUPPORTED", "SUPPORTED"],
  },
  {
    id: "es.escalate-verify",
    locale: "es-MX",
    kind: "ESCALATION",
    text: "Para no darte información incorrecta, necesito confirmarlo con una persona del equipo.",
    allowedStatuses: ["UNSUPPORTED", "CONFLICTED", "PARTIALLY_SUPPORTED", "SUPPORTED"],
  },
  {
    id: "es.offer-help",
    locale: "es-MX",
    kind: "CLOSING",
    text: "Si quieres, también puedo ayudarte con otra duda.",
    allowedStatuses: ["SUPPORTED", "PARTIALLY_SUPPORTED"],
  },
]);

const DEFAULT_TEMPLATES: readonly ApprovedFactTemplate[] = Object.freeze([
  { id: "es.general", locale: "es-MX", claimClass: "GENERAL", qualified: false, text: "{subject}: {value}." },
  { id: "es.general-qualified", locale: "es-MX", claimClass: "GENERAL", qualified: true, text: "Según la información disponible, {subject}: {value}." },
  { id: "es.price", locale: "es-MX", claimClass: "PRICE", qualified: false, text: "El precio verificado de {subject} es {value}." },
  { id: "es.availability", locale: "es-MX", claimClass: "AVAILABILITY", qualified: false, text: "La disponibilidad verificada de {subject} es {value}." },
  { id: "es.availability-qualified", locale: "es-MX", claimClass: "AVAILABILITY", qualified: true, text: "Según la información disponible, la disponibilidad de {subject} es {value}; conviene confirmarla antes de tomarla como definitiva." },
  { id: "es.policy", locale: "es-MX", claimClass: "POLICY", qualified: false, text: "La política verificada para {subject} es: {value}." },
  { id: "es.guarantee", locale: "es-MX", claimClass: "GUARANTEE", qualified: false, text: "La garantía verificada para {subject} es: {value}." },
  { id: "es.credential", locale: "es-MX", claimClass: "CREDENTIAL", qualified: false, text: "La credencial verificada para {subject} es: {value}." },
  { id: "es.legal", locale: "es-MX", claimClass: "LEGAL", qualified: false, text: "La información legal verificada para {subject} es: {value}." },
  { id: "es.contact", locale: "es-MX", claimClass: "CONTACT", qualified: false, text: "El dato de contacto verificado de {subject} es {value}." },
  { id: "es.contact-qualified", locale: "es-MX", claimClass: "CONTACT", qualified: true, text: "Según la información disponible, el dato de contacto de {subject} es {value}." },
  { id: "es.schedule", locale: "es-MX", claimClass: "SCHEDULE", qualified: false, text: "El horario verificado de {subject} es {value}." },
  { id: "es.schedule-qualified", locale: "es-MX", claimClass: "SCHEDULE", qualified: true, text: "Según la información disponible, el horario de {subject} es {value}; conviene confirmarlo si tu visita depende de ese horario." },
  { id: "es.promotion", locale: "es-MX", claimClass: "PROMOTION", qualified: false, text: "La promoción verificada para {subject} es: {value}." },
]);

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new GuardrailError("INVALID_POLICY", `${field} must be a positive integer`);
}

function assertClaimPolicy(value: ClaimGuardrailPolicy, claimClass: KnowledgeClaimClass): void {
  if (value.claimClass !== claimClass) throw new GuardrailError("INVALID_POLICY", `claim policy key ${claimClass} does not match ${value.claimClass}`);
  if (!Number.isFinite(value.minimumConfidence) || value.minimumConfidence < 0 || value.minimumConfidence > 1) throw new GuardrailError("INVALID_POLICY", `${claimClass}.minimumConfidence must be within 0..1`);
  assertPositiveInteger(value.minimumEvidenceCount, `${claimClass}.minimumEvidenceCount`);
  if (!value.allowedEvidenceKinds.length) throw new GuardrailError("INVALID_POLICY", `${claimClass} must allow at least one evidence kind`);
  for (const kind of value.allowedEvidenceKinds) if (!EVIDENCE_KINDS.includes(kind)) throw new GuardrailError("INVALID_POLICY", `${claimClass} contains unsupported evidence kind ${kind}`);
  for (const kind of value.requiredEvidenceKinds ?? []) if (!value.allowedEvidenceKinds.includes(kind)) throw new GuardrailError("INVALID_POLICY", `${claimClass} requires evidence kind ${kind} that is not allowed`);
  if (value.maxEvidenceAgeMs !== undefined && (!Number.isFinite(value.maxEvidenceAgeMs) || value.maxEvidenceAgeMs <= 0)) throw new GuardrailError("INVALID_POLICY", `${claimClass}.maxEvidenceAgeMs must be positive`);
}

function core(policy: Omit<FormalGuardrailPolicy, "digest">): Omit<FormalGuardrailPolicy, "digest"> {
  return { ...policy, copy: [...policy.copy].sort((a, b) => a.id.localeCompare(b.id, "en")), templates: [...policy.templates].sort((a, b) => a.id.localeCompare(b.id, "en")) };
}

export function createDefaultGuardrailPolicy(): FormalGuardrailPolicy {
  const claimPolicies = Object.fromEntries(CLAIM_CLASSES.map((claimClass) => [claimClass, claimPolicy(claimClass)])) as Readonly<Record<KnowledgeClaimClass, ClaimGuardrailPolicy>>;
  return finalizeGuardrailPolicy({ policyId: "nexus.chatbot.guardrails.default", version: "1.0.0", locale: "es-MX", maxSegments: 12, maxResponseChars: 4_000, allowHistoricalGrounding: false, claimPolicies, copy: DEFAULT_COPY, templates: DEFAULT_TEMPLATES });
}

export function finalizeGuardrailPolicy(input: Omit<FormalGuardrailPolicy, "digest">): FormalGuardrailPolicy {
  if (!input.policyId.trim() || !input.version.trim() || !input.locale.trim()) throw new GuardrailError("INVALID_POLICY", "policy identifiers and locale must be non-empty");
  assertPositiveInteger(input.maxSegments, "maxSegments");
  assertPositiveInteger(input.maxResponseChars, "maxResponseChars");
  for (const claimClass of CLAIM_CLASSES) assertClaimPolicy(input.claimPolicies[claimClass], claimClass);

  const copyIds = new Set<string>();
  for (const item of input.copy) {
    if (!item.id.trim() || !item.locale.trim() || !item.text.trim()) throw new GuardrailError("INVALID_POLICY", "approved copy fields must be non-empty");
    if (copyIds.has(item.id)) throw new GuardrailError("INVALID_POLICY", `duplicate approved copy ${item.id}`);
    copyIds.add(item.id);
    if (!item.allowedStatuses.length) throw new GuardrailError("INVALID_POLICY", `approved copy ${item.id} has no allowed status`);
  }
  for (const requiredStatus of ["UNSUPPORTED", "CONFLICTED"] as const) {
    if (!input.copy.some((item) => item.kind === "ESCALATION" && item.locale === input.locale && item.allowedStatuses.includes(requiredStatus))) throw new GuardrailError("INVALID_POLICY", `policy requires an escalation copy for ${requiredStatus}`);
  }

  const templateIds = new Set<string>();
  const placeholders = new Set(["subject", "predicate", "value", "confidence"]);
  for (const template of input.templates) {
    if (!template.id.trim() || !template.locale.trim() || !template.text.trim()) throw new GuardrailError("INVALID_POLICY", "template fields must be non-empty");
    if (templateIds.has(template.id)) throw new GuardrailError("INVALID_POLICY", `duplicate template ${template.id}`);
    templateIds.add(template.id);
    const found = [...template.text.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
    for (const placeholder of found) if (!placeholders.has(placeholder)) throw new GuardrailError("INVALID_POLICY", `template ${template.id} uses unsupported placeholder ${placeholder}`);
    if (!template.text.includes("{value}")) throw new GuardrailError("INVALID_POLICY", `template ${template.id} must render the grounded value`);
  }
  for (const claimClass of CLAIM_CLASSES) {
    if (!input.templates.some((item) => item.locale === input.locale && item.claimClass === claimClass && item.qualified === false)) throw new GuardrailError("INVALID_POLICY", `missing exact template for ${claimClass}`);
    if (input.claimPolicies[claimClass].allowPartialSupport && !input.templates.some((item) => item.locale === input.locale && item.claimClass === claimClass && item.qualified === true)) throw new GuardrailError("INVALID_POLICY", `missing qualified template for ${claimClass}`);
  }

  const normalized = core(input);
  return Object.freeze({ ...normalized, digest: hash("kgpolicy", normalized) });
}

export function verifyGuardrailPolicy(policy: FormalGuardrailPolicy): void {
  const { digest, ...withoutDigest } = policy;
  const normalized = core(withoutDigest);
  if (hash("kgpolicy", normalized) !== digest) throw new GuardrailError("INTEGRITY_FAILURE", "guardrail policy digest mismatch");
  finalizeGuardrailPolicy(withoutDigest);
}
