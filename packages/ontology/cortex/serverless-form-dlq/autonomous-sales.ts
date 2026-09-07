import { createHash, createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { FormSubmission, LeadDestination } from "./index.js";
import type { Cortex20Mode } from "./runtime-control.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,191}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const DOMAIN = /^(?=.{3,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/u;
const SENSITIVE_FEATURE_NAMES = new Set([
  "age", "birthDate", "sex", "gender", "race", "ethnicity", "religion", "health", "disability",
  "politicalAffiliation", "sexualOrientation", "preciseLocation", "latitude", "longitude", "email",
  "phone", "name", "address", "ipAddress", "fingerprint",
]);

export type SalesChannel = "WHATSAPP" | "SMS";
export type SalesRequestedAction =
  | "FOLLOW_UP"
  | "CUSTOM_PRICE"
  | "DISCOUNT"
  | "CONTRACT"
  | "PAYMENT_TERMS"
  | "LEGAL_COMMITMENT"
  | "HUMAN_HANDOFF";
export type SalesAutomationStatus = "AUTONOMOUS_SENT" | "HANDOFF_REQUIRED" | "NO_AUTOMATION";

const SENSITIVE_ACTIONS = new Set<SalesRequestedAction>([
  "CUSTOM_PRICE", "DISCOUNT", "CONTRACT", "PAYMENT_TERMS", "LEGAL_COMMITMENT", "HUMAN_HANDOFF",
]);

export interface ModelFeature {
  readonly source: "FORM" | "ENRICHMENT";
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly weight: number;
}

export interface PredictiveLeadModel {
  readonly modelId: string;
  readonly modelDigest: `sha256:${string}`;
  readonly intercept: number;
  readonly features: readonly ModelFeature[];
}

export interface PredictiveClvModel {
  readonly modelId: string;
  readonly modelDigest: `sha256:${string}`;
  readonly currency: string;
  readonly intercept: number;
  readonly minValue: number;
  readonly maxValue: number;
  readonly features: readonly ModelFeature[];
}

export interface FormSalesPolicy {
  readonly formId: string;
  readonly companyDomainField: string | null;
  readonly enrichmentEnabled: boolean;
  readonly allowedEnrichmentProviderIds: readonly string[];
  readonly leadModel: PredictiveLeadModel;
  readonly clvModel: PredictiveClvModel;
  readonly minLeadScoreForAutonomousFollowUp: number;
  readonly routes: readonly {
    readonly channel: SalesChannel;
    readonly contactField: string;
    readonly capabilityId: string;
  }[];
  readonly llmBusinessContext: string;
}

export interface AutonomousSalesPolicy {
  readonly version: 1;
  readonly forms: readonly FormSalesPolicy[];
}

export interface B2bEnrichmentResult {
  readonly providerId: string;
  readonly evidenceId: string;
  readonly domain: string;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

export interface B2bEnrichmentProvider {
  readonly providerId: string;
  enrich(domain: string, idempotencyKey: string): Promise<B2bEnrichmentResult>;
}

export interface ConsentDecision {
  readonly decisionId: string;
  readonly status: "GRANTED" | "DENIED" | "REVOKED";
  readonly channel: SalesChannel;
  readonly contactHash: `sha256:${string}`;
  readonly expiresAt: string;
}

export interface ConsentRegistryProvider {
  resolve(contactHash: `sha256:${string}`, channel: SalesChannel): Promise<ConsentDecision>;
}

export interface CapabilityDecision {
  readonly capabilityId: string;
  readonly mode: "ACTIVE" | "OBSERVE_ONLY" | "KILLED";
  readonly revision: number;
  readonly policyDigest: `sha256:${string}`;
}

export interface CapabilityGateProvider {
  read(capabilityId: string): Promise<CapabilityDecision>;
}

export interface LocalSalesAssistantInput {
  readonly businessContext: string;
  readonly leadScore: number;
  readonly predictedClv: number;
  readonly clvCurrency: string;
  readonly enrichment: Readonly<Record<string, string | number | boolean>>;
}

export interface LocalSalesAssistantResult {
  readonly modelId: string;
  readonly modelDigest: `sha256:${string}`;
  readonly classification: string;
  readonly summary: string;
  readonly suggestedMessage: string;
  readonly requestedAction: SalesRequestedAction;
}

export interface LocalSalesAssistant {
  draft(input: LocalSalesAssistantInput): Promise<LocalSalesAssistantResult>;
}

export interface ChannelDispatcher {
  send(input: {
    channel: SalesChannel;
    contact: string;
    message: string;
    idempotencyKey: string;
  }): Promise<{ receiptId: string }>;
}

export interface HumanHandoffDestination {
  handoff(input: {
    submissionId: string;
    formId: string;
    leadScore: number;
    predictedClv: number;
    clvCurrency: string;
    requestedAction: SalesRequestedAction;
    summary: string;
    idempotencyKey: string;
  }): Promise<{ receiptId: string }>;
}

export interface AutonomousSalesDependencies {
  readonly primaryDestination: LeadDestination;
  readonly enrichment: B2bEnrichmentProvider | null;
  readonly consentRegistry: ConsentRegistryProvider;
  readonly capabilityGate: CapabilityGateProvider;
  readonly assistant: LocalSalesAssistant;
  readonly channelDispatcher: ChannelDispatcher;
  readonly humanHandoff: HumanHandoffDestination;
  readonly contactHashSecret: string;
  readonly readMode: () => Cortex20Mode;
  readonly now?: () => number;
}

export interface SalesAutomationAuditRecord {
  readonly eventId: string;
  readonly submissionHash: `sha256:${string}`;
  readonly formId: string;
  readonly leadModelDigest: `sha256:${string}` | null;
  readonly clvModelDigest: `sha256:${string}` | null;
  readonly leadScore: number | null;
  readonly predictedClv: number | null;
  readonly clvCurrency: string | null;
  readonly enrichmentProviderId: string | null;
  readonly enrichmentEvidenceId: string | null;
  readonly assistantModelDigest: `sha256:${string}` | null;
  readonly requestedAction: SalesRequestedAction | null;
  readonly channel: SalesChannel | null;
  readonly consentDecisionId: string | null;
  readonly capabilityPolicyDigest: `sha256:${string}` | null;
  readonly status: SalesAutomationStatus;
  readonly remoteReceiptId: string;
  readonly createdAt: string;
}

export class Cortex40Error extends Error {
  constructor(
    public readonly code:
      | "INVALID_CONFIG"
      | "INVALID_INPUT"
      | "CONSENT_BLOCKED"
      | "CAPABILITY_BLOCKED"
      | "MODE_BLOCKED"
      | "INTEGRITY_FAILURE"
      | "CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "Cortex40Error";
  }
}

function safeMode(provider: () => Cortex20Mode): Cortex20Mode {
  try {
    const mode = provider();
    return mode === "ACTIVE" || mode === "OBSERVE_ONLY" || mode === "KILLED" ? mode : "KILLED";
  } catch {
    return "KILLED";
  }
}

function finite(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Cortex40Error("INVALID_CONFIG", `${label} is out of range`);
  }
  return value;
}

function secureSecret(value: string): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 4096 || /[\r\n\0]/u.test(value)) {
    throw new Cortex40Error("INVALID_CONFIG", "contact hash secret is invalid");
  }
  return value;
}

