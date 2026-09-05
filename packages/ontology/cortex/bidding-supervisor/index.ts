import { createHash } from "node:crypto";
import {
  canonicalJson,
  ontologyId,
  validateSchema,
  type OntologyScope,
  type SchemaVersion,
  type ValidatedSchema,
} from "@nexus/ontology";
import {
  OntologyTransactionError,
  type JsonValue,
  type ObjectRecord,
  type OntologyTransactionPort,
  type TransactionOperation,
} from "@nexus/ontology/transaction";
import {
  GoogleAdsApiError,
  type GoogleAdsCampaignSnapshot,
  type GoogleAdsControlMutation,
  type GoogleAdsMutationReceipt,
  type GoogleAdsPortfolioSnapshot,
  type GoogleAdsRestClient,
} from "./google-ads-rest";

const STATE_TYPE = "cortex.bidding_supervisor_state";
const RUN_TYPE = "cortex.bidding_supervisor_run";
const IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;

const STATE = Object.freeze({
  customerId: "cortex.bidding.state.customer_id",
  campaignId: "cortex.bidding.state.campaign_id",
  policyDigest: "cortex.bidding.state.policy_digest",
  payload: "cortex.bidding.state.payload",
  digest: "cortex.bidding.state.digest",
  updatedAt: "cortex.bidding.state.updated_at",
});

const RUN = Object.freeze({
  runId: "cortex.bidding.run.run_id",
  customerId: "cortex.bidding.run.customer_id",
  campaignId: "cortex.bidding.run.campaign_id",
  policyDigest: "cortex.bidding.run.policy_digest",
  status: "cortex.bidding.run.status",
  payload: "cortex.bidding.run.payload",
  digest: "cortex.bidding.run.digest",
  createdAt: "cortex.bidding.run.created_at",
  updatedAt: "cortex.bidding.run.updated_at",
});

export type BiddingSupervisorMode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";
export type BiddingSupervisorRunStatus = "PREPARED" | "APPLIED" | "NOOP" | "FAILED" | "ROLLED_BACK";
export type BiddingSupervisorDirection = "INCREASE_VOLUME" | "DECREASE_RISK" | "HOLD";
export type BiddingSupervisorActionKind = GoogleAdsControlMutation["kind"];

export type BiddingSupervisorReason =
  | "KILL_SWITCH"
  | "COOLDOWN"
  | "CAMPAIGN_NOT_ENABLED"
  | "INSUFFICIENT_EVIDENCE"
  | "STALE_BUSINESS_DATA"
  | "PROFITABILITY_HOLD"
  | "NO_COMPATIBLE_CONTROL"
  | "SHARED_BUDGET_BLOCKED"
  | "OBSERVE_ONLY"
  | "ACTION_APPLIED"
  | "ACTION_RECOVERED"
  | "REMOTE_CONFLICT"
  | "API_FAILURE"
  | "ROLLBACK_APPLIED";

export interface CreateBiddingSupervisorPolicyInput {
  readonly policyId: string;
  readonly version: string;
  readonly observationWindowDays: number;
  readonly reportingLagDays: number;
  readonly cooldownMs: number;
  readonly maxBusinessDataAgeMs: number;
  readonly minimumCostMicros: number;
  readonly minimumGoogleConversions: number;
  readonly increaseVolumeProfitToSpendRatio: number;
  readonly decreaseRiskProfitToSpendRatio: number;
  readonly budgetStepFraction: number;
  readonly targetStepFraction: number;
  readonly bidBoundStepFraction: number;
  readonly minBudgetMicros: number;
  readonly maxBudgetMicros: number;
  readonly minTargetCpaMicros: number;
  readonly maxTargetCpaMicros: number;
  readonly minTargetRoas: number;
  readonly maxTargetRoas: number;
  readonly minPortfolioCpcCeilingMicros: number;
  readonly maxPortfolioCpcCeilingMicros: number;
  readonly allowSharedBudgets: boolean;
  readonly managePortfolioBidBounds: boolean;
  readonly mode?: BiddingSupervisorMode;
  readonly maxWriteRetries?: number;
}

export interface BiddingSupervisorPolicy extends Omit<Required<CreateBiddingSupervisorPolicyInput>, "mode" | "maxWriteRetries"> {
  readonly mode: BiddingSupervisorMode;
  readonly maxWriteRetries: number;
  readonly digest: string;
}

export interface BusinessProfitabilityQuery {
  readonly customerId: string;
  readonly scopeKind: "CAMPAIGN" | "BIDDING_STRATEGY";
  readonly scopeId: string;
  readonly windowStart: string;
  readonly windowEnd: string;
}

export interface BusinessProfitabilitySnapshot extends BusinessProfitabilityQuery {
  readonly revenueMicros: number;
  readonly grossProfitBeforeAdSpendMicros: number;
  readonly qualifiedConversions: number;
  readonly observedAt: string;
  readonly sourceId: string;
}

export interface BusinessProfitabilityProvider {
  getProfitability(query: BusinessProfitabilityQuery): Promise<BusinessProfitabilitySnapshot>;
}

export interface BiddingSupervisorRunInput {
  readonly runId: string;
  readonly customerId: string;
  readonly campaignId: string;
  readonly mode?: BiddingSupervisorMode;
}

export interface BiddingSupervisorRollbackInput {
  readonly runId: string;
  readonly customerId: string;
  readonly campaignId: string;
}

export interface BiddingSupervisorEvidence {
  readonly googleCostMicros: number;
  readonly googleConversions: number;
  readonly googleConversionValue: number;
  readonly businessRevenueMicros: number;
  readonly businessGrossProfitBeforeAdSpendMicros: number;
  readonly businessQualifiedConversions: number;
  readonly profitAfterAdSpendMicros: number;
  readonly profitToSpendRatio: number;
  readonly sourceId: string;
}

export interface BiddingSupervisorResult {
  readonly runId: string;
  readonly customerId: string;
  readonly campaignId: string;
  readonly status: BiddingSupervisorRunStatus;
  readonly mode: BiddingSupervisorMode;
  readonly direction: BiddingSupervisorDirection;
  readonly reason: BiddingSupervisorReason;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly action: GoogleAdsControlMutation | null;
  readonly receipt: GoogleAdsMutationReceipt | null;
  readonly evidence: BiddingSupervisorEvidence | null;
  readonly policyDigest: string;
  readonly digest: string;
}

interface SupervisorStatePayload {
  readonly lastRunAt: string | null;
  readonly lastMutationAt: string | null;
  readonly lastActionKind: BiddingSupervisorActionKind | null;
  readonly inFlightRunId: string | null;
  readonly lastAppliedAction: GoogleAdsControlMutation | null;
  readonly lastRollbackAt: string | null;
}

interface SupervisorStateRecord extends SupervisorStatePayload {
  readonly id: string;
  readonly customerId: string;
  readonly campaignId: string;
  readonly policyDigest: string;
  readonly digest: string;
  readonly updatedAt: string;
  readonly revision: number;
}

interface SupervisorRunPayload {
  readonly mode: BiddingSupervisorMode;
  readonly direction: BiddingSupervisorDirection;
  readonly reason: BiddingSupervisorReason;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly campaignSnapshot: GoogleAdsCampaignSnapshot | null;
  readonly portfolioSnapshot: GoogleAdsPortfolioSnapshot | null;
  readonly businessSnapshot: BusinessProfitabilitySnapshot | null;
  readonly evidence: BiddingSupervisorEvidence | null;
  readonly action: GoogleAdsControlMutation | null;
  readonly receipt: GoogleAdsMutationReceipt | null;
  readonly errorCode: string | null;
}

