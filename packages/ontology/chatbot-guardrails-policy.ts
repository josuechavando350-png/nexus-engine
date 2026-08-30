import { CLAIM_CLASSES, EVIDENCE_KINDS, hash, type KnowledgeClaimClass, type KnowledgeEvidenceKind } from "./chatbot-knowledge-types.js";
import {
  GuardrailError,
  type ApprovedCopy,
  type ApprovedFactTemplate,
  type ClaimGuardrailPolicy,
  type FormalGuardrailPolicy,
  type GuardrailCopyKind,
  type GuardrailRisk,
} from "./chatbot-guardrails-types.js";

const AUTHORITATIVE = ["FIRST_PARTY", "CRM", "WEBSITE", "DOCUMENT", "API", "OPERATOR_APPROVED"] as const satisfies readonly KnowledgeEvidenceKind[];
const STRONG = ["FIRST_PARTY", "CRM", "API", "OPERATOR_APPROVED"] as const satisfies readonly KnowledgeEvidenceKind[];
const GUARDRAIL_RISKS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const satisfies readonly GuardrailRisk[];
const COPY_KINDS = ["CONNECTOR", "QUESTION", "ESCALATION", "CLOSING"] as const satisfies readonly GuardrailCopyKind[];
const GROUNDING_STATUSES = ["SUPPORTED", "PARTIALLY_SUPPORTED", "UNSUPPORTED", "CONFLICTED"] as const;
const MAX_POLICY_SEGMENTS = 64;
const MAX_POLICY_RESPONSE_CHARS = 32_000;

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

function requiredAnyKinds(claimClass: KnowledgeClaimClass): readonly KnowledgeEvidenceKind[] | undefined {
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
  const requiredAnyEvidenceKinds = requiredAnyKinds(claimClass);
  return {
    claimClass,
    risk,
    minimumConfidence: risk === "CRITICAL" ? 0.95 : risk === "HIGH" ? 0.9 : risk === "MEDIUM" ? 0.8 : 0.75,
    minimumEvidenceCount: 1,
    allowedEvidenceKinds: AUTHORITATIVE,
    ...(requiredAnyEvidenceKinds ? { requiredAnyEvidenceKinds } : {}),
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

function assertPositiveInteger(value: number, field: string, maximum: number): void {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) throw new GuardrailError("INVALID_POLICY", `${field} must be an integer within 1..${maximum}`);
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, "en"));
}

function assertEvidenceKinds(values: readonly KnowledgeEvidenceKind[] | undefined, field: string, allowEmpty: boolean): void {
  if (values === undefined) return;
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) throw new GuardrailError("INVALID_POLICY", `${field} must be a non-empty evidence kind array`);
  for (const kind of values) if (!EVIDENCE_KINDS.includes(kind)) throw new GuardrailError("INVALID_POLICY", `${field} contains unsupported evidence kind ${String(kind)}`);
}