function validateFeature(feature: ModelFeature, label: string): ModelFeature {
  if (
    !(feature.source === "FORM" || feature.source === "ENRICHMENT") ||
    !ID.test(feature.name) ||
    SENSITIVE_FEATURE_NAMES.has(feature.name) ||
    !Number.isFinite(feature.min) ||
    !Number.isFinite(feature.max) ||
    feature.max <= feature.min ||
    !Number.isFinite(feature.weight) ||
    Math.abs(feature.weight) > 100
  ) {
    throw new Cortex40Error("INVALID_CONFIG", `${label} is invalid or sensitive`);
  }
  return Object.freeze({ ...feature });
}

function validateLeadModel(model: PredictiveLeadModel): PredictiveLeadModel {
  if (
    !ID.test(model.modelId) ||
    !SHA256.test(model.modelDigest) ||
    !Number.isFinite(model.intercept) ||
    !Array.isArray(model.features) ||
    model.features.length < 1 ||
    model.features.length > 64
  ) {
    throw new Cortex40Error("INVALID_CONFIG", "lead model is invalid");
  }
  const features = model.features.map((feature, index) => validateFeature(feature, `lead feature ${index}`));
  if (new Set(features.map((feature) => `${feature.source}:${feature.name}`)).size !== features.length) {
    throw new Cortex40Error("INVALID_CONFIG", "lead model features are duplicated");
  }
  return Object.freeze({ ...model, features: Object.freeze(features) });
}