interface SupervisorRunRecord extends SupervisorRunPayload {
  readonly id: string;
  readonly runId: string;
  readonly customerId: string;
  readonly campaignId: string;
  readonly policyDigest: string;
  readonly status: BiddingSupervisorRunStatus;
  readonly digest: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

export class BiddingSupervisorError extends Error {
  constructor(
    public readonly code:
      | "INVALID_INPUT"
      | "POLICY_VIOLATION"
      | "CONFLICT"
      | "INTEGRITY_FAILURE"
      | "PERSISTENCE_FAILURE"
      | "REMOTE_FAILURE",
    message: string,
  ) {
    super(message);
    this.name = "BiddingSupervisorError";
  }
}

function digest(namespace: string, value: unknown): string {
  return `sha256:${createHash("sha256").update(`${namespace}\n${canonicalJson(value)}`, "utf8").digest("hex")}`;
}

function normalizeIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!IDENTIFIER.test(normalized)) throw new BiddingSupervisorError("INVALID_INPUT", `${field} is malformed`);
  return normalized;
}

function normalizeCustomerId(value: string): string {
  const normalized = value.replaceAll("-", "").trim();
  if (!/^\d{5,20}$/.test(normalized)) throw new BiddingSupervisorError("INVALID_INPUT", "customerId is malformed");
  return normalized;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new BiddingSupervisorError("INVALID_INPUT", `${field} must be a positive safe integer`);
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new BiddingSupervisorError("INVALID_INPUT", `${field} must be a non-negative safe integer`);
  return value;
}

function fraction(value: number, field: string, max = 0.25): number {
  if (!Number.isFinite(value) || value <= 0 || value > max) throw new BiddingSupervisorError("INVALID_INPUT", `${field} must be greater than 0 and at most ${max}`);
  return value;
}

function finitePositive(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new BiddingSupervisorError("INVALID_INPUT", `${field} must be finite and positive`);
  return value;
}

function canonicalUtc(value: string, field: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new BiddingSupervisorError("INTEGRITY_FAILURE", `${field} must be canonical UTC`);
  return value;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function asJson(value: unknown, field: string): JsonValue {
  if (!isJsonValue(value)) throw new BiddingSupervisorError("INTEGRITY_FAILURE", `${field} must be finite JSON`);
  return value;
}

function asObject(value: JsonValue, field: string): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BiddingSupervisorError("INTEGRITY_FAILURE", `${field} must be an object`);
  return value as Record<string, JsonValue>;
}

function property(id: string, name: string, kind: "STRING" | "JSON" | "DATETIME", cardinality: "REQUIRED" | "OPTIONAL", immutable = false) {
  return { id, name, valueKind: kind, cardinality, unique: false, immutable } as const;
}

function supervisorSchema(scope: OntologyScope): ValidatedSchema {
  const schema: SchemaVersion = {
    version: "cortex-bidding-supervisor-v1",
    scope,
    properties: [
      property(STATE.customerId, "BiddingStateCustomerId", "STRING", "REQUIRED", true),
      property(STATE.campaignId, "BiddingStateCampaignId", "STRING", "REQUIRED", true),
      property(STATE.policyDigest, "BiddingStatePolicyDigest", "STRING", "REQUIRED", true),
      property(STATE.payload, "BiddingStatePayload", "JSON", "REQUIRED"),
      property(STATE.digest, "BiddingStateDigest", "STRING", "REQUIRED"),
      property(STATE.updatedAt, "BiddingStateUpdatedAt", "DATETIME", "REQUIRED"),
      property(RUN.runId, "BiddingRunId", "STRING", "REQUIRED", true),
      property(RUN.customerId, "BiddingRunCustomerId", "STRING", "REQUIRED", true),
      property(RUN.campaignId, "BiddingRunCampaignId", "STRING", "REQUIRED", true),
      property(RUN.policyDigest, "BiddingRunPolicyDigest", "STRING", "REQUIRED", true),
      property(RUN.status, "BiddingRunStatus", "STRING", "REQUIRED"),
      property(RUN.payload, "BiddingRunPayload", "JSON", "REQUIRED"),
      property(RUN.digest, "BiddingRunDigest", "STRING", "REQUIRED"),
      property(RUN.createdAt, "BiddingRunCreatedAt", "DATETIME", "REQUIRED", true),
      property(RUN.updatedAt, "BiddingRunUpdatedAt", "DATETIME", "REQUIRED"),
    ],
    interfaces: [],
    objects: [
      { id: STATE_TYPE, name: "CortexBiddingSupervisorState", propertyIds: Object.values(STATE), interfaceIds: [] },
      { id: RUN_TYPE, name: "CortexBiddingSupervisorRun", propertyIds: Object.values(RUN), interfaceIds: [] },
    ],
    relationships: [],
    actions: [],
    functions: [],
    events: [],
  };
  return validateSchema(schema);
}