function normalizeClaimPolicy(value: ClaimGuardrailPolicy | undefined, claimClass: KnowledgeClaimClass): ClaimGuardrailPolicy {
  if (!value) throw new GuardrailError("INVALID_POLICY", `missing claim policy for ${claimClass}`);
  if (value.claimClass !== claimClass) throw new GuardrailError("INVALID_POLICY", `claim policy key ${claimClass} does not match ${String(value.claimClass)}`);
  if (!GUARDRAIL_RISKS.includes(value.risk)) throw new GuardrailError("INVALID_POLICY", `${claimClass}.risk is invalid`);
  if (!Number.isFinite(value.minimumConfidence) || value.minimumConfidence < 0 || value.minimumConfidence > 1) throw new GuardrailError("INVALID_POLICY", `${claimClass}.minimumConfidence must be within 0..1`);
  assertPositiveInteger(value.minimumEvidenceCount, `${claimClass}.minimumEvidenceCount`, 32);
  assertEvidenceKinds(value.allowedEvidenceKinds, `${claimClass}.allowedEvidenceKinds`, false);
  assertEvidenceKinds(value.requiredAnyEvidenceKinds, `${claimClass}.requiredAnyEvidenceKinds`, false);
  assertEvidenceKinds(value.requiredAllEvidenceKinds, `${claimClass}.requiredAllEvidenceKinds`, false);
  const allowed = sortedUnique(value.allowedEvidenceKinds);
  const requiredAny = value.requiredAnyEvidenceKinds ? sortedUnique(value.requiredAnyEvidenceKinds) : undefined;
  const requiredAll = value.requiredAllEvidenceKinds ? sortedUnique(value.requiredAllEvidenceKinds) : undefined;
  for (const kind of [...(requiredAny ?? []), ...(requiredAll ?? [])]) if (!allowed.includes(kind)) throw new GuardrailError("INVALID_POLICY", `${claimClass} requires evidence kind ${kind} that is not allowed`);
  if (typeof value.allowPartialSupport !== "boolean" || typeof value.requireSourceDigest !== "boolean") throw new GuardrailError("INVALID_POLICY", `${claimClass} boolean controls are invalid`);
  if (value.maxEvidenceAgeMs !== undefined && (!Number.isFinite(value.maxEvidenceAgeMs) || value.maxEvidenceAgeMs <= 0)) throw new GuardrailError("INVALID_POLICY", `${claimClass}.maxEvidenceAgeMs must be positive`);
  return {
    claimClass,
    risk: value.risk,
    minimumConfidence: value.minimumConfidence,
    minimumEvidenceCount: value.minimumEvidenceCount,
    allowedEvidenceKinds: allowed,
    ...(requiredAny ? { requiredAnyEvidenceKinds: requiredAny } : {}),
    ...(requiredAll ? { requiredAllEvidenceKinds: requiredAll } : {}),
    allowPartialSupport: value.allowPartialSupport,
    requireSourceDigest: value.requireSourceDigest,
    ...(value.maxEvidenceAgeMs === undefined ? {} : { maxEvidenceAgeMs: value.maxEvidenceAgeMs }),
  };
}