function validateClvModel(model: PredictiveClvModel): PredictiveClvModel {
  if (
    !ID.test(model.modelId) ||
    !SHA256.test(model.modelDigest) ||
    !/^[A-Z]{3}$/u.test(model.currency) ||
    !Number.isFinite(model.intercept) ||
    !Number.isFinite(model.minValue) ||
    !Number.isFinite(model.maxValue) ||
    model.minValue < 0 ||
    model.maxValue < model.minValue ||
    !Array.isArray(model.features) ||
    model.features.length < 1 ||
    model.features.length > 64
  ) {
    throw new Cortex40Error("INVALID_CONFIG", "CLV model is invalid");
  }
  const features = model.features.map((feature, index) => validateFeature(feature, `CLV feature ${index}`));
  if (new Set(features.map((feature) => `${feature.source}:${feature.name}`)).size !== features.length) {
    throw new Cortex40Error("INVALID_CONFIG", "CLV model features are duplicated");
  }
  return Object.freeze({ ...model, features: Object.freeze(features) });
}

export function createAutonomousSalesPolicy(input: AutonomousSalesPolicy): AutonomousSalesPolicy {
  if (input.version !== 1 || !Array.isArray(input.forms) || input.forms.length < 1 || input.forms.length > 256) {
    throw new Cortex40Error("INVALID_CONFIG", "sales automation policy is invalid");
  }
  const seen = new Set<string>();
  const forms = input.forms.map((form): FormSalesPolicy => {
    if (!ID.test(form.formId) || seen.has(form.formId)) {
      throw new Cortex40Error("INVALID_CONFIG", "form policy is malformed or duplicated");
    }
    seen.add(form.formId);
    if (
      form.companyDomainField !== null &&
      (!ID.test(form.companyDomainField) || SENSITIVE_FEATURE_NAMES.has(form.companyDomainField))
    ) {
      throw new Cortex40Error("INVALID_CONFIG", "company domain field is invalid");
    }
    if (
      !Array.isArray(form.allowedEnrichmentProviderIds) ||
      form.allowedEnrichmentProviderIds.some((value) => !ID.test(value)) ||
      new Set(form.allowedEnrichmentProviderIds).size !== form.allowedEnrichmentProviderIds.length ||
      (form.enrichmentEnabled && form.allowedEnrichmentProviderIds.length < 1)
    ) {
      throw new Cortex40Error("INVALID_CONFIG", "enrichment provider allowlist is invalid");
    }
    if (!Array.isArray(form.routes) || form.routes.length > 2) {
      throw new Cortex40Error("INVALID_CONFIG", "contact routes are invalid");
    }
    const routes = form.routes.map((route) => {
      if (
        !(route.channel === "WHATSAPP" || route.channel === "SMS") ||
        !ID.test(route.contactField) ||
        !ID.test(route.capabilityId)
      ) {
        throw new Cortex40Error("INVALID_CONFIG", "contact route is invalid");
      }
      return Object.freeze({ ...route });
    });
    if (new Set(routes.map((route) => route.channel)).size !== routes.length) {
      throw new Cortex40Error("INVALID_CONFIG", "contact routes are duplicated");
    }
    if (
      typeof form.llmBusinessContext !== "string" ||
      form.llmBusinessContext.length < 1 ||
      form.llmBusinessContext.length > 8000
    ) {
      throw new Cortex40Error("INVALID_CONFIG", "LLM business context is invalid");
    }
    return Object.freeze({
      ...form,
      allowedEnrichmentProviderIds: Object.freeze([...form.allowedEnrichmentProviderIds]),
      leadModel: validateLeadModel(form.leadModel),
      clvModel: validateClvModel(form.clvModel),
      minLeadScoreForAutonomousFollowUp: finite(
        form.minLeadScoreForAutonomousFollowUp,
        "minLeadScoreForAutonomousFollowUp",
        0,
        1,
      ),
      routes: Object.freeze(routes),
    });
  });
  return Object.freeze({ version: 1, forms: Object.freeze(forms) });
}