export function createBiddingSupervisorPolicy(input: CreateBiddingSupervisorPolicyInput): BiddingSupervisorPolicy {
  const policyId = normalizeIdentifier(input.policyId, "policyId");
  const version = normalizeIdentifier(input.version, "version");
  const observationWindowDays = positiveInteger(input.observationWindowDays, "observationWindowDays");
  if (observationWindowDays > 90) throw new BiddingSupervisorError("INVALID_INPUT", "observationWindowDays must be at most 90");
  const reportingLagDays = positiveInteger(input.reportingLagDays, "reportingLagDays");
  if (reportingLagDays > 14) throw new BiddingSupervisorError("INVALID_INPUT", "reportingLagDays must be at most 14");
  const cooldownMs = positiveInteger(input.cooldownMs, "cooldownMs");
  const maxBusinessDataAgeMs = positiveInteger(input.maxBusinessDataAgeMs, "maxBusinessDataAgeMs");
  const minimumCostMicros = nonNegativeInteger(input.minimumCostMicros, "minimumCostMicros");
  if (!Number.isFinite(input.minimumGoogleConversions) || input.minimumGoogleConversions < 0) throw new BiddingSupervisorError("INVALID_INPUT", "minimumGoogleConversions must be non-negative");
  const increaseVolumeProfitToSpendRatio = finitePositive(input.increaseVolumeProfitToSpendRatio, "increaseVolumeProfitToSpendRatio");
  const decreaseRiskProfitToSpendRatio = finitePositive(input.decreaseRiskProfitToSpendRatio, "decreaseRiskProfitToSpendRatio");
  if (decreaseRiskProfitToSpendRatio >= increaseVolumeProfitToSpendRatio) {
    throw new BiddingSupervisorError("INVALID_INPUT", "decreaseRiskProfitToSpendRatio must be lower than increaseVolumeProfitToSpendRatio");
  }
  const budgetStepFraction = fraction(input.budgetStepFraction, "budgetStepFraction");
  const targetStepFraction = fraction(input.targetStepFraction, "targetStepFraction");
  const bidBoundStepFraction = fraction(input.bidBoundStepFraction, "bidBoundStepFraction");
  const minBudgetMicros = positiveInteger(input.minBudgetMicros, "minBudgetMicros");
  const maxBudgetMicros = positiveInteger(input.maxBudgetMicros, "maxBudgetMicros");
  if (minBudgetMicros >= maxBudgetMicros) throw new BiddingSupervisorError("INVALID_INPUT", "minBudgetMicros must be lower than maxBudgetMicros");
  const minTargetCpaMicros = positiveInteger(input.minTargetCpaMicros, "minTargetCpaMicros");
  const maxTargetCpaMicros = positiveInteger(input.maxTargetCpaMicros, "maxTargetCpaMicros");
  if (minTargetCpaMicros >= maxTargetCpaMicros) throw new BiddingSupervisorError("INVALID_INPUT", "minTargetCpaMicros must be lower than maxTargetCpaMicros");
  const minTargetRoas = finitePositive(input.minTargetRoas, "minTargetRoas");
  const maxTargetRoas = finitePositive(input.maxTargetRoas, "maxTargetRoas");
  if (minTargetRoas >= maxTargetRoas || minTargetRoas < 0.01 || maxTargetRoas > 1000) {
    throw new BiddingSupervisorError("INVALID_INPUT", "target ROAS bounds must fit Google Ads range 0.01..1000");
  }
  const minPortfolioCpcCeilingMicros = positiveInteger(input.minPortfolioCpcCeilingMicros, "minPortfolioCpcCeilingMicros");
  const maxPortfolioCpcCeilingMicros = positiveInteger(input.maxPortfolioCpcCeilingMicros, "maxPortfolioCpcCeilingMicros");
  if (minPortfolioCpcCeilingMicros >= maxPortfolioCpcCeilingMicros) {
    throw new BiddingSupervisorError("INVALID_INPUT", "portfolio CPC ceiling bounds are invalid");
  }
  const mode = input.mode ?? "ACTIVE";
  if (!(["ACTIVE", "OBSERVE_ONLY", "KILLED"] as const).includes(mode)) throw new BiddingSupervisorError("INVALID_INPUT", "mode is invalid");
  const maxWriteRetries = input.maxWriteRetries ?? 3;
  if (!Number.isInteger(maxWriteRetries) || maxWriteRetries < 0 || maxWriteRetries > 10) throw new BiddingSupervisorError("INVALID_INPUT", "maxWriteRetries must be 0..10");
  const core = {
    policyId,
    version,
    observationWindowDays,
    reportingLagDays,
    cooldownMs,
    maxBusinessDataAgeMs,
    minimumCostMicros,
    minimumGoogleConversions: input.minimumGoogleConversions,
    increaseVolumeProfitToSpendRatio,
    decreaseRiskProfitToSpendRatio,
    budgetStepFraction,
    targetStepFraction,
    bidBoundStepFraction,
    minBudgetMicros,
    maxBudgetMicros,
    minTargetCpaMicros,
    maxTargetCpaMicros,
    minTargetRoas,
    maxTargetRoas,
    minPortfolioCpcCeilingMicros,
    maxPortfolioCpcCeilingMicros,
    allowSharedBudgets: input.allowSharedBudgets,
    managePortfolioBidBounds: input.managePortfolioBidBounds,
    mode,
    maxWriteRetries,
  };
  return Object.freeze({ ...core, digest: digest("cortex-bidding-policy-v1", core) });
}

function effectiveMode(policy: BiddingSupervisorMode, requested: BiddingSupervisorMode | undefined): BiddingSupervisorMode {
  const rank: Record<BiddingSupervisorMode, number> = { ACTIVE: 0, OBSERVE_ONLY: 1, KILLED: 2 };
  const mode = requested ?? "ACTIVE";
  if (!(mode in rank)) throw new BiddingSupervisorError("INVALID_INPUT", "requested mode is invalid");
  return rank[mode] > rank[policy] ? mode : policy;
}

function reportWindow(nowMs: number, policy: BiddingSupervisorPolicy): { readonly startMs: number; readonly endMs: number; readonly start: string; readonly end: string } {
  const dayMs = 86_400_000;
  const current = new Date(nowMs);
  if (!Number.isFinite(current.getTime())) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "engine clock is invalid");
  const currentUtcDay = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate());
  const endMs = currentUtcDay - policy.reportingLagDays * dayMs;
  const startMs = endMs - (policy.observationWindowDays - 1) * dayMs;
  const format = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { startMs, endMs, start: format(startMs), end: format(endMs) };
}

function stateCoreDigest(customerId: string, campaignId: string, policyDigest: string, payload: SupervisorStatePayload, updatedAt: string): string {
  return digest("cortex-bidding-state-v1", { customerId, campaignId, policyDigest, payload, updatedAt });
}

function runCoreDigest(
  runId: string,
  customerId: string,
  campaignId: string,
  policyDigest: string,
  status: BiddingSupervisorRunStatus,
  payload: SupervisorRunPayload,
  createdAt: string,
  updatedAt: string,
): string {
  return digest("cortex-bidding-run-v1", { runId, customerId, campaignId, policyDigest, status, payload, createdAt, updatedAt });
}

function stateProperties(customerId: string, campaignId: string, policyDigest: string, payload: SupervisorStatePayload, updatedAt: string): Readonly<Record<string, JsonValue>> {
  return Object.freeze({
    [STATE.customerId]: customerId,
    [STATE.campaignId]: campaignId,
    [STATE.policyDigest]: policyDigest,
    [STATE.payload]: asJson(payload, "state payload"),
    [STATE.updatedAt]: updatedAt,
    [STATE.digest]: stateCoreDigest(customerId, campaignId, policyDigest, payload, updatedAt),
  });
}

function runProperties(
  runId: string,
  customerId: string,
  campaignId: string,
  policyDigest: string,
  status: BiddingSupervisorRunStatus,
  payload: SupervisorRunPayload,
  createdAt: string,
  updatedAt: string,
): Readonly<Record<string, JsonValue>> {
  return Object.freeze({
    [RUN.runId]: runId,
    [RUN.customerId]: customerId,
    [RUN.campaignId]: campaignId,
    [RUN.policyDigest]: policyDigest,
    [RUN.status]: status,
    [RUN.payload]: asJson(payload, "run payload"),
    [RUN.createdAt]: createdAt,
    [RUN.updatedAt]: updatedAt,
    [RUN.digest]: runCoreDigest(runId, customerId, campaignId, policyDigest, status, payload, createdAt, updatedAt),
  });
}

function propertyString(record: ObjectRecord, key: string): string {
  const value = record.properties[key];
  if (typeof value !== "string" || !value) throw new BiddingSupervisorError("INTEGRITY_FAILURE", `record ${record.id} has invalid ${key}`);
  return value;
}

function propertyJson(record: ObjectRecord, key: string): JsonValue {
  return asJson(record.properties[key], key);
}

function nullableString(value: JsonValue | undefined, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new BiddingSupervisorError("INTEGRITY_FAILURE", `${field} must be string or null`);
  return value;
}