function normalizePolicy(input: Omit<FormalGuardrailPolicy, "digest">): Omit<FormalGuardrailPolicy, "digest"> {
  if (!input.policyId.trim() || !input.version.trim() || !input.locale.trim()) throw new GuardrailError("INVALID_POLICY", "policy identifiers and locale must be non-empty");
  assertPositiveInteger(input.maxSegments, "maxSegments", MAX_POLICY_SEGMENTS);
  assertPositiveInteger(input.maxResponseChars, "maxResponseChars", MAX_POLICY_RESPONSE_CHARS);
  if (typeof input.allowHistoricalGrounding !== "boolean") throw new GuardrailError("INVALID_POLICY", "allowHistoricalGrounding must be boolean");
  if (!input.claimPolicies || typeof input.claimPolicies !== "object") throw new GuardrailError("INVALID_POLICY", "claimPolicies must be present");
  if (!Array.isArray(input.copy) || !Array.isArray(input.templates)) throw new GuardrailError("INVALID_POLICY", "copy and templates must be arrays");

  const claimPolicies = Object.fromEntries(
    CLAIM_CLASSES.map((claimClass) => [claimClass, normalizeClaimPolicy(input.claimPolicies[claimClass], claimClass)]),
  ) as Readonly<Record<KnowledgeClaimClass, ClaimGuardrailPolicy>>;

  const copyIds = new Set<string>();
  const copy = input.copy.map((item) => {
    if (!item.id.trim() || !item.locale.trim() || !item.text.trim()) throw new GuardrailError("INVALID_POLICY", "approved copy fields must be non-empty");
    if (item.locale !== input.locale) throw new GuardrailError("INVALID_POLICY", `approved copy ${item.id} locale must match policy locale`);
    if (!COPY_KINDS.includes(item.kind)) throw new GuardrailError("INVALID_POLICY", `approved copy ${item.id} has invalid kind`);
    if (copyIds.has(item.id)) throw new GuardrailError("INVALID_POLICY", `duplicate approved copy ${item.id}`);
    copyIds.add(item.id);
    if (!Array.isArray(item.allowedStatuses) || item.allowedStatuses.length === 0) throw new GuardrailError("INVALID_POLICY", `approved copy ${item.id} has no allowed status`);
    for (const status of item.allowedStatuses) if (!GROUNDING_STATUSES.includes(status)) throw new GuardrailError("INVALID_POLICY", `approved copy ${item.id} contains invalid grounding status`);
    return { ...item, allowedStatuses: sortedUnique(item.allowedStatuses) };
  }).sort((a, b) => a.id.localeCompare(b.id, "en"));

  for (const requiredStatus of ["UNSUPPORTED", "CONFLICTED"] as const) {
    if (!copy.some((item) => item.kind === "ESCALATION" && item.allowedStatuses.includes(requiredStatus))) throw new GuardrailError("INVALID_POLICY", `policy requires an escalation copy for ${requiredStatus}`);
  }

  const templateIds = new Set<string>();
  const placeholders = new Set(["subject", "predicate", "value", "confidence"]);
  const templates = input.templates.map((template) => {
    if (!template.id.trim() || !template.locale.trim() || !template.text.trim()) throw new GuardrailError("INVALID_POLICY", "template fields must be non-empty");
    if (template.locale !== input.locale) throw new GuardrailError("INVALID_POLICY", `template ${template.id} locale must match policy locale`);
    if (!CLAIM_CLASSES.includes(template.claimClass)) throw new GuardrailError("INVALID_POLICY", `template ${template.id} has invalid claim class`);
    if (typeof template.qualified !== "boolean") throw new GuardrailError("INVALID_POLICY", `template ${template.id} qualified must be boolean`);
    if (templateIds.has(template.id)) throw new GuardrailError("INVALID_POLICY", `duplicate template ${template.id}`);
    templateIds.add(template.id);
    const found = [...template.text.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
    for (const placeholder of found) if (!placeholders.has(placeholder)) throw new GuardrailError("INVALID_POLICY", `template ${template.id} uses unsupported placeholder ${placeholder}`);
    const stripped = template.text.replace(/\{(?:subject|predicate|value|confidence)\}/g, "");
    if (stripped.includes("{") || stripped.includes("}")) throw new GuardrailError("INVALID_POLICY", `template ${template.id} contains malformed placeholder syntax`);
    if (!template.text.includes("{value}")) throw new GuardrailError("INVALID_POLICY", `template ${template.id} must render the grounded value`);
    if (template.predicates !== undefined && (!Array.isArray(template.predicates) || template.predicates.some((predicate) => !predicate.trim()))) throw new GuardrailError("INVALID_POLICY", `template ${template.id} predicates must be non-empty strings`);
    return { ...template, ...(template.predicates ? { predicates: sortedUnique(template.predicates) } : {}) };
  }).sort((a, b) => a.id.localeCompare(b.id, "en"));

  for (const claimClass of CLAIM_CLASSES) {
    if (!templates.some((item) => item.claimClass === claimClass && item.qualified === false)) throw new GuardrailError("INVALID_POLICY", `missing exact template for ${claimClass}`);
    if (claimPolicies[claimClass].allowPartialSupport && !templates.some((item) => item.claimClass === claimClass && item.qualified === true)) throw new GuardrailError("INVALID_POLICY", `missing qualified template for ${claimClass}`);
  }

  return {
    policyId: input.policyId.trim(),
    version: input.version.trim(),
    locale: input.locale.trim(),
    maxSegments: input.maxSegments,
    maxResponseChars: input.maxResponseChars,
    allowHistoricalGrounding: input.allowHistoricalGrounding,
    claimPolicies,
    copy,
    templates,
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.getOwnPropertyNames(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

export function createDefaultGuardrailPolicy(): FormalGuardrailPolicy {
  const claimPolicies = Object.fromEntries(CLAIM_CLASSES.map((claimClass) => [claimClass, claimPolicy(claimClass)])) as Readonly<Record<KnowledgeClaimClass, ClaimGuardrailPolicy>>;
  return finalizeGuardrailPolicy({ policyId: "nexus.chatbot.guardrails.default", version: "1.0.0", locale: "es-MX", maxSegments: 12, maxResponseChars: 4_000, allowHistoricalGrounding: false, claimPolicies, copy: DEFAULT_COPY, templates: DEFAULT_TEMPLATES });
}

export function finalizeGuardrailPolicy(input: Omit<FormalGuardrailPolicy, "digest">): FormalGuardrailPolicy {
  const normalized = normalizePolicy(input);
  return deepFreeze({ ...normalized, digest: hash("kgpolicy", normalized) });
}

export function verifyGuardrailPolicy(policy: FormalGuardrailPolicy): void {
  const { digest, ...withoutDigest } = policy;
  const normalized = normalizePolicy(withoutDigest);
  if (hash("kgpolicy", normalized) !== digest) throw new GuardrailError("INTEGRITY_FAILURE", "guardrail policy digest mismatch");
}