function contactHash(contact: string, secret: string): `sha256:${string}` {
  if (typeof contact !== "string" || contact.trim().length < 3 || contact.length > 1024 || /[\r\n\0]/u.test(contact)) {
    throw new Cortex40Error("INVALID_INPUT", "contact value is malformed");
  }
  return `sha256:${createHmac("sha256", secureSecret(secret))
    .update(contact.trim().toLocaleLowerCase("en-US"), "utf8")
    .digest("hex")}`;
}

function numeric(value: string | number | boolean | undefined, label: string): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Cortex40Error("INVALID_INPUT", `${label} is not numeric`);
  return parsed;
}

function featureValue(
  feature: ModelFeature,
  submission: FormSubmission,
  enrichment: Readonly<Record<string, string | number | boolean>>,
): number {
  const raw = feature.source === "FORM" ? submission.fields[feature.name] : enrichment[feature.name];
  const value = numeric(raw, `${feature.source}.${feature.name}`);
  const clipped = Math.min(feature.max, Math.max(feature.min, value));
  return (clipped - feature.min) / (feature.max - feature.min);
}

function calculateLeadScore(
  model: PredictiveLeadModel,
  submission: FormSubmission,
  enrichment: Readonly<Record<string, string | number | boolean>>,
): number {
  const z = model.features.reduce(
    (sum, feature) => sum + featureValue(feature, submission, enrichment) * feature.weight,
    model.intercept,
  );
  const probability = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
  return Math.round(probability * 1_000_000) / 1_000_000;
}

function calculateClv(
  model: PredictiveClvModel,
  submission: FormSubmission,
  enrichment: Readonly<Record<string, string | number | boolean>>,
): number {
  const predicted = model.features.reduce(
    (sum, feature) => sum + featureValue(feature, submission, enrichment) * feature.weight,
    model.intercept,
  );
  return Math.round(Math.min(model.maxValue, Math.max(model.minValue, predicted)) * 100) / 100;
}

function sanitizeEnrichment(result: B2bEnrichmentResult, expectedDomain: string): B2bEnrichmentResult {
  if (
    !ID.test(result.providerId) ||
    !ID.test(result.evidenceId) ||
    result.domain !== expectedDomain ||
    !result.attributes ||
    typeof result.attributes !== "object" ||
    Array.isArray(result.attributes) ||
    Object.keys(result.attributes).length > 128
  ) {
    throw new Cortex40Error("INTEGRITY_FAILURE", "B2B enrichment receipt is invalid");
  }
  const attributes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(result.attributes)) {
    if (!ID.test(key) || SENSITIVE_FEATURE_NAMES.has(key)) {
      throw new Cortex40Error("INTEGRITY_FAILURE", `B2B enrichment contains forbidden attribute ${key}`);
    }
    if (!(typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
      throw new Cortex40Error("INTEGRITY_FAILURE", "B2B enrichment attribute type is invalid");
    }
    if (typeof value === "string" && value.length > 2048) {
      throw new Cortex40Error("INTEGRITY_FAILURE", "B2B enrichment attribute is oversized");
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Cortex40Error("INTEGRITY_FAILURE", "B2B enrichment number is invalid");
    }
    attributes[key] = value;
  }
  return Object.freeze({ ...result, attributes: Object.freeze(attributes) });
}