function parseAction(value: JsonValue | undefined): GoogleAdsControlMutation | null {
  if (value === null || value === undefined) return null;
  const raw = asObject(value, "action");
  const kind = raw.kind;
  const resourceName = raw.resourceName;
  if (typeof kind !== "string" || typeof resourceName !== "string") throw new BiddingSupervisorError("INTEGRITY_FAILURE", "action identity is invalid");
  const num = (key: string): number => {
    const observed = raw[key];
    if (typeof observed !== "number" || !Number.isFinite(observed)) throw new BiddingSupervisorError("INTEGRITY_FAILURE", `action ${key} is invalid`);
    return observed;
  };
  const nullableNum = (key: string): number | null => {
    const observed = raw[key];
    if (observed === null || observed === undefined) return null;
    return num(key);
  };
  if (kind === "CAMPAIGN_BUDGET") return { kind, resourceName, expectedAmountMicros: num("expectedAmountMicros"), nextAmountMicros: num("nextAmountMicros") };
  if (kind === "STANDARD_TARGET_CPA") return { kind, resourceName, expectedTargetCpaMicros: num("expectedTargetCpaMicros"), nextTargetCpaMicros: num("nextTargetCpaMicros") };
  if (kind === "STANDARD_TARGET_ROAS") return { kind, resourceName, expectedTargetRoas: num("expectedTargetRoas"), nextTargetRoas: num("nextTargetRoas") };
  if (kind === "PORTFOLIO_TARGET_CPA") {
    const strategyType = raw.strategyType;
    if (strategyType !== "TARGET_CPA" && strategyType !== "MAXIMIZE_CONVERSIONS") throw new BiddingSupervisorError("INTEGRITY_FAILURE", "portfolio CPA strategy type is invalid");
    return { kind, resourceName, strategyType, expectedTargetCpaMicros: num("expectedTargetCpaMicros"), nextTargetCpaMicros: num("nextTargetCpaMicros") };
  }
  if (kind === "PORTFOLIO_TARGET_ROAS") {
    const strategyType = raw.strategyType;
    if (strategyType !== "TARGET_ROAS" && strategyType !== "MAXIMIZE_CONVERSION_VALUE") throw new BiddingSupervisorError("INTEGRITY_FAILURE", "portfolio ROAS strategy type is invalid");
    return { kind, resourceName, strategyType, expectedTargetRoas: num("expectedTargetRoas"), nextTargetRoas: num("nextTargetRoas") };
  }
  if (kind === "PORTFOLIO_BID_BOUNDS") {
    const strategyType = raw.strategyType;
    if (!(strategyType === "TARGET_CPA" || strategyType === "MAXIMIZE_CONVERSIONS" || strategyType === "TARGET_ROAS" || strategyType === "MAXIMIZE_CONVERSION_VALUE")) {
      throw new BiddingSupervisorError("INTEGRITY_FAILURE", "portfolio bounds strategy type is invalid");
    }
    return {
      kind,
      resourceName,
      strategyType,
      expectedCeilingMicros: nullableNum("expectedCeilingMicros"),
      nextCeilingMicros: nullableNum("nextCeilingMicros"),
      expectedFloorMicros: nullableNum("expectedFloorMicros"),
      nextFloorMicros: nullableNum("nextFloorMicros"),
    };
  }
  throw new BiddingSupervisorError("INTEGRITY_FAILURE", "action kind is invalid");
}

function parseState(record: ObjectRecord): SupervisorStateRecord {
  if (record.typeId !== STATE_TYPE) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "state record type is invalid");
  const customerId = propertyString(record, STATE.customerId);
  const campaignId = propertyString(record, STATE.campaignId);
  const policyDigest = propertyString(record, STATE.policyDigest);
  const payloadRaw = asObject(propertyJson(record, STATE.payload), "state payload");
  const payload: SupervisorStatePayload = {
    lastRunAt: nullableString(payloadRaw.lastRunAt, "state.lastRunAt"),
    lastMutationAt: nullableString(payloadRaw.lastMutationAt, "state.lastMutationAt"),
    lastActionKind: nullableString(payloadRaw.lastActionKind, "state.lastActionKind") as BiddingSupervisorActionKind | null,
    inFlightRunId: nullableString(payloadRaw.inFlightRunId, "state.inFlightRunId"),
    lastAppliedAction: parseAction(payloadRaw.lastAppliedAction),
    lastRollbackAt: nullableString(payloadRaw.lastRollbackAt, "state.lastRollbackAt"),
  };
  for (const [field, value] of [["lastRunAt", payload.lastRunAt], ["lastMutationAt", payload.lastMutationAt], ["lastRollbackAt", payload.lastRollbackAt]] as const) {
    if (value) canonicalUtc(value, `state.${field}`);
  }
  const updatedAt = canonicalUtc(propertyString(record, STATE.updatedAt), "state.updatedAt");
  const observedDigest = propertyString(record, STATE.digest);
  const expectedDigest = stateCoreDigest(customerId, campaignId, policyDigest, payload, updatedAt);
  if (observedDigest !== expectedDigest) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "state digest mismatch");
  return Object.freeze({ id: record.id, customerId, campaignId, policyDigest, ...payload, digest: observedDigest, updatedAt, revision: record.revision });
}

function parseEvidence(value: JsonValue | undefined): BiddingSupervisorEvidence | null {
  if (value === null || value === undefined) return null;
  const raw = asObject(value, "evidence");
  const number = (key: string): number => {
    const observed = raw[key];
    if (typeof observed !== "number" || !Number.isFinite(observed)) throw new BiddingSupervisorError("INTEGRITY_FAILURE", `evidence ${key} is invalid`);
    return observed;
  };
  if (typeof raw.sourceId !== "string") throw new BiddingSupervisorError("INTEGRITY_FAILURE", "evidence sourceId is invalid");
  return Object.freeze({
    googleCostMicros: number("googleCostMicros"),
    googleConversions: number("googleConversions"),
    googleConversionValue: number("googleConversionValue"),
    businessRevenueMicros: number("businessRevenueMicros"),
    businessGrossProfitBeforeAdSpendMicros: number("businessGrossProfitBeforeAdSpendMicros"),
    businessQualifiedConversions: number("businessQualifiedConversions"),
    profitAfterAdSpendMicros: number("profitAfterAdSpendMicros"),
    profitToSpendRatio: number("profitToSpendRatio"),
    sourceId: raw.sourceId,
  });
}

function parseReceipt(value: JsonValue | undefined): GoogleAdsMutationReceipt | null {
  if (value === null || value === undefined) return null;
  const raw = asObject(value, "receipt");
  if (typeof raw.resourceName !== "string" || typeof raw.recoveredAlreadyApplied !== "boolean") throw new BiddingSupervisorError("INTEGRITY_FAILURE", "receipt is invalid");
  const requestId = nullableString(raw.requestId, "receipt.requestId");
  return Object.freeze({ requestId, resourceName: raw.resourceName, recoveredAlreadyApplied: raw.recoveredAlreadyApplied });
}