function validateAssistantResult(result: LocalSalesAssistantResult): LocalSalesAssistantResult {
  if (
    !ID.test(result.modelId) ||
    !SHA256.test(result.modelDigest) ||
    !ID.test(result.classification) ||
    typeof result.summary !== "string" ||
    result.summary.length > 4000 ||
    typeof result.suggestedMessage !== "string" ||
    result.suggestedMessage.length < 1 ||
    result.suggestedMessage.length > 4000 ||
    !(
      result.requestedAction === "FOLLOW_UP" ||
      result.requestedAction === "CUSTOM_PRICE" ||
      result.requestedAction === "DISCOUNT" ||
      result.requestedAction === "CONTRACT" ||
      result.requestedAction === "PAYMENT_TERMS" ||
      result.requestedAction === "LEGAL_COMMITMENT" ||
      result.requestedAction === "HUMAN_HANDOFF"
    )
  ) {
    throw new Cortex40Error("INTEGRITY_FAILURE", "local assistant output is invalid");
  }
  return Object.freeze({ ...result });
}

export class SqliteSalesAutomationAudit {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    if (!databasePath) throw new Cortex40Error("INVALID_CONFIG", "audit databasePath is required");
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS cortex40_sales_audit(
      event_id TEXT PRIMARY KEY,
      submission_hash TEXT NOT NULL,
      form_id TEXT NOT NULL,
      lead_model_digest TEXT,
      clv_model_digest TEXT,
      lead_score REAL,
      predicted_clv REAL,
      clv_currency TEXT,
      enrichment_provider_id TEXT,
      enrichment_evidence_id TEXT,
      assistant_model_digest TEXT,
      requested_action TEXT,
      channel TEXT,
      consent_decision_id TEXT,
      capability_policy_digest TEXT,
      status TEXT NOT NULL,
      remote_receipt_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );`);
  }

  close(): void { this.db.close(); }

  get(eventId: string): SalesAutomationAuditRecord | undefined {
    if (!ID.test(eventId)) throw new Cortex40Error("INVALID_INPUT", "audit eventId is malformed");
    const row = this.db.prepare("SELECT * FROM cortex40_sales_audit WHERE event_id=?").get(eventId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const record: SalesAutomationAuditRecord = {
      eventId: String(row.event_id),
      submissionHash: String(row.submission_hash) as `sha256:${string}`,
      formId: String(row.form_id),
      leadModelDigest: row.lead_model_digest === null ? null : String(row.lead_model_digest) as `sha256:${string}`,
      clvModelDigest: row.clv_model_digest === null ? null : String(row.clv_model_digest) as `sha256:${string}`,
      leadScore: row.lead_score === null ? null : Number(row.lead_score),
      predictedClv: row.predicted_clv === null ? null : Number(row.predicted_clv),
      clvCurrency: row.clv_currency === null ? null : String(row.clv_currency),
      enrichmentProviderId: row.enrichment_provider_id === null ? null : String(row.enrichment_provider_id),
      enrichmentEvidenceId: row.enrichment_evidence_id === null ? null : String(row.enrichment_evidence_id),
      assistantModelDigest: row.assistant_model_digest === null ? null : String(row.assistant_model_digest) as `sha256:${string}`,
      requestedAction: row.requested_action === null ? null : String(row.requested_action) as SalesRequestedAction,
      channel: row.channel === null ? null : String(row.channel) as SalesChannel,
      consentDecisionId: row.consent_decision_id === null ? null : String(row.consent_decision_id),
      capabilityPolicyDigest: row.capability_policy_digest === null ? null : String(row.capability_policy_digest) as `sha256:${string}`,
      status: String(row.status) as SalesAutomationStatus,
      remoteReceiptId: String(row.remote_receipt_id),
      createdAt: String(row.created_at),
    };
    if (
      !SHA256.test(record.submissionHash) ||
      !ID.test(record.formId) ||
      (record.leadModelDigest !== null && !SHA256.test(record.leadModelDigest)) ||
      (record.clvModelDigest !== null && !SHA256.test(record.clvModelDigest)) ||
      (record.assistantModelDigest !== null && !SHA256.test(record.assistantModelDigest)) ||
      (record.capabilityPolicyDigest !== null && !SHA256.test(record.capabilityPolicyDigest)) ||
      !ID.test(record.remoteReceiptId) ||
      !Number.isFinite(Date.parse(record.createdAt))
    ) {
      throw new Cortex40Error("INTEGRITY_FAILURE", "stored sales audit is corrupt");
    }
    return Object.freeze(record);
  }

  commit(record: SalesAutomationAuditRecord): SalesAutomationAuditRecord {
    const existing = this.get(record.eventId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new Cortex40Error("CONFLICT", "sales audit eventId is already bound to different content");
      }
      return existing;
    }
    this.db.prepare(`INSERT INTO cortex40_sales_audit(
      event_id,submission_hash,form_id,lead_model_digest,clv_model_digest,lead_score,predicted_clv,clv_currency,
      enrichment_provider_id,enrichment_evidence_id,assistant_model_digest,requested_action,channel,consent_decision_id,
      capability_policy_digest,status,remote_receipt_id,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      record.eventId,
      record.submissionHash,
      record.formId,
      record.leadModelDigest,
      record.clvModelDigest,
      record.leadScore,
      record.predictedClv,
      record.clvCurrency,
      record.enrichmentProviderId,
      record.enrichmentEvidenceId,
      record.assistantModelDigest,
      record.requestedAction,
      record.channel,
      record.consentDecisionId,
      record.capabilityPolicyDigest,
      record.status,
      record.remoteReceiptId,
      record.createdAt,
    );
    return record;
  }
}

interface RouteCandidate {
  readonly route: FormSalesPolicy["routes"][number];
  readonly contact: string;
  readonly contactHash: `sha256:${string}`;
  readonly consent: ConsentDecision;
  readonly capability: CapabilityDecision;
}

export class AutonomousSalesLeadDestination implements LeadDestination {
  private readonly policy: AutonomousSalesPolicy;
  private readonly now: () => number;

  constructor(
    policy: AutonomousSalesPolicy,
    private readonly audit: SqliteSalesAutomationAudit,
    private readonly deps: AutonomousSalesDependencies,
  ) {
    this.policy = createAutonomousSalesPolicy(policy);
    this.now = deps.now ?? Date.now;
    secureSecret(deps.contactHashSecret);
  }

  async deliver(submission: FormSubmission, idempotencyKey: string): Promise<{ receiptId: string }> {
    if (!ID.test(idempotencyKey)) throw new Cortex40Error("INVALID_INPUT", "idempotencyKey is malformed");
    if (safeMode(this.deps.readMode) !== "ACTIVE") {
      throw new Cortex40Error("MODE_BLOCKED", "autonomous sales destination is not ACTIVE");
    }

    const eventId = `sales-${createHash("sha256").update(idempotencyKey, "utf8").digest("hex").slice(0, 32)}`;
    const previous = this.audit.get(eventId);
    if (previous) return { receiptId: previous.remoteReceiptId };

    // The primary CRM/destination remains the first downstream effect of the existing #20 worker.
    // It receives the same idempotency key, so a retry after later automation failure is safe.
    if (safeMode(this.deps.readMode) !== "ACTIVE") {
      throw new Cortex40Error("MODE_BLOCKED", "sales automation killed before primary lead delivery");
    }
    const primary = await this.deps.primaryDestination.deliver(submission, idempotencyKey);
    if (!ID.test(primary.receiptId)) throw new Cortex40Error("INTEGRITY_FAILURE", "primary lead receipt is invalid");

    const formPolicy = this.policy.forms.find((candidate) => candidate.formId === submission.formId) ?? null;
    if (!formPolicy) {
      const record = this.auditRecord(eventId, submission, null, null, null, null, null, null, "NO_AUTOMATION", primary.receiptId);
      this.audit.commit(record);
      return { receiptId: primary.receiptId };
    }

    let enrichmentResult: B2bEnrichmentResult | null = null;
    let enrichment: Readonly<Record<string, string | number | boolean>> = Object.freeze({});
    if (formPolicy.enrichmentEnabled && this.deps.enrichment && formPolicy.companyDomainField) {
      if (!formPolicy.allowedEnrichmentProviderIds.includes(this.deps.enrichment.providerId)) {
        throw new Cortex40Error("CAPABILITY_BLOCKED", "configured B2B enrichment provider is not allowlisted");
      }
      const domain = submission.fields[formPolicy.companyDomainField]?.trim().toLowerCase();
      if (domain) {
        if (!DOMAIN.test(domain)) throw new Cortex40Error("INVALID_INPUT", "company domain is malformed");
        const rawResult = await this.deps.enrichment.enrich(domain, `${eventId}-enrich`);
        if (rawResult.providerId !== this.deps.enrichment.providerId) {
          throw new Cortex40Error("INTEGRITY_FAILURE", "B2B enrichment provider identity mismatch");
        }
        enrichmentResult = sanitizeEnrichment(rawResult, domain);
        enrichment = enrichmentResult.attributes;
      }
    }

    const score = calculateLeadScore(formPolicy.leadModel, submission, enrichment);
    const clv = calculateClv(formPolicy.clvModel, submission, enrichment);
    if (score < formPolicy.minLeadScoreForAutonomousFollowUp || formPolicy.routes.length === 0) {
      const record = this.auditRecord(
        eventId,
        submission,
        formPolicy,
        enrichmentResult,
        null,
        score,
        clv,
        null,
        "NO_AUTOMATION",
        primary.receiptId,
      );
      this.audit.commit(record);
      return { receiptId: primary.receiptId };
    }

    // The local model receives no raw form fields or contact details.
    const assistant = validateAssistantResult(await this.deps.assistant.draft({
      businessContext: formPolicy.llmBusinessContext,
      leadScore: score,
      predictedClv: clv,
      clvCurrency: formPolicy.clvModel.currency,
      enrichment,
    }));

    if (SENSITIVE_ACTIONS.has(assistant.requestedAction)) {
      if (safeMode(this.deps.readMode) !== "ACTIVE") {
        throw new Cortex40Error("MODE_BLOCKED", "sales automation killed before mandatory human handoff");
      }
      const handoff = await this.deps.humanHandoff.handoff({
        submissionId: submission.submissionId,
        formId: submission.formId,
        leadScore: score,
        predictedClv: clv,
        clvCurrency: formPolicy.clvModel.currency,
        requestedAction: assistant.requestedAction,
        summary: assistant.summary,
        idempotencyKey: `${eventId}-handoff`,
      });
      if (!ID.test(handoff.receiptId)) throw new Cortex40Error("INTEGRITY_FAILURE", "human handoff receipt is invalid");
      const record = this.auditRecord(
        eventId,
        submission,
        formPolicy,
        enrichmentResult,
        assistant,
        score,
        clv,
        null,
        "HANDOFF_REQUIRED",
        handoff.receiptId,
      );
      this.audit.commit(record);
      return { receiptId: handoff.receiptId };
    }

    if (assistant.requestedAction !== "FOLLOW_UP") {
      throw new Cortex40Error("INTEGRITY_FAILURE", "unsupported autonomous assistant action");
    }

    const candidate = await this.chooseRoute(submission, formPolicy);
    if (!candidate) {
      const record = this.auditRecord(
        eventId,
        submission,
        formPolicy,
        enrichmentResult,
        assistant,
        score,
        clv,
        null,
        "NO_AUTOMATION",
        primary.receiptId,
      );
      this.audit.commit(record);
      return { receiptId: primary.receiptId };
    }

    // Final boundary: both external decisions are reread and must remain the exact same identities.
    const finalConsent = await this.deps.consentRegistry.resolve(candidate.contactHash, candidate.route.channel);
    const finalCapability = await this.deps.capabilityGate.read(candidate.route.capabilityId);
    if (
      finalConsent.decisionId !== candidate.consent.decisionId ||
      finalConsent.status !== "GRANTED" ||
      finalConsent.contactHash !== candidate.contactHash ||
      finalConsent.channel !== candidate.route.channel ||
      Date.parse(finalConsent.expiresAt) <= this.now()
    ) {
      throw new Cortex40Error("CONSENT_BLOCKED", "contact consent changed before messaging boundary");
    }
    if (
      finalCapability.capabilityId !== candidate.capability.capabilityId ||
      finalCapability.mode !== "ACTIVE" ||
      finalCapability.revision !== candidate.capability.revision ||
      finalCapability.policyDigest !== candidate.capability.policyDigest
    ) {
      throw new Cortex40Error("CAPABILITY_BLOCKED", "contact capability changed before messaging boundary");
    }
    if (safeMode(this.deps.readMode) !== "ACTIVE") {
      throw new Cortex40Error("MODE_BLOCKED", "sales automation killed before messaging boundary");
    }

    const sent = await this.deps.channelDispatcher.send({
      channel: candidate.route.channel,
      contact: candidate.contact,
      message: assistant.suggestedMessage,
      idempotencyKey: `${eventId}-${candidate.route.channel.toLowerCase()}`,
    });
    if (!ID.test(sent.receiptId)) throw new Cortex40Error("INTEGRITY_FAILURE", "channel delivery receipt is invalid");
    const record = this.auditRecord(
      eventId,
      submission,
      formPolicy,
      enrichmentResult,
      assistant,
      score,
      clv,
      {
        channel: candidate.route.channel,
        consentDecisionId: candidate.consent.decisionId,
        capabilityPolicyDigest: candidate.capability.policyDigest,
      },
      "AUTONOMOUS_SENT",
      sent.receiptId,
    );
    this.audit.commit(record);
    return { receiptId: sent.receiptId };
  }