function parseRun(record: ObjectRecord): SupervisorRunRecord {
  if (record.typeId !== RUN_TYPE) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "run record type is invalid");
  const runId = propertyString(record, RUN.runId);
  const customerId = propertyString(record, RUN.customerId);
  const campaignId = propertyString(record, RUN.campaignId);
  const policyDigest = propertyString(record, RUN.policyDigest);
  const status = propertyString(record, RUN.status) as BiddingSupervisorRunStatus;
  if (!(["PREPARED", "APPLIED", "NOOP", "FAILED", "ROLLED_BACK"] as const).includes(status)) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "run status is invalid");
  const payloadRaw = asObject(propertyJson(record, RUN.payload), "run payload");
  const mode = payloadRaw.mode as BiddingSupervisorMode;
  const direction = payloadRaw.direction as BiddingSupervisorDirection;
  const reason = payloadRaw.reason as BiddingSupervisorReason;
  if (!(["ACTIVE", "OBSERVE_ONLY", "KILLED"] as const).includes(mode)) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "run mode is invalid");
  if (!(["INCREASE_VOLUME", "DECREASE_RISK", "HOLD"] as const).includes(direction)) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "run direction is invalid");
  if (typeof reason !== "string") throw new BiddingSupervisorError("INTEGRITY_FAILURE", "run reason is invalid");
  const windowStart = payloadRaw.windowStart;
  const windowEnd = payloadRaw.windowEnd;
  if (typeof windowStart !== "string" || typeof windowEnd !== "string") throw new BiddingSupervisorError("INTEGRITY_FAILURE", "run window is invalid");
  const payload: SupervisorRunPayload = {
    mode,
    direction,
    reason,
    windowStart,
    windowEnd,
    campaignSnapshot: (payloadRaw.campaignSnapshot ?? null) as unknown as GoogleAdsCampaignSnapshot | null,
    portfolioSnapshot: (payloadRaw.portfolioSnapshot ?? null) as unknown as GoogleAdsPortfolioSnapshot | null,
    businessSnapshot: (payloadRaw.businessSnapshot ?? null) as unknown as BusinessProfitabilitySnapshot | null,
    evidence: parseEvidence(payloadRaw.evidence),
    action: parseAction(payloadRaw.action),
    receipt: parseReceipt(payloadRaw.receipt),
    errorCode: nullableString(payloadRaw.errorCode, "run.errorCode"),
  };
  const createdAt = canonicalUtc(propertyString(record, RUN.createdAt), "run.createdAt");
  const updatedAt = canonicalUtc(propertyString(record, RUN.updatedAt), "run.updatedAt");
  const observedDigest = propertyString(record, RUN.digest);
  const expectedDigest = runCoreDigest(runId, customerId, campaignId, policyDigest, status, payload, createdAt, updatedAt);
  if (observedDigest !== expectedDigest) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "run digest mismatch");
  return Object.freeze({ id: record.id, runId, customerId, campaignId, policyDigest, status, ...payload, digest: observedDigest, createdAt, updatedAt, revision: record.revision });
}

function evidenceFrom(google: Pick<GoogleAdsCampaignSnapshot | GoogleAdsPortfolioSnapshot, "costMicros" | "conversions" | "conversionValue">, business: BusinessProfitabilitySnapshot): BiddingSupervisorEvidence {
  const cost = google.costMicros;
  const ratio = cost > 0 ? business.grossProfitBeforeAdSpendMicros / cost : 0;
  return Object.freeze({
    googleCostMicros: cost,
    googleConversions: google.conversions,
    googleConversionValue: google.conversionValue,
    businessRevenueMicros: business.revenueMicros,
    businessGrossProfitBeforeAdSpendMicros: business.grossProfitBeforeAdSpendMicros,
    businessQualifiedConversions: business.qualifiedConversions,
    profitAfterAdSpendMicros: business.grossProfitBeforeAdSpendMicros - cost,
    profitToSpendRatio: ratio,
    sourceId: business.sourceId,
  });
}

function validateBusinessSnapshot(snapshot: BusinessProfitabilitySnapshot, query: BusinessProfitabilityQuery, nowMs: number, policy: BiddingSupervisorPolicy): void {
  if (snapshot.customerId !== query.customerId || snapshot.scopeKind !== query.scopeKind || snapshot.scopeId !== query.scopeId || snapshot.windowStart !== query.windowStart || snapshot.windowEnd !== query.windowEnd) {
    throw new BiddingSupervisorError("INTEGRITY_FAILURE", "business profitability snapshot does not match requested scope/window");
  }
  nonNegativeInteger(snapshot.revenueMicros, "business revenueMicros");
  nonNegativeInteger(snapshot.grossProfitBeforeAdSpendMicros, "business grossProfitBeforeAdSpendMicros");
  if (!Number.isFinite(snapshot.qualifiedConversions) || snapshot.qualifiedConversions < 0) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "business qualifiedConversions is invalid");
  normalizeIdentifier(snapshot.sourceId, "business sourceId");
  const observedAt = canonicalUtc(snapshot.observedAt, "business observedAt");
  const age = nowMs - Date.parse(observedAt);
  if (age < 0) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "business snapshot cannot be from the future");
  if (age > policy.maxBusinessDataAgeMs) throw new BiddingSupervisorError("POLICY_VIOLATION", "business profitability snapshot is stale");
}

function directionFor(evidence: BiddingSupervisorEvidence, policy: BiddingSupervisorPolicy): BiddingSupervisorDirection {
  if (evidence.profitToSpendRatio >= policy.increaseVolumeProfitToSpendRatio) return "INCREASE_VOLUME";
  if (evidence.profitToSpendRatio <= policy.decreaseRiskProfitToSpendRatio) return "DECREASE_RISK";
  return "HOLD";
}

function boundedIntegerChange(current: number, fractionValue: number, direction: "UP" | "DOWN", min: number, max: number): number {
  const raw = direction === "UP" ? current * (1 + fractionValue) : current * (1 - fractionValue);
  const rounded = direction === "UP" ? Math.ceil(raw) : Math.floor(raw);
  return Math.max(min, Math.min(max, rounded));
}

function boundedFloatChange(current: number, fractionValue: number, direction: "UP" | "DOWN", min: number, max: number): number {
  const raw = direction === "UP" ? current * (1 + fractionValue) : current * (1 - fractionValue);
  return Math.max(min, Math.min(max, Number(raw.toFixed(6))));
}

function reverseAction(action: GoogleAdsControlMutation): GoogleAdsControlMutation {
  if (action.kind === "CAMPAIGN_BUDGET") return { ...action, expectedAmountMicros: action.nextAmountMicros, nextAmountMicros: action.expectedAmountMicros };
  if (action.kind === "STANDARD_TARGET_CPA") return { ...action, expectedTargetCpaMicros: action.nextTargetCpaMicros, nextTargetCpaMicros: action.expectedTargetCpaMicros };
  if (action.kind === "STANDARD_TARGET_ROAS") return { ...action, expectedTargetRoas: action.nextTargetRoas, nextTargetRoas: action.expectedTargetRoas };
  if (action.kind === "PORTFOLIO_TARGET_CPA") return { ...action, expectedTargetCpaMicros: action.nextTargetCpaMicros, nextTargetCpaMicros: action.expectedTargetCpaMicros };
  if (action.kind === "PORTFOLIO_TARGET_ROAS") return { ...action, expectedTargetRoas: action.nextTargetRoas, nextTargetRoas: action.expectedTargetRoas };
  return {
    ...action,
    expectedCeilingMicros: action.nextCeilingMicros,
    nextCeilingMicros: action.expectedCeilingMicros,
    expectedFloorMicros: action.nextFloorMicros,
    nextFloorMicros: action.expectedFloorMicros,
  };
}

function isConflict(error: unknown): boolean {
  return error instanceof OntologyTransactionError && error.code === "CONFLICT";
}

export class PeriodicGoogleAdsBiddingSupervisor {
  readonly schema: ValidatedSchema;

  constructor(
    private readonly transactions: OntologyTransactionPort,
    readonly scope: OntologyScope,
    readonly policy: BiddingSupervisorPolicy,
    private readonly googleAds: GoogleAdsRestClient,
    private readonly business: BusinessProfitabilityProvider,
    private readonly now: () => number = Date.now,
  ) {
    this.schema = supervisorSchema(scope);
  }