  private async chooseRoute(submission: FormSubmission, policy: FormSalesPolicy): Promise<RouteCandidate | null> {
    for (const route of policy.routes) {
      const contact = submission.fields[route.contactField];
      if (!contact) continue;
      const hashed = contactHash(contact, this.deps.contactHashSecret);
      const consent = await this.deps.consentRegistry.resolve(hashed, route.channel);
      if (
        consent.contactHash !== hashed ||
        consent.channel !== route.channel ||
        !ID.test(consent.decisionId) ||
        !Number.isFinite(Date.parse(consent.expiresAt))
      ) {
        throw new Cortex40Error("INTEGRITY_FAILURE", "consent registry response identity is invalid");
      }
      if (consent.status !== "GRANTED" || Date.parse(consent.expiresAt) <= this.now()) continue;

      const capability = await this.deps.capabilityGate.read(route.capabilityId);
      if (
        capability.capabilityId !== route.capabilityId ||
        !SHA256.test(capability.policyDigest) ||
        !Number.isSafeInteger(capability.revision) ||
        capability.revision < 0
      ) {
        throw new Cortex40Error("INTEGRITY_FAILURE", "capability gate response is invalid");
      }
      if (capability.mode !== "ACTIVE") continue;
      return Object.freeze({ route, contact, contactHash: hashed, consent, capability });
    }
    return null;
  }

  private auditRecord(
    eventId: string,
    submission: FormSubmission,
    formPolicy: FormSalesPolicy | null,
    enrichment: B2bEnrichmentResult | null,
    assistant: LocalSalesAssistantResult | null,
    score: number | null,
    clv: number | null,
    routeEvidence: {
      readonly channel: SalesChannel;
      readonly consentDecisionId: string;
      readonly capabilityPolicyDigest: `sha256:${string}`;
    } | null,
    status: SalesAutomationStatus,
    receiptId: string,
  ): SalesAutomationAuditRecord {
    return Object.freeze({
      eventId,
      submissionHash: `sha256:${createHash("sha256").update(submission.submissionId, "utf8").digest("hex")}`,
      formId: submission.formId,
      leadModelDigest: formPolicy?.leadModel.modelDigest ?? null,
      clvModelDigest: formPolicy?.clvModel.modelDigest ?? null,
      leadScore: score,
      predictedClv: clv,
      clvCurrency: formPolicy?.clvModel.currency ?? null,
      enrichmentProviderId: enrichment?.providerId ?? null,
      enrichmentEvidenceId: enrichment?.evidenceId ?? null,
      assistantModelDigest: assistant?.modelDigest ?? null,
      requestedAction: assistant?.requestedAction ?? null,
      channel: routeEvidence?.channel ?? null,
      consentDecisionId: routeEvidence?.consentDecisionId ?? null,
      capabilityPolicyDigest: routeEvidence?.capabilityPolicyDigest ?? null,
      status,
      remoteReceiptId: receiptId,
      createdAt: new Date(this.now()).toISOString(),
    });
  }
}