  private time(): { readonly ms: number; readonly iso: string } {
    const ms = this.now();
    if (!Number.isFinite(ms)) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "engine clock is invalid");
    return { ms, iso: new Date(ms).toISOString() };
  }

  private stateId(customerId: string, campaignId: string): string {
    return ontologyId("cortex-bidding-state", { scope: this.scope, policyDigest: this.policy.digest, customerId, campaignId });
  }

  private runRecordId(runId: string, customerId: string, campaignId: string): string {
    return ontologyId("cortex-bidding-run", { scope: this.scope, policyDigest: this.policy.digest, runId, customerId, campaignId });
  }

  private readState(customerId: string, campaignId: string): SupervisorStateRecord | undefined {
    const record = this.transactions.getObject(this.scope, this.stateId(customerId, campaignId));
    return record ? parseState(record) : undefined;
  }

  private readRun(runId: string, customerId: string, campaignId: string): SupervisorRunRecord | undefined {
    const record = this.transactions.getObject(this.scope, this.runRecordId(runId, customerId, campaignId));
    return record ? parseRun(record) : undefined;
  }

  private publicResult(run: SupervisorRunRecord): BiddingSupervisorResult {
    return Object.freeze({
      runId: run.runId,
      customerId: run.customerId,
      campaignId: run.campaignId,
      status: run.status,
      mode: run.mode,
      direction: run.direction,
      reason: run.reason,
      windowStart: run.windowStart,
      windowEnd: run.windowEnd,
      action: run.action,
      receipt: run.receipt,
      evidence: run.evidence,
      policyDigest: run.policyDigest,
      digest: run.digest,
    });
  }

  private async profitability(query: BusinessProfitabilityQuery, nowMs: number): Promise<BusinessProfitabilitySnapshot> {
    const snapshot = await this.business.getProfitability(query);
    validateBusinessSnapshot(snapshot, query, nowMs, this.policy);
    return Object.freeze({ ...snapshot });
  }

  private candidateActions(
    campaign: GoogleAdsCampaignSnapshot,
    portfolio: GoogleAdsPortfolioSnapshot | null,
    direction: Exclude<BiddingSupervisorDirection, "HOLD">,
  ): readonly GoogleAdsControlMutation[] {
    const actions: GoogleAdsControlMutation[] = [];
    const increase = direction === "INCREASE_VOLUME";

    if (!campaign.budgetExplicitlyShared || this.policy.allowSharedBudgets) {
      let nextBudget = boundedIntegerChange(
        campaign.budgetAmountMicros,
        this.policy.budgetStepFraction,
        increase ? "UP" : "DOWN",
        this.policy.minBudgetMicros,
        this.policy.maxBudgetMicros,
      );
      if (increase && campaign.recommendedBudgetAmountMicros && campaign.recommendedBudgetAmountMicros > campaign.budgetAmountMicros) {
        nextBudget = Math.min(nextBudget, campaign.recommendedBudgetAmountMicros);
      }
      if (nextBudget !== campaign.budgetAmountMicros) {
        actions.push({
          kind: "CAMPAIGN_BUDGET",
          resourceName: campaign.budgetResourceName,
          expectedAmountMicros: campaign.budgetAmountMicros,
          nextAmountMicros: nextBudget,
        });
      }
    }

    if (!campaign.portfolioBiddingStrategyResourceName) {
      if (campaign.biddingStrategyType === "MAXIMIZE_CONVERSIONS" && campaign.standardTargetCpaMicros !== null) {
        const next = boundedIntegerChange(
          campaign.standardTargetCpaMicros,
          this.policy.targetStepFraction,
          increase ? "UP" : "DOWN",
          this.policy.minTargetCpaMicros,
          this.policy.maxTargetCpaMicros,
        );
        if (next !== campaign.standardTargetCpaMicros) actions.push({ kind: "STANDARD_TARGET_CPA", resourceName: campaign.campaignResourceName, expectedTargetCpaMicros: campaign.standardTargetCpaMicros, nextTargetCpaMicros: next });
      }
      if (campaign.biddingStrategyType === "MAXIMIZE_CONVERSION_VALUE" && campaign.standardTargetRoas !== null) {
        const next = boundedFloatChange(
          campaign.standardTargetRoas,
          this.policy.targetStepFraction,
          increase ? "DOWN" : "UP",
          this.policy.minTargetRoas,
          this.policy.maxTargetRoas,
        );
        if (next !== campaign.standardTargetRoas) actions.push({ kind: "STANDARD_TARGET_ROAS", resourceName: campaign.campaignResourceName, expectedTargetRoas: campaign.standardTargetRoas, nextTargetRoas: next });
      }
    } else if (portfolio) {
      if ((portfolio.type === "TARGET_CPA" || portfolio.type === "MAXIMIZE_CONVERSIONS") && portfolio.targetCpaMicros !== null) {
        const next = boundedIntegerChange(portfolio.targetCpaMicros, this.policy.targetStepFraction, increase ? "UP" : "DOWN", this.policy.minTargetCpaMicros, this.policy.maxTargetCpaMicros);
        if (next !== portfolio.targetCpaMicros) actions.push({ kind: "PORTFOLIO_TARGET_CPA", resourceName: portfolio.resourceName, strategyType: portfolio.type, expectedTargetCpaMicros: portfolio.targetCpaMicros, nextTargetCpaMicros: next });
      }
      if ((portfolio.type === "TARGET_ROAS" || portfolio.type === "MAXIMIZE_CONVERSION_VALUE") && portfolio.targetRoas !== null) {
        const next = boundedFloatChange(portfolio.targetRoas, this.policy.targetStepFraction, increase ? "DOWN" : "UP", this.policy.minTargetRoas, this.policy.maxTargetRoas);
        if (next !== portfolio.targetRoas) actions.push({ kind: "PORTFOLIO_TARGET_ROAS", resourceName: portfolio.resourceName, strategyType: portfolio.type, expectedTargetRoas: portfolio.targetRoas, nextTargetRoas: next });
      }
      if (this.policy.managePortfolioBidBounds && portfolio.cpcBidCeilingMicros !== null) {
        const nextCeiling = boundedIntegerChange(
          portfolio.cpcBidCeilingMicros,
          this.policy.bidBoundStepFraction,
          increase ? "UP" : "DOWN",
          this.policy.minPortfolioCpcCeilingMicros,
          this.policy.maxPortfolioCpcCeilingMicros,
        );
        let nextFloor = portfolio.cpcBidFloorMicros;
        if (increase && portfolio.cpcBidFloorMicros !== null) {
          nextFloor = Math.max(1, Math.floor(portfolio.cpcBidFloorMicros * (1 - this.policy.bidBoundStepFraction)));
        }
        if (nextFloor !== null && nextFloor > nextCeiling) nextFloor = nextCeiling;
        if (nextCeiling !== portfolio.cpcBidCeilingMicros || nextFloor !== portfolio.cpcBidFloorMicros) {
          actions.push({
            kind: "PORTFOLIO_BID_BOUNDS",
            resourceName: portfolio.resourceName,
            strategyType: portfolio.type,
            expectedCeilingMicros: portfolio.cpcBidCeilingMicros,
            nextCeilingMicros: nextCeiling,
            expectedFloorMicros: portfolio.cpcBidFloorMicros,
            nextFloorMicros: nextFloor,
          });
        }
      }
    }
    return Object.freeze(actions);
  }

  private chooseOneAction(candidates: readonly GoogleAdsControlMutation[], lastKind: BiddingSupervisorActionKind | null): GoogleAdsControlMutation | null {
    if (candidates.length === 0) return null;
    const index = lastKind ? candidates.findIndex((candidate) => candidate.kind === lastKind) : -1;
    if (index < 0) return candidates[0]!;
    return candidates[(index + 1) % candidates.length]!;
  }

  private acquirePreparedRun(
    runId: string,
    customerId: string,
    campaignId: string,
    payload: SupervisorRunPayload,
    nowIso: string,
  ): SupervisorRunRecord {
    for (let attempt = 0; attempt <= this.policy.maxWriteRetries; attempt += 1) {
      const existingRun = this.readRun(runId, customerId, campaignId);
      if (existingRun) return existingRun;
      const state = this.readState(customerId, campaignId);
      if (state?.inFlightRunId && state.inFlightRunId !== runId) {
        const inFlight = this.readRun(state.inFlightRunId, customerId, campaignId);
        if (!inFlight) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "state references missing in-flight run");
        return inFlight;
      }
      const nextState: SupervisorStatePayload = {
        lastRunAt: state?.lastRunAt ?? null,
        lastMutationAt: state?.lastMutationAt ?? null,
        lastActionKind: state?.lastActionKind ?? null,
        inFlightRunId: runId,
        lastAppliedAction: state?.lastAppliedAction ?? null,
        lastRollbackAt: state?.lastRollbackAt ?? null,
      };
      const operations: TransactionOperation[] = [
        {
          kind: "CREATE_OBJECT",
          record: {
            id: this.runRecordId(runId, customerId, campaignId),
            typeId: RUN_TYPE,
            scope: this.scope,
            properties: runProperties(runId, customerId, campaignId, this.policy.digest, "PREPARED", payload, nowIso, nowIso),
          },
        },
        state
          ? {
              kind: "UPDATE_OBJECT",
              id: state.id,
              expectedRevision: state.revision,
              properties: stateProperties(customerId, campaignId, this.policy.digest, nextState, nowIso),
            }
          : {
              kind: "CREATE_OBJECT",
              record: {
                id: this.stateId(customerId, campaignId),
                typeId: STATE_TYPE,
                scope: this.scope,
                properties: stateProperties(customerId, campaignId, this.policy.digest, nextState, nowIso),
              },
            },
      ];
      try {
        this.transactions.transact(this.scope, this.schema, operations);
        const stored = this.readRun(runId, customerId, campaignId);
        if (!stored) throw new BiddingSupervisorError("PERSISTENCE_FAILURE", "prepared run was not readable after commit");
        return stored;
      } catch (error) {
        if (isConflict(error) && attempt < this.policy.maxWriteRetries) continue;
        if (isConflict(error)) throw new BiddingSupervisorError("CONFLICT", "run preparation conflicted after retries");
        if (error instanceof BiddingSupervisorError) throw error;
        throw new BiddingSupervisorError("PERSISTENCE_FAILURE", error instanceof Error ? error.message : "run preparation failed");
      }
    }
    throw new BiddingSupervisorError("CONFLICT", "run preparation exhausted retries");
  }

  private finalizeRun(
    run: SupervisorRunRecord,
    status: Exclude<BiddingSupervisorRunStatus, "PREPARED">,
    payload: SupervisorRunPayload,
    nowIso: string,
    mutationApplied: boolean,
  ): SupervisorRunRecord {
    for (let attempt = 0; attempt <= this.policy.maxWriteRetries; attempt += 1) {
      const currentRun = this.readRun(run.runId, run.customerId, run.campaignId);
      if (!currentRun) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "run disappeared during finalize");
      if (currentRun.status !== "PREPARED") return currentRun;
      const state = this.readState(run.customerId, run.campaignId);
      if (!state || state.inFlightRunId !== run.runId) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "run no longer owns state lock");
      const nextState: SupervisorStatePayload = {
        lastRunAt: nowIso,
        lastMutationAt: mutationApplied ? nowIso : state.lastMutationAt,
        lastActionKind: mutationApplied && payload.action ? payload.action.kind : state.lastActionKind,
        inFlightRunId: null,
        lastAppliedAction: mutationApplied && payload.action ? payload.action : state.lastAppliedAction,
        lastRollbackAt: state.lastRollbackAt,
      };
      const operations: TransactionOperation[] = [
        {
          kind: "UPDATE_OBJECT",
          id: currentRun.id,
          expectedRevision: currentRun.revision,
          properties: runProperties(currentRun.runId, currentRun.customerId, currentRun.campaignId, currentRun.policyDigest, status, payload, currentRun.createdAt, nowIso),
        },
        {
          kind: "UPDATE_OBJECT",
          id: state.id,
          expectedRevision: state.revision,
          properties: stateProperties(state.customerId, state.campaignId, state.policyDigest, nextState, nowIso),
        },
      ];
      try {
        this.transactions.transact(this.scope, this.schema, operations);
        const stored = this.readRun(run.runId, run.customerId, run.campaignId);
        if (!stored) throw new BiddingSupervisorError("PERSISTENCE_FAILURE", "finalized run was not readable after commit");
        return stored;
      } catch (error) {
        if (isConflict(error) && attempt < this.policy.maxWriteRetries) continue;
        if (isConflict(error)) throw new BiddingSupervisorError("CONFLICT", "run finalize conflicted after retries");
        if (error instanceof BiddingSupervisorError) throw error;
        throw new BiddingSupervisorError("PERSISTENCE_FAILURE", error instanceof Error ? error.message : "run finalize failed");
      }
    }
    throw new BiddingSupervisorError("CONFLICT", "run finalize exhausted retries");
  }

  private async executePrepared(run: SupervisorRunRecord): Promise<BiddingSupervisorResult> {
    if (run.status !== "PREPARED") return this.publicResult(run);
    const { iso } = this.time();
    if (!run.action || run.mode !== "ACTIVE") {
      const finalStatus: BiddingSupervisorRunStatus = "NOOP";
      const finalized = this.finalizeRun(run, finalStatus, run, iso, false);
      return this.publicResult(finalized);
    }
    try {
      const receipt = await this.googleAds.applyMutation(run.customerId, run.action);
      const reason: BiddingSupervisorReason = receipt.recoveredAlreadyApplied ? "ACTION_RECOVERED" : "ACTION_APPLIED";
      const payload: SupervisorRunPayload = { ...run, reason, receipt, errorCode: null };
      const finalized = this.finalizeRun(run, "APPLIED", payload, iso, true);
      return this.publicResult(finalized);
    } catch (error) {
      const reason: BiddingSupervisorReason = error instanceof GoogleAdsApiError && error.code === "REMOTE_CONFLICT" ? "REMOTE_CONFLICT" : "API_FAILURE";
      const payload: SupervisorRunPayload = {
        ...run,
        reason,
        receipt: null,
        errorCode: error instanceof GoogleAdsApiError ? error.code : "UNKNOWN_REMOTE_FAILURE",
      };
      const finalized = this.finalizeRun(run, "FAILED", payload, iso, false);
      throw new BiddingSupervisorError("REMOTE_FAILURE", `${finalized.reason}: Google Ads mutation was not certified as applied`);
    }
  }

  async supervise(input: BiddingSupervisorRunInput): Promise<BiddingSupervisorResult> {
    const requestedRunId = normalizeIdentifier(input.runId, "runId");
    const customerId = normalizeCustomerId(input.customerId);
    const campaignId = normalizeCustomerId(input.campaignId);
    const existing = this.readRun(requestedRunId, customerId, campaignId);
    if (existing) return this.executePrepared(existing);
    const stateBefore = this.readState(customerId, campaignId);
    if (stateBefore?.inFlightRunId && stateBefore.inFlightRunId !== requestedRunId) {
      const inFlight = this.readRun(stateBefore.inFlightRunId, customerId, campaignId);
      if (!inFlight) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "state references missing in-flight run");
      return this.executePrepared(inFlight);
    }

    const { ms: nowMs, iso: nowIso } = this.time();
    const mode = effectiveMode(this.policy.mode, input.mode);
    const window = reportWindow(nowMs, this.policy);
    const campaign = await this.googleAds.getCampaignSnapshot(customerId, campaignId, window.startMs, window.endMs);
    let portfolio: GoogleAdsPortfolioSnapshot | null = null;
    if (campaign.portfolioBiddingStrategyResourceName) {
      portfolio = await this.googleAds.getPortfolioSnapshot(customerId, campaign.portfolioBiddingStrategyResourceName, window.startMs, window.endMs);
    }

    const campaignBusinessQuery: BusinessProfitabilityQuery = {
      customerId,
      scopeKind: "CAMPAIGN",
      scopeId: campaignId,
      windowStart: window.start,
      windowEnd: window.end,
    };
    let businessSnapshot: BusinessProfitabilitySnapshot;
    let evidence: BiddingSupervisorEvidence;
    let reason: BiddingSupervisorReason;
    let direction: BiddingSupervisorDirection = "HOLD";
    let action: GoogleAdsControlMutation | null = null;

    try {
      businessSnapshot = await this.profitability(campaignBusinessQuery, nowMs);
    } catch (error) {
      if (error instanceof BiddingSupervisorError && error.code === "POLICY_VIOLATION") {
        businessSnapshot = await this.business.getProfitability(campaignBusinessQuery);
        evidence = evidenceFrom(campaign, businessSnapshot);
        reason = "STALE_BUSINESS_DATA";
        const payload: SupervisorRunPayload = { mode, direction, reason, windowStart: window.start, windowEnd: window.end, campaignSnapshot: campaign, portfolioSnapshot: portfolio, businessSnapshot, evidence, action: null, receipt: null, errorCode: null };
        const prepared = this.acquirePreparedRun(requestedRunId, customerId, campaignId, payload, nowIso);
        return this.executePrepared(prepared);
      }
      throw error;
    }

    evidence = evidenceFrom(campaign, businessSnapshot);
    if (mode === "KILLED") {
      reason = "KILL_SWITCH";
    } else if (campaign.status !== "ENABLED") {
      reason = "CAMPAIGN_NOT_ENABLED";
    } else if (stateBefore?.lastMutationAt && nowMs - Date.parse(stateBefore.lastMutationAt) < this.policy.cooldownMs) {
      reason = "COOLDOWN";
    } else if (campaign.costMicros < this.policy.minimumCostMicros || campaign.conversions < this.policy.minimumGoogleConversions) {
      reason = "INSUFFICIENT_EVIDENCE";
    } else {
      direction = directionFor(evidence, this.policy);
      if (direction === "HOLD") {
        reason = "PROFITABILITY_HOLD";
      } else {
        let decisionEvidence = evidence;
        if (portfolio && campaign.portfolioBiddingStrategyResourceName) {
          const portfolioBusinessQuery: BusinessProfitabilityQuery = {
            customerId,
            scopeKind: "BIDDING_STRATEGY",
            scopeId: portfolio.strategyId,
            windowStart: window.start,
            windowEnd: window.end,
          };
          const portfolioBusiness = await this.profitability(portfolioBusinessQuery, nowMs);
          const portfolioEvidence = evidenceFrom(portfolio, portfolioBusiness);
          if (portfolio.costMicros >= this.policy.minimumCostMicros && portfolio.conversions >= this.policy.minimumGoogleConversions) {
            decisionEvidence = portfolioEvidence;
            direction = directionFor(portfolioEvidence, this.policy);
          }
        }
        const candidates = direction === "HOLD" ? [] : this.candidateActions(campaign, portfolio, direction);
        action = this.chooseOneAction(candidates, stateBefore?.lastActionKind ?? null);
        evidence = decisionEvidence;
        if (!action) {
          reason = campaign.budgetExplicitlyShared && !this.policy.allowSharedBudgets ? "SHARED_BUDGET_BLOCKED" : "NO_COMPATIBLE_CONTROL";
        } else if (mode === "OBSERVE_ONLY") {
          reason = "OBSERVE_ONLY";
        } else {
          reason = "ACTION_APPLIED";
        }
      }
    }

    const payload: SupervisorRunPayload = {
      mode,
      direction,
      reason,
      windowStart: window.start,
      windowEnd: window.end,
      campaignSnapshot: campaign,
      portfolioSnapshot: portfolio,
      businessSnapshot,
      evidence,
      action,
      receipt: null,
      errorCode: null,
    };
    const prepared = this.acquirePreparedRun(requestedRunId, customerId, campaignId, payload, nowIso);
    return this.executePrepared(prepared);
  }

  async rollbackLastMutation(input: BiddingSupervisorRollbackInput): Promise<BiddingSupervisorResult> {
    const runId = normalizeIdentifier(input.runId, "runId");
    const customerId = normalizeCustomerId(input.customerId);
    const campaignId = normalizeCustomerId(input.campaignId);
    const existing = this.readRun(runId, customerId, campaignId);
    if (existing) return this.executePrepared(existing);
    const state = this.readState(customerId, campaignId);
    if (!state?.lastAppliedAction) throw new BiddingSupervisorError("POLICY_VIOLATION", "no applied action is available for rollback");
    if (state.inFlightRunId) {
      const inFlight = this.readRun(state.inFlightRunId, customerId, campaignId);
      if (!inFlight) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "state references missing in-flight run");
      return this.executePrepared(inFlight);
    }
    const { iso: nowIso } = this.time();
    const window = reportWindow(this.now(), this.policy);
    const action = reverseAction(state.lastAppliedAction);
    const payload: SupervisorRunPayload = {
      mode: "ACTIVE",
      direction: "HOLD",
      reason: "ROLLBACK_APPLIED",
      windowStart: window.start,
      windowEnd: window.end,
      campaignSnapshot: null,
      portfolioSnapshot: null,
      businessSnapshot: null,
      evidence: null,
      action,
      receipt: null,
      errorCode: null,
    };
    const prepared = this.acquirePreparedRun(runId, customerId, campaignId, payload, nowIso);
    try {
      const receipt = await this.googleAds.applyMutation(customerId, action);
      const finalPayload: SupervisorRunPayload = { ...payload, receipt, reason: "ROLLBACK_APPLIED" };
      const finalized = this.finalizeRun(prepared, "ROLLED_BACK", finalPayload, this.time().iso, false);
      const currentState = this.readState(customerId, campaignId);
      if (!currentState) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "state missing after rollback");
      const clearedState: SupervisorStatePayload = {
        lastRunAt: currentState.lastRunAt,
        lastMutationAt: currentState.lastMutationAt,
        lastActionKind: currentState.lastActionKind,
        inFlightRunId: null,
        lastAppliedAction: null,
        lastRollbackAt: this.time().iso,
      };
      this.transactions.transact(this.scope, this.schema, [{
        kind: "UPDATE_OBJECT",
        id: currentState.id,
        expectedRevision: currentState.revision,
        properties: stateProperties(customerId, campaignId, this.policy.digest, clearedState, this.time().iso),
      }]);
      return this.publicResult(finalized);
    } catch (error) {
      if (error instanceof BiddingSupervisorError) throw error;
      throw new BiddingSupervisorError("REMOTE_FAILURE", error instanceof Error ? error.message : "rollback failed");
    }
  }
}
