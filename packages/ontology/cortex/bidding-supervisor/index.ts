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
} from "./google-ads-rest";

const STATE_TYPE = "cortex.bidding_supervisor_state";
const RUN_TYPE = "cortex.bidding_supervisor_run";
const IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;
const DAY_MS = 86_400_000;

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

const RUN_REASONS: readonly BiddingSupervisorReason[] = [
  "KILL_SWITCH", "COOLDOWN", "CAMPAIGN_NOT_ENABLED", "INSUFFICIENT_EVIDENCE", "STALE_BUSINESS_DATA",
  "PROFITABILITY_HOLD", "NO_COMPATIBLE_CONTROL", "SHARED_BUDGET_BLOCKED", "OBSERVE_ONLY",
  "ACTION_APPLIED", "ACTION_RECOVERED", "REMOTE_CONFLICT", "API_FAILURE", "ROLLBACK_APPLIED",
];

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

export interface GoogleAdsBiddingGateway {
  getCampaignSnapshot(customerId: string, campaignId: string, startMs: number, endMs: number): Promise<GoogleAdsCampaignSnapshot>;
  getPortfolioSnapshot(customerId: string, resourceName: string, startMs: number, endMs: number): Promise<GoogleAdsPortfolioSnapshot>;
  applyMutation(customerId: string, action: GoogleAdsControlMutation): Promise<GoogleAdsMutationReceipt>;
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

interface StatePayload {
  readonly lastRunAt: string | null;
  readonly lastMutationAt: string | null;
  readonly lastActionKind: BiddingSupervisorActionKind | null;
  readonly inFlightRunId: string | null;
  readonly lastAppliedAction: GoogleAdsControlMutation | null;
  readonly lastRollbackAt: string | null;
}

interface StateRecord extends StatePayload {
  readonly id: string;
  readonly customerId: string;
  readonly campaignId: string;
  readonly policyDigest: string;
  readonly digest: string;
  readonly updatedAt: string;
  readonly revision: number;
}

interface RunPayload {
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

interface RunRecord extends RunPayload {
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

interface PlannedAction {
  readonly action: GoogleAdsControlMutation;
  readonly evidence: BiddingSupervisorEvidence;
  readonly business: BusinessProfitabilitySnapshot;
  readonly direction: Exclude<BiddingSupervisorDirection, "HOLD">;
}

type FinalizeEffect = "NONE" | "APPLY" | "ROLLBACK";

export class BiddingSupervisorError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "POLICY_VIOLATION" | "CONFLICT" | "INTEGRITY_FAILURE" | "PERSISTENCE_FAILURE" | "REMOTE_FAILURE",
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

function normalizeNumericId(value: string, field: string): string {
  const normalized = value.replaceAll("-", "").trim();
  if (!/^\d{5,20}$/.test(normalized)) throw new BiddingSupervisorError("INVALID_INPUT", `${field} is malformed`);
  return normalized;
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new BiddingSupervisorError("INVALID_INPUT", `${field} must be a positive safe integer`);
  return value;
}

function nonNegativeSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new BiddingSupervisorError("INVALID_INPUT", `${field} must be a non-negative safe integer`);
  return value;
}

function positiveFinite(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new BiddingSupervisorError("INVALID_INPUT", `${field} must be finite and positive`);
  return value;
}

function stepFraction(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 0.25) throw new BiddingSupervisorError("INVALID_INPUT", `${field} must be greater than 0 and at most 0.25`);
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

function json(value: unknown, field: string): JsonValue {
  if (!isJsonValue(value)) throw new BiddingSupervisorError("INTEGRITY_FAILURE", `${field} must be finite JSON`);
  return value;
}

function object(value: JsonValue, field: string): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BiddingSupervisorError("INTEGRITY_FAILURE", `${field} must be an object`);
  return value as Record<string, JsonValue>;
}

function property(id: string, name: string, valueKind: "STRING" | "JSON" | "DATETIME", immutable = false) {
  return { id, name, valueKind, cardinality: "REQUIRED", unique: false, immutable } as const;
}

function supervisorSchema(scope: OntologyScope): ValidatedSchema {
  const schema: SchemaVersion = {
    version: "cortex-bidding-supervisor-v1",
    scope,
    properties: [
      property(STATE.customerId, "BiddingStateCustomerId", "STRING", true),
      property(STATE.campaignId, "BiddingStateCampaignId", "STRING", true),
      property(STATE.policyDigest, "BiddingStatePolicyDigest", "STRING", true),
      property(STATE.payload, "BiddingStatePayload", "JSON"),
      property(STATE.digest, "BiddingStateDigest", "STRING"),
      property(STATE.updatedAt, "BiddingStateUpdatedAt", "DATETIME"),
      property(RUN.runId, "BiddingRunId", "STRING", true),
      property(RUN.customerId, "BiddingRunCustomerId", "STRING", true),
      property(RUN.campaignId, "BiddingRunCampaignId", "STRING", true),
      property(RUN.policyDigest, "BiddingRunPolicyDigest", "STRING", true),
      property(RUN.status, "BiddingRunStatus", "STRING"),
      property(RUN.payload, "BiddingRunPayload", "JSON"),
      property(RUN.digest, "BiddingRunDigest", "STRING"),
      property(RUN.createdAt, "BiddingRunCreatedAt", "DATETIME", true),
      property(RUN.updatedAt, "BiddingRunUpdatedAt", "DATETIME"),
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
  const observationWindowDays = positiveSafeInteger(input.observationWindowDays, "observationWindowDays");
  if (observationWindowDays > 90) throw new BiddingSupervisorError("INVALID_INPUT", "observationWindowDays must be at most 90");
  const reportingLagDays = positiveSafeInteger(input.reportingLagDays, "reportingLagDays");
  if (reportingLagDays > 14) throw new BiddingSupervisorError("INVALID_INPUT", "reportingLagDays must be at most 14");
  const cooldownMs = positiveSafeInteger(input.cooldownMs, "cooldownMs");
  const maxBusinessDataAgeMs = positiveSafeInteger(input.maxBusinessDataAgeMs, "maxBusinessDataAgeMs");
  const minimumCostMicros = nonNegativeSafeInteger(input.minimumCostMicros, "minimumCostMicros");
  if (!Number.isFinite(input.minimumGoogleConversions) || input.minimumGoogleConversions < 0) throw new BiddingSupervisorError("INVALID_INPUT", "minimumGoogleConversions must be non-negative");
  const increaseVolumeProfitToSpendRatio = positiveFinite(input.increaseVolumeProfitToSpendRatio, "increaseVolumeProfitToSpendRatio");
  const decreaseRiskProfitToSpendRatio = positiveFinite(input.decreaseRiskProfitToSpendRatio, "decreaseRiskProfitToSpendRatio");
  if (decreaseRiskProfitToSpendRatio >= increaseVolumeProfitToSpendRatio) throw new BiddingSupervisorError("INVALID_INPUT", "decrease-risk threshold must be lower than increase-volume threshold");
  const budgetStepFraction = stepFraction(input.budgetStepFraction, "budgetStepFraction");
  const targetStepFraction = stepFraction(input.targetStepFraction, "targetStepFraction");
  const bidBoundStepFraction = stepFraction(input.bidBoundStepFraction, "bidBoundStepFraction");
  const minBudgetMicros = positiveSafeInteger(input.minBudgetMicros, "minBudgetMicros");
  const maxBudgetMicros = positiveSafeInteger(input.maxBudgetMicros, "maxBudgetMicros");
  if (minBudgetMicros >= maxBudgetMicros) throw new BiddingSupervisorError("INVALID_INPUT", "budget bounds are invalid");
  const minTargetCpaMicros = positiveSafeInteger(input.minTargetCpaMicros, "minTargetCpaMicros");
  const maxTargetCpaMicros = positiveSafeInteger(input.maxTargetCpaMicros, "maxTargetCpaMicros");
  if (minTargetCpaMicros >= maxTargetCpaMicros) throw new BiddingSupervisorError("INVALID_INPUT", "target CPA bounds are invalid");
  const minTargetRoas = positiveFinite(input.minTargetRoas, "minTargetRoas");
  const maxTargetRoas = positiveFinite(input.maxTargetRoas, "maxTargetRoas");
  if (minTargetRoas < 0.01 || maxTargetRoas > 1000 || minTargetRoas >= maxTargetRoas) throw new BiddingSupervisorError("INVALID_INPUT", "target ROAS bounds must fit Google Ads range 0.01..1000");
  const minPortfolioCpcCeilingMicros = positiveSafeInteger(input.minPortfolioCpcCeilingMicros, "minPortfolioCpcCeilingMicros");
  const maxPortfolioCpcCeilingMicros = positiveSafeInteger(input.maxPortfolioCpcCeilingMicros, "maxPortfolioCpcCeilingMicros");
  if (minPortfolioCpcCeilingMicros >= maxPortfolioCpcCeilingMicros) throw new BiddingSupervisorError("INVALID_INPUT", "portfolio CPC ceiling bounds are invalid");
  const mode = input.mode ?? "ACTIVE";
  if (!(["ACTIVE", "OBSERVE_ONLY", "KILLED"] as const).includes(mode)) throw new BiddingSupervisorError("INVALID_INPUT", "mode is invalid");
  const maxWriteRetries = input.maxWriteRetries ?? 3;
  if (!Number.isInteger(maxWriteRetries) || maxWriteRetries < 0 || maxWriteRetries > 10) throw new BiddingSupervisorError("INVALID_INPUT", "maxWriteRetries must be 0..10");
  const core = {
    policyId, version, observationWindowDays, reportingLagDays, cooldownMs, maxBusinessDataAgeMs,
    minimumCostMicros, minimumGoogleConversions: input.minimumGoogleConversions,
    increaseVolumeProfitToSpendRatio, decreaseRiskProfitToSpendRatio,
    budgetStepFraction, targetStepFraction, bidBoundStepFraction,
    minBudgetMicros, maxBudgetMicros, minTargetCpaMicros, maxTargetCpaMicros,
    minTargetRoas, maxTargetRoas, minPortfolioCpcCeilingMicros, maxPortfolioCpcCeilingMicros,
    allowSharedBudgets: input.allowSharedBudgets, managePortfolioBidBounds: input.managePortfolioBidBounds,
    mode, maxWriteRetries,
  };
  return Object.freeze({ ...core, digest: digest("cortex-bidding-policy-v1", core) });
}

function effectiveMode(policyMode: BiddingSupervisorMode, requestedMode: BiddingSupervisorMode | undefined): BiddingSupervisorMode {
  const rank: Record<BiddingSupervisorMode, number> = { ACTIVE: 0, OBSERVE_ONLY: 1, KILLED: 2 };
  const requested = requestedMode ?? "ACTIVE";
  if (!(requested in rank)) throw new BiddingSupervisorError("INVALID_INPUT", "requested mode is invalid");
  return rank[requested] > rank[policyMode] ? requested : policyMode;
}

function reportWindow(nowMs: number, policy: BiddingSupervisorPolicy) {
  const current = new Date(nowMs);
  if (!Number.isFinite(current.getTime())) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "engine clock is invalid");
  const today = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate());
  const endMs = today - policy.reportingLagDays * DAY_MS;
  const startMs = endMs - (policy.observationWindowDays - 1) * DAY_MS;
  const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return Object.freeze({ startMs, endMs, start: date(startMs), end: date(endMs) });
}

function stateDigest(customerId: string, campaignId: string, policyDigest: string, payload: StatePayload, updatedAt: string): string {
  return digest("cortex-bidding-state-v1", { customerId, campaignId, policyDigest, payload, updatedAt });
}

function runDigest(runId: string, customerId: string, campaignId: string, policyDigest: string, status: BiddingSupervisorRunStatus, payload: RunPayload, createdAt: string, updatedAt: string): string {
  return digest("cortex-bidding-run-v1", { runId, customerId, campaignId, policyDigest, status, payload, createdAt, updatedAt });
}

function stateProperties(customerId: string, campaignId: string, policyDigest: string, payload: StatePayload, updatedAt: string): Readonly<Record<string, JsonValue>> {
  return Object.freeze({
    [STATE.customerId]: customerId,
    [STATE.campaignId]: campaignId,
    [STATE.policyDigest]: policyDigest,
    [STATE.payload]: json(payload, "state payload"),
    [STATE.digest]: stateDigest(customerId, campaignId, policyDigest, payload, updatedAt),
    [STATE.updatedAt]: updatedAt,
  });
}

function runProperties(runId: string, customerId: string, campaignId: string, policyDigest: string, status: BiddingSupervisorRunStatus, payload: RunPayload, createdAt: string, updatedAt: string): Readonly<Record<string, JsonValue>> {
  return Object.freeze({
    [RUN.runId]: runId,
    [RUN.customerId]: customerId,
    [RUN.campaignId]: campaignId,
    [RUN.policyDigest]: policyDigest,
    [RUN.status]: status,
    [RUN.payload]: json(payload, "run payload"),
    [RUN.digest]: runDigest(runId, customerId, campaignId, policyDigest, status, payload, createdAt, updatedAt),
    [RUN.createdAt]: createdAt,
    [RUN.updatedAt]: updatedAt,
  });
}

function propertyString(record: ObjectRecord, key: string): string {
  const value = record.properties[key];
  if (typeof value !== "string" || !value) throw new BiddingSupervisorError("INTEGRITY_FAILURE", `record ${record.id} has invalid ${key}`);
  return value;
}

function nullableString(value: JsonValue | undefined, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new BiddingSupervisorError("INTEGRITY_FAILURE", `${field} must be string or null`);
  return value;
}

function parseAction(value: JsonValue | undefined): GoogleAdsControlMutation | null {
  if (value === null || value === undefined) return null;
  const raw = object(value, "action");
  if (typeof raw.kind !== "string" || typeof raw.resourceName !== "string") throw new BiddingSupervisorError("INTEGRITY_FAILURE", "action identity is invalid");
  const number = (key: string) => {
    const item = raw[key];
    if (typeof item !== "number" || !Number.isFinite(item)) throw new BiddingSupervisorError("INTEGRITY_FAILURE", `action ${key} is invalid`);
    return item;
  };
  const nullableNumber = (key: string): number | null => raw[key] === null || raw[key] === undefined ? null : number(key);
  const kind = raw.kind;
  const resourceName = raw.resourceName;
  if (kind === "CAMPAIGN_BUDGET") return { kind, resourceName, expectedAmountMicros: number("expectedAmountMicros"), nextAmountMicros: number("nextAmountMicros") };
  if (kind === "STANDARD_TARGET_CPA") return { kind, resourceName, expectedTargetCpaMicros: number("expectedTargetCpaMicros"), nextTargetCpaMicros: number("nextTargetCpaMicros") };
  if (kind === "STANDARD_TARGET_ROAS") return { kind, resourceName, expectedTargetRoas: number("expectedTargetRoas"), nextTargetRoas: number("nextTargetRoas") };
  if (kind === "PORTFOLIO_TARGET_CPA") {
    if (raw.strategyType !== "TARGET_CPA" && raw.strategyType !== "MAXIMIZE_CONVERSIONS") throw new BiddingSupervisorError("INTEGRITY_FAILURE", "portfolio CPA strategy type is invalid");
    return { kind, resourceName, strategyType: raw.strategyType, expectedTargetCpaMicros: number("expectedTargetCpaMicros"), nextTargetCpaMicros: number("nextTargetCpaMicros") };
  }
  if (kind === "PORTFOLIO_TARGET_ROAS") {
    if (raw.strategyType !== "TARGET_ROAS" && raw.strategyType !== "MAXIMIZE_CONVERSION_VALUE") throw new BiddingSupervisorError("INTEGRITY_FAILURE", "portfolio ROAS strategy type is invalid");
    return { kind, resourceName, strategyType: raw.strategyType, expectedTargetRoas: number("expectedTargetRoas"), nextTargetRoas: number("nextTargetRoas") };
  }
  if (kind === "PORTFOLIO_BID_BOUNDS") {
    if (!(raw.strategyType === "TARGET_CPA" || raw.strategyType === "MAXIMIZE_CONVERSIONS" || raw.strategyType === "TARGET_ROAS" || raw.strategyType === "MAXIMIZE_CONVERSION_VALUE")) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "portfolio bounds strategy type is invalid");
    return { kind, resourceName, strategyType: raw.strategyType, expectedCeilingMicros: nullableNumber("expectedCeilingMicros"), nextCeilingMicros: nullableNumber("nextCeilingMicros"), expectedFloorMicros: nullableNumber("expectedFloorMicros"), nextFloorMicros: nullableNumber("nextFloorMicros") };
  }
  throw new BiddingSupervisorError("INTEGRITY_FAILURE", "action kind is invalid");
}

function parseEvidence(value: JsonValue | undefined): BiddingSupervisorEvidence | null {
  if (value === null || value === undefined) return null;
  const raw = object(value, "evidence");
  const number = (key: string) => {
    const item = raw[key];
    if (typeof item !== "number" || !Number.isFinite(item)) throw new BiddingSupervisorError("INTEGRITY_FAILURE", `evidence ${key} is invalid`);
    return item;
  };
  if (typeof raw.sourceId !== "string") throw new BiddingSupervisorError("INTEGRITY_FAILURE", "evidence sourceId is invalid");
  return Object.freeze({
    googleCostMicros: number("googleCostMicros"), googleConversions: number("googleConversions"), googleConversionValue: number("googleConversionValue"),
    businessRevenueMicros: number("businessRevenueMicros"), businessGrossProfitBeforeAdSpendMicros: number("businessGrossProfitBeforeAdSpendMicros"),
    businessQualifiedConversions: number("businessQualifiedConversions"), profitAfterAdSpendMicros: number("profitAfterAdSpendMicros"),
    profitToSpendRatio: number("profitToSpendRatio"), sourceId: raw.sourceId,
  });
}

function parseReceipt(value: JsonValue | undefined): GoogleAdsMutationReceipt | null {
  if (value === null || value === undefined) return null;
  const raw = object(value, "receipt");
  if (typeof raw.resourceName !== "string" || typeof raw.recoveredAlreadyApplied !== "boolean") throw new BiddingSupervisorError("INTEGRITY_FAILURE", "receipt is invalid");
  return Object.freeze({ requestId: nullableString(raw.requestId, "receipt.requestId"), resourceName: raw.resourceName, recoveredAlreadyApplied: raw.recoveredAlreadyApplied });
}

function parseState(record: ObjectRecord): StateRecord {
  if (record.typeId !== STATE_TYPE) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "state record type is invalid");
  const customerId = propertyString(record, STATE.customerId);
  const campaignId = propertyString(record, STATE.campaignId);
  const policyDigest = propertyString(record, STATE.policyDigest);
  const rawPayload = json(record.properties[STATE.payload], "state payload");
  const raw = object(rawPayload, "state payload");
  const lastActionKind = nullableString(raw.lastActionKind, "state.lastActionKind") as BiddingSupervisorActionKind | null;
  if (lastActionKind && !(["CAMPAIGN_BUDGET", "STANDARD_TARGET_CPA", "STANDARD_TARGET_ROAS", "PORTFOLIO_TARGET_CPA", "PORTFOLIO_TARGET_ROAS", "PORTFOLIO_BID_BOUNDS"] as const).includes(lastActionKind)) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "state lastActionKind is invalid");
  const payload: StatePayload = {
    lastRunAt: nullableString(raw.lastRunAt, "state.lastRunAt"),
    lastMutationAt: nullableString(raw.lastMutationAt, "state.lastMutationAt"),
    lastActionKind,
    inFlightRunId: nullableString(raw.inFlightRunId, "state.inFlightRunId"),
    lastAppliedAction: parseAction(raw.lastAppliedAction),
    lastRollbackAt: nullableString(raw.lastRollbackAt, "state.lastRollbackAt"),
  };
  for (const value of [payload.lastRunAt, payload.lastMutationAt, payload.lastRollbackAt]) if (value) canonicalUtc(value, "state timestamp");
  const updatedAt = canonicalUtc(propertyString(record, STATE.updatedAt), "state.updatedAt");
  const observedDigest = propertyString(record, STATE.digest);
  if (observedDigest !== stateDigest(customerId, campaignId, policyDigest, payload, updatedAt)) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "state digest mismatch");
  return Object.freeze({ id: record.id, customerId, campaignId, policyDigest, ...payload, digest: observedDigest, updatedAt, revision: record.revision });
}

function parseRun(record: ObjectRecord): RunRecord {
  if (record.typeId !== RUN_TYPE) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "run record type is invalid");
  const runId = propertyString(record, RUN.runId);
  const customerId = propertyString(record, RUN.customerId);
  const campaignId = propertyString(record, RUN.campaignId);
  const policyDigest = propertyString(record, RUN.policyDigest);
  const status = propertyString(record, RUN.status) as BiddingSupervisorRunStatus;
  if (!(["PREPARED", "APPLIED", "NOOP", "FAILED", "ROLLED_BACK"] as const).includes(status)) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "run status is invalid");
  const raw = object(json(record.properties[RUN.payload], "run payload"), "run payload");
  const mode = raw.mode as BiddingSupervisorMode;
  const direction = raw.direction as BiddingSupervisorDirection;
  const reason = raw.reason as BiddingSupervisorReason;
  if (!(["ACTIVE", "OBSERVE_ONLY", "KILLED"] as const).includes(mode)) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "run mode is invalid");
  if (!(["INCREASE_VOLUME", "DECREASE_RISK", "HOLD"] as const).includes(direction)) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "run direction is invalid");
  if (!RUN_REASONS.includes(reason)) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "run reason is invalid");
  if (typeof raw.windowStart !== "string" || typeof raw.windowEnd !== "string") throw new BiddingSupervisorError("INTEGRITY_FAILURE", "run window is invalid");
  const payload: RunPayload = {
    mode, direction, reason, windowStart: raw.windowStart, windowEnd: raw.windowEnd,
    campaignSnapshot: (raw.campaignSnapshot ?? null) as unknown as GoogleAdsCampaignSnapshot | null,
    portfolioSnapshot: (raw.portfolioSnapshot ?? null) as unknown as GoogleAdsPortfolioSnapshot | null,
    businessSnapshot: (raw.businessSnapshot ?? null) as unknown as BusinessProfitabilitySnapshot | null,
    evidence: parseEvidence(raw.evidence), action: parseAction(raw.action), receipt: parseReceipt(raw.receipt),
    errorCode: nullableString(raw.errorCode, "run.errorCode"),
  };
  const createdAt = canonicalUtc(propertyString(record, RUN.createdAt), "run.createdAt");
  const updatedAt = canonicalUtc(propertyString(record, RUN.updatedAt), "run.updatedAt");
  const observedDigest = propertyString(record, RUN.digest);
  if (observedDigest !== runDigest(runId, customerId, campaignId, policyDigest, status, payload, createdAt, updatedAt)) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "run digest mismatch");
  return Object.freeze({ id: record.id, runId, customerId, campaignId, policyDigest, status, ...payload, digest: observedDigest, createdAt, updatedAt, revision: record.revision });
}

function evidenceFrom(google: Pick<GoogleAdsCampaignSnapshot | GoogleAdsPortfolioSnapshot, "costMicros" | "conversions" | "conversionValue">, business: BusinessProfitabilitySnapshot): BiddingSupervisorEvidence {
  const ratio = google.costMicros > 0 ? business.grossProfitBeforeAdSpendMicros / google.costMicros : 0;
  return Object.freeze({
    googleCostMicros: google.costMicros, googleConversions: google.conversions, googleConversionValue: google.conversionValue,
    businessRevenueMicros: business.revenueMicros, businessGrossProfitBeforeAdSpendMicros: business.grossProfitBeforeAdSpendMicros,
    businessQualifiedConversions: business.qualifiedConversions, profitAfterAdSpendMicros: business.grossProfitBeforeAdSpendMicros - google.costMicros,
    profitToSpendRatio: ratio, sourceId: business.sourceId,
  });
}

function validateBusiness(snapshot: BusinessProfitabilitySnapshot, query: BusinessProfitabilityQuery, nowMs: number, policy: BiddingSupervisorPolicy): "FRESH" | "STALE" {
  if (snapshot.customerId !== query.customerId || snapshot.scopeKind !== query.scopeKind || snapshot.scopeId !== query.scopeId || snapshot.windowStart !== query.windowStart || snapshot.windowEnd !== query.windowEnd) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "business snapshot scope/window mismatch");
  nonNegativeSafeInteger(snapshot.revenueMicros, "business revenueMicros");
  nonNegativeSafeInteger(snapshot.grossProfitBeforeAdSpendMicros, "business grossProfitBeforeAdSpendMicros");
  if (!Number.isFinite(snapshot.qualifiedConversions) || snapshot.qualifiedConversions < 0) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "business qualifiedConversions is invalid");
  normalizeIdentifier(snapshot.sourceId, "business sourceId");
  const observedAt = canonicalUtc(snapshot.observedAt, "business observedAt");
  const age = nowMs - Date.parse(observedAt);
  if (age < 0) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "business snapshot cannot be from the future");
  return age > policy.maxBusinessDataAgeMs ? "STALE" : "FRESH";
}

function directionFor(evidence: BiddingSupervisorEvidence, policy: BiddingSupervisorPolicy): BiddingSupervisorDirection {
  if (evidence.profitToSpendRatio >= policy.increaseVolumeProfitToSpendRatio) return "INCREASE_VOLUME";
  if (evidence.profitToSpendRatio <= policy.decreaseRiskProfitToSpendRatio) return "DECREASE_RISK";
  return "HOLD";
}

function sufficient(google: Pick<GoogleAdsCampaignSnapshot | GoogleAdsPortfolioSnapshot, "costMicros" | "conversions">, policy: BiddingSupervisorPolicy): boolean {
  return google.costMicros >= policy.minimumCostMicros && google.conversions >= policy.minimumGoogleConversions;
}

function boundedInteger(current: number, fractionValue: number, direction: "UP" | "DOWN", min: number, max: number): number {
  const raw = direction === "UP" ? current * (1 + fractionValue) : current * (1 - fractionValue);
  return Math.max(min, Math.min(max, direction === "UP" ? Math.ceil(raw) : Math.floor(raw)));
}

function boundedFloat(current: number, fractionValue: number, direction: "UP" | "DOWN", min: number, max: number): number {
  const raw = direction === "UP" ? current * (1 + fractionValue) : current * (1 - fractionValue);
  return Math.max(min, Math.min(max, Number(raw.toFixed(6))));
}

function reverseAction(action: GoogleAdsControlMutation): GoogleAdsControlMutation {
  if (action.kind === "CAMPAIGN_BUDGET") return { ...action, expectedAmountMicros: action.nextAmountMicros, nextAmountMicros: action.expectedAmountMicros };
  if (action.kind === "STANDARD_TARGET_CPA") return { ...action, expectedTargetCpaMicros: action.nextTargetCpaMicros, nextTargetCpaMicros: action.expectedTargetCpaMicros };
  if (action.kind === "STANDARD_TARGET_ROAS") return { ...action, expectedTargetRoas: action.nextTargetRoas, nextTargetRoas: action.expectedTargetRoas };
  if (action.kind === "PORTFOLIO_TARGET_CPA") return { ...action, expectedTargetCpaMicros: action.nextTargetCpaMicros, nextTargetCpaMicros: action.expectedTargetCpaMicros };
  if (action.kind === "PORTFOLIO_TARGET_ROAS") return { ...action, expectedTargetRoas: action.nextTargetRoas, nextTargetRoas: action.expectedTargetRoas };
  return { ...action, expectedCeilingMicros: action.nextCeilingMicros, nextCeilingMicros: action.expectedCeilingMicros, expectedFloorMicros: action.nextFloorMicros, nextFloorMicros: action.expectedFloorMicros };
}

function transactionConflict(error: unknown): boolean {
  return error instanceof OntologyTransactionError && error.code === "CONFLICT";
}

export class PeriodicGoogleAdsBiddingSupervisor {
  readonly schema: ValidatedSchema;

  constructor(
    private readonly transactions: OntologyTransactionPort,
    readonly scope: OntologyScope,
    readonly policy: BiddingSupervisorPolicy,
    private readonly googleAds: GoogleAdsBiddingGateway,
    private readonly business: BusinessProfitabilityProvider,
    private readonly now: () => number = Date.now,
  ) {
    this.schema = supervisorSchema(scope);
  }

  private time() {
    const ms = this.now();
    if (!Number.isFinite(ms)) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "engine clock is invalid");
    return Object.freeze({ ms, iso: new Date(ms).toISOString() });
  }

  private stateId(customerId: string, campaignId: string): string {
    return ontologyId("cortex-bidding-state", { scope: this.scope, policyDigest: this.policy.digest, customerId, campaignId });
  }

  private runObjectId(runId: string, customerId: string, campaignId: string): string {
    return ontologyId("cortex-bidding-run", { scope: this.scope, policyDigest: this.policy.digest, runId, customerId, campaignId });
  }

  private readState(customerId: string, campaignId: string): StateRecord | undefined {
    const raw = this.transactions.getObject(this.scope, this.stateId(customerId, campaignId));
    return raw ? parseState(raw) : undefined;
  }

  private readRun(runId: string, customerId: string, campaignId: string): RunRecord | undefined {
    const raw = this.transactions.getObject(this.scope, this.runObjectId(runId, customerId, campaignId));
    return raw ? parseRun(raw) : undefined;
  }

  private result(run: RunRecord): BiddingSupervisorResult {
    return Object.freeze({ runId: run.runId, customerId: run.customerId, campaignId: run.campaignId, status: run.status, mode: run.mode, direction: run.direction, reason: run.reason, windowStart: run.windowStart, windowEnd: run.windowEnd, action: run.action, receipt: run.receipt, evidence: run.evidence, policyDigest: run.policyDigest, digest: run.digest });
  }

  private campaignCandidates(campaign: GoogleAdsCampaignSnapshot, business: BusinessProfitabilitySnapshot, evidence: BiddingSupervisorEvidence, direction: Exclude<BiddingSupervisorDirection, "HOLD">): PlannedAction[] {
    const candidates: PlannedAction[] = [];
    const increase = direction === "INCREASE_VOLUME";
    if (!campaign.budgetExplicitlyShared || this.policy.allowSharedBudgets) {
      let next = boundedInteger(campaign.budgetAmountMicros, this.policy.budgetStepFraction, increase ? "UP" : "DOWN", this.policy.minBudgetMicros, this.policy.maxBudgetMicros);
      if (increase && campaign.recommendedBudgetAmountMicros && campaign.recommendedBudgetAmountMicros > campaign.budgetAmountMicros) next = Math.min(next, campaign.recommendedBudgetAmountMicros);
      if (next !== campaign.budgetAmountMicros) candidates.push({ action: { kind: "CAMPAIGN_BUDGET", resourceName: campaign.budgetResourceName, expectedAmountMicros: campaign.budgetAmountMicros, nextAmountMicros: next }, evidence, business, direction });
    }
    if (!campaign.portfolioBiddingStrategyResourceName && campaign.biddingStrategyType === "MAXIMIZE_CONVERSIONS" && campaign.standardTargetCpaMicros !== null) {
      const next = boundedInteger(campaign.standardTargetCpaMicros, this.policy.targetStepFraction, increase ? "UP" : "DOWN", this.policy.minTargetCpaMicros, this.policy.maxTargetCpaMicros);
      if (next !== campaign.standardTargetCpaMicros) candidates.push({ action: { kind: "STANDARD_TARGET_CPA", resourceName: campaign.campaignResourceName, expectedTargetCpaMicros: campaign.standardTargetCpaMicros, nextTargetCpaMicros: next }, evidence, business, direction });
    }
    if (!campaign.portfolioBiddingStrategyResourceName && campaign.biddingStrategyType === "MAXIMIZE_CONVERSION_VALUE" && campaign.standardTargetRoas !== null) {
      const next = boundedFloat(campaign.standardTargetRoas, this.policy.targetStepFraction, increase ? "DOWN" : "UP", this.policy.minTargetRoas, this.policy.maxTargetRoas);
      if (next !== campaign.standardTargetRoas) candidates.push({ action: { kind: "STANDARD_TARGET_ROAS", resourceName: campaign.campaignResourceName, expectedTargetRoas: campaign.standardTargetRoas, nextTargetRoas: next }, evidence, business, direction });
    }
    return candidates;
  }

  private portfolioCandidates(portfolio: GoogleAdsPortfolioSnapshot, business: BusinessProfitabilitySnapshot, evidence: BiddingSupervisorEvidence, direction: Exclude<BiddingSupervisorDirection, "HOLD">): PlannedAction[] {
    const candidates: PlannedAction[] = [];
    const increase = direction === "INCREASE_VOLUME";
    if ((portfolio.type === "TARGET_CPA" || portfolio.type === "MAXIMIZE_CONVERSIONS") && portfolio.targetCpaMicros !== null) {
      const next = boundedInteger(portfolio.targetCpaMicros, this.policy.targetStepFraction, increase ? "UP" : "DOWN", this.policy.minTargetCpaMicros, this.policy.maxTargetCpaMicros);
      if (next !== portfolio.targetCpaMicros) candidates.push({ action: { kind: "PORTFOLIO_TARGET_CPA", resourceName: portfolio.resourceName, strategyType: portfolio.type, expectedTargetCpaMicros: portfolio.targetCpaMicros, nextTargetCpaMicros: next }, evidence, business, direction });
    }
    if ((portfolio.type === "TARGET_ROAS" || portfolio.type === "MAXIMIZE_CONVERSION_VALUE") && portfolio.targetRoas !== null) {
      const next = boundedFloat(portfolio.targetRoas, this.policy.targetStepFraction, increase ? "DOWN" : "UP", this.policy.minTargetRoas, this.policy.maxTargetRoas);
      if (next !== portfolio.targetRoas) candidates.push({ action: { kind: "PORTFOLIO_TARGET_ROAS", resourceName: portfolio.resourceName, strategyType: portfolio.type, expectedTargetRoas: portfolio.targetRoas, nextTargetRoas: next }, evidence, business, direction });
    }
    if (this.policy.managePortfolioBidBounds && portfolio.cpcBidCeilingMicros !== null) {
      const nextCeiling = boundedInteger(portfolio.cpcBidCeilingMicros, this.policy.bidBoundStepFraction, increase ? "UP" : "DOWN", this.policy.minPortfolioCpcCeilingMicros, this.policy.maxPortfolioCpcCeilingMicros);
      let nextFloor = portfolio.cpcBidFloorMicros;
      if (increase && nextFloor !== null) nextFloor = Math.max(1, Math.floor(nextFloor * (1 - this.policy.bidBoundStepFraction)));
      if (nextFloor !== null && nextFloor > nextCeiling) nextFloor = nextCeiling;
      if (nextCeiling !== portfolio.cpcBidCeilingMicros || nextFloor !== portfolio.cpcBidFloorMicros) candidates.push({ action: { kind: "PORTFOLIO_BID_BOUNDS", resourceName: portfolio.resourceName, strategyType: portfolio.type, expectedCeilingMicros: portfolio.cpcBidCeilingMicros, nextCeilingMicros: nextCeiling, expectedFloorMicros: portfolio.cpcBidFloorMicros, nextFloorMicros: nextFloor }, evidence, business, direction });
    }
    return candidates;
  }

  private choose(candidates: readonly PlannedAction[], lastKind: BiddingSupervisorActionKind | null): PlannedAction | null {
    if (candidates.length === 0) return null;
    if (!lastKind) return candidates[0]!;
    const index = candidates.findIndex((candidate) => candidate.action.kind === lastKind);
    return index < 0 ? candidates[0]! : candidates[(index + 1) % candidates.length]!;
  }

  private acquire(runId: string, customerId: string, campaignId: string, planned: RunPayload, nowMs: number, nowIso: string): RunRecord {
    for (let attempt = 0; attempt <= this.policy.maxWriteRetries; attempt += 1) {
      const existing = this.readRun(runId, customerId, campaignId);
      if (existing) return existing;
      const state = this.readState(customerId, campaignId);
      if (state?.inFlightRunId && state.inFlightRunId !== runId) {
        const inFlight = this.readRun(state.inFlightRunId, customerId, campaignId);
        if (!inFlight) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "state references missing in-flight run");
        return inFlight;
      }
      const cooldownActive = planned.action !== null && state?.lastMutationAt != null && nowMs - Date.parse(state.lastMutationAt) < this.policy.cooldownMs;
      const payload: RunPayload = cooldownActive ? { ...planned, action: null, reason: "COOLDOWN" } : planned;
      const nextState: StatePayload = {
        lastRunAt: state?.lastRunAt ?? null,
        lastMutationAt: state?.lastMutationAt ?? null,
        lastActionKind: state?.lastActionKind ?? null,
        inFlightRunId: runId,
        lastAppliedAction: state?.lastAppliedAction ?? null,
        lastRollbackAt: state?.lastRollbackAt ?? null,
      };
      const operations: TransactionOperation[] = [
        { kind: "CREATE_OBJECT", record: { id: this.runObjectId(runId, customerId, campaignId), typeId: RUN_TYPE, scope: this.scope, properties: runProperties(runId, customerId, campaignId, this.policy.digest, "PREPARED", payload, nowIso, nowIso) } },
        state
          ? { kind: "UPDATE_OBJECT", id: state.id, expectedRevision: state.revision, properties: stateProperties(customerId, campaignId, this.policy.digest, nextState, nowIso) }
          : { kind: "CREATE_OBJECT", record: { id: this.stateId(customerId, campaignId), typeId: STATE_TYPE, scope: this.scope, properties: stateProperties(customerId, campaignId, this.policy.digest, nextState, nowIso) } },
      ];
      try {
        this.transactions.transact(this.scope, this.schema, operations);
        const stored = this.readRun(runId, customerId, campaignId);
        if (!stored) throw new BiddingSupervisorError("PERSISTENCE_FAILURE", "prepared run unreadable after commit");
        return stored;
      } catch (error) {
        if (transactionConflict(error) && attempt < this.policy.maxWriteRetries) continue;
        if (transactionConflict(error)) throw new BiddingSupervisorError("CONFLICT", "run preparation conflicted after retries");
        if (error instanceof BiddingSupervisorError) throw error;
        throw new BiddingSupervisorError("PERSISTENCE_FAILURE", error instanceof Error ? error.message : "run preparation failed");
      }
    }
    throw new BiddingSupervisorError("CONFLICT", "run preparation exhausted retries");
  }

  private finalize(run: RunRecord, status: Exclude<BiddingSupervisorRunStatus, "PREPARED">, payload: RunPayload, nowIso: string, effect: FinalizeEffect): RunRecord {
    for (let attempt = 0; attempt <= this.policy.maxWriteRetries; attempt += 1) {
      const currentRun = this.readRun(run.runId, run.customerId, run.campaignId);
      if (!currentRun) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "run disappeared before finalize");
      if (currentRun.status !== "PREPARED") return currentRun;
      const state = this.readState(run.customerId, run.campaignId);
      if (!state || state.inFlightRunId !== run.runId) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "run no longer owns state lock");
      const nextState: StatePayload = {
        lastRunAt: nowIso,
        lastMutationAt: effect === "NONE" ? state.lastMutationAt : nowIso,
        lastActionKind: effect === "APPLY" && payload.action ? payload.action.kind : state.lastActionKind,
        inFlightRunId: null,
        lastAppliedAction: effect === "APPLY" && payload.action ? payload.action : effect === "ROLLBACK" ? null : state.lastAppliedAction,
        lastRollbackAt: effect === "ROLLBACK" ? nowIso : state.lastRollbackAt,
      };
      try {
        this.transactions.transact(this.scope, this.schema, [
          { kind: "UPDATE_OBJECT", id: currentRun.id, expectedRevision: currentRun.revision, properties: runProperties(currentRun.runId, currentRun.customerId, currentRun.campaignId, currentRun.policyDigest, status, payload, currentRun.createdAt, nowIso) },
          { kind: "UPDATE_OBJECT", id: state.id, expectedRevision: state.revision, properties: stateProperties(state.customerId, state.campaignId, state.policyDigest, nextState, nowIso) },
        ]);
        const stored = this.readRun(run.runId, run.customerId, run.campaignId);
        if (!stored) throw new BiddingSupervisorError("PERSISTENCE_FAILURE", "finalized run unreadable after commit");
        return stored;
      } catch (error) {
        if (transactionConflict(error) && attempt < this.policy.maxWriteRetries) continue;
        if (transactionConflict(error)) throw new BiddingSupervisorError("CONFLICT", "run finalize conflicted after retries");
        if (error instanceof BiddingSupervisorError) throw error;
        throw new BiddingSupervisorError("PERSISTENCE_FAILURE", error instanceof Error ? error.message : "run finalize failed");
      }
    }
    throw new BiddingSupervisorError("CONFLICT", "run finalize exhausted retries");
  }

  private async execute(run: RunRecord, executionMode: BiddingSupervisorMode): Promise<BiddingSupervisorResult> {
    if (run.status !== "PREPARED") return this.result(run);
    if (executionMode !== "ACTIVE" && run.action) {
      throw new BiddingSupervisorError("POLICY_VIOLATION", `${executionMode} freezes the prepared mutation; ACTIVE reconciliation is required before any remote write`);
    }
    if (!run.action || run.mode !== "ACTIVE") return this.result(this.finalize(run, "NOOP", run, this.time().iso, "NONE"));
    const rollback = run.reason === "ROLLBACK_APPLIED";
    try {
      const receipt = await this.googleAds.applyMutation(run.customerId, run.action);
      const reason: BiddingSupervisorReason = rollback ? "ROLLBACK_APPLIED" : receipt.recoveredAlreadyApplied ? "ACTION_RECOVERED" : "ACTION_APPLIED";
      const payload: RunPayload = { ...run, reason, receipt, errorCode: null };
      return this.result(this.finalize(run, rollback ? "ROLLED_BACK" : "APPLIED", payload, this.time().iso, rollback ? "ROLLBACK" : "APPLY"));
    } catch (error) {
      if (error instanceof GoogleAdsApiError && error.code === "AMBIGUOUS_MUTATION_OUTCOME") {
        throw new BiddingSupervisorError("REMOTE_FAILURE", "Google Ads mutation outcome is ambiguous; run remains PREPARED for preflight recovery");
      }
      const reason: BiddingSupervisorReason = error instanceof GoogleAdsApiError && error.code === "REMOTE_CONFLICT" ? "REMOTE_CONFLICT" : "API_FAILURE";
      const payload: RunPayload = { ...run, reason, receipt: null, errorCode: error instanceof GoogleAdsApiError ? error.code : "UNKNOWN_REMOTE_FAILURE" };
      this.finalize(run, "FAILED", payload, this.time().iso, "NONE");
      throw new BiddingSupervisorError("REMOTE_FAILURE", `${reason}: Google Ads mutation was not certified as applied`);
    }
  }

  async supervise(input: BiddingSupervisorRunInput): Promise<BiddingSupervisorResult> {
    const requestedRunId = normalizeIdentifier(input.runId, "runId");
    const customerId = normalizeNumericId(input.customerId, "customerId");
    const campaignId = normalizeNumericId(input.campaignId, "campaignId");
    const mode = effectiveMode(this.policy.mode, input.mode);
    const existing = this.readRun(requestedRunId, customerId, campaignId);
    if (existing) return this.execute(existing, mode);
    const initialState = this.readState(customerId, campaignId);
    if (initialState?.inFlightRunId) {
      const inFlight = this.readRun(initialState.inFlightRunId, customerId, campaignId);
      if (!inFlight) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "state references missing in-flight run");
      return this.execute(inFlight, mode);
    }
    const { ms: nowMs, iso: nowIso } = this.time();
    const window = reportWindow(nowMs, this.policy);
    if (mode === "KILLED") {
      const payload: RunPayload = { mode, direction: "HOLD", reason: "KILL_SWITCH", windowStart: window.start, windowEnd: window.end, campaignSnapshot: null, portfolioSnapshot: null, businessSnapshot: null, evidence: null, action: null, receipt: null, errorCode: null };
      return this.execute(this.acquire(requestedRunId, customerId, campaignId, payload, nowMs, nowIso), mode);
    }

    const campaign = await this.googleAds.getCampaignSnapshot(customerId, campaignId, window.startMs, window.endMs);
    const campaignQuery: BusinessProfitabilityQuery = { customerId, scopeKind: "CAMPAIGN", scopeId: campaignId, windowStart: window.start, windowEnd: window.end };
    const campaignBusiness = Object.freeze({ ...(await this.business.getProfitability(campaignQuery)) });
    const campaignFreshness = validateBusiness(campaignBusiness, campaignQuery, nowMs, this.policy);
    const campaignEvidence = evidenceFrom(campaign, campaignBusiness);

    let portfolio: GoogleAdsPortfolioSnapshot | null = null;
    let portfolioBusiness: BusinessProfitabilitySnapshot | null = null;
    let portfolioEvidence: BiddingSupervisorEvidence | null = null;
    let portfolioFreshness: "FRESH" | "STALE" | null = null;
    if (campaign.portfolioBiddingStrategyResourceName) {
      portfolio = await this.googleAds.getPortfolioSnapshot(customerId, campaign.portfolioBiddingStrategyResourceName, window.startMs, window.endMs);
      const portfolioQuery: BusinessProfitabilityQuery = { customerId, scopeKind: "BIDDING_STRATEGY", scopeId: portfolio.strategyId, windowStart: window.start, windowEnd: window.end };
      portfolioBusiness = Object.freeze({ ...(await this.business.getProfitability(portfolioQuery)) });
      portfolioFreshness = validateBusiness(portfolioBusiness, portfolioQuery, nowMs, this.policy);
      portfolioEvidence = evidenceFrom(portfolio, portfolioBusiness);
    }

    let reason: BiddingSupervisorReason = "NO_COMPATIBLE_CONTROL";
    let chosen: PlannedAction | null = null;
    const latestState = this.readState(customerId, campaignId);
    if (campaign.status !== "ENABLED") {
      reason = "CAMPAIGN_NOT_ENABLED";
    } else if (latestState?.lastMutationAt && nowMs - Date.parse(latestState.lastMutationAt) < this.policy.cooldownMs) {
      reason = "COOLDOWN";
    } else {
      const candidates: PlannedAction[] = [];
      let freshEvidence = false;
      let enoughEvidence = false;
      let holdEvidence = false;
      if (campaignFreshness === "FRESH") {
        freshEvidence = true;
        if (sufficient(campaign, this.policy)) {
          enoughEvidence = true;
          const direction = directionFor(campaignEvidence, this.policy);
          if (direction === "HOLD") holdEvidence = true;
          else candidates.push(...this.campaignCandidates(campaign, campaignBusiness, campaignEvidence, direction));
        }
      }
      if (portfolio && portfolioBusiness && portfolioEvidence && portfolioFreshness === "FRESH") {
        freshEvidence = true;
        if (sufficient(portfolio, this.policy)) {
          enoughEvidence = true;
          const direction = directionFor(portfolioEvidence, this.policy);
          if (direction === "HOLD") holdEvidence = true;
          else candidates.push(...this.portfolioCandidates(portfolio, portfolioBusiness, portfolioEvidence, direction));
        }
      }
      chosen = this.choose(candidates, latestState?.lastActionKind ?? null);
      if (chosen) reason = mode === "OBSERVE_ONLY" ? "OBSERVE_ONLY" : "ACTION_APPLIED";
      else if (!freshEvidence) reason = "STALE_BUSINESS_DATA";
      else if (!enoughEvidence) reason = "INSUFFICIENT_EVIDENCE";
      else if (holdEvidence) reason = "PROFITABILITY_HOLD";
      else if (campaign.budgetExplicitlyShared && !this.policy.allowSharedBudgets && !campaign.portfolioBiddingStrategyResourceName) reason = "SHARED_BUDGET_BLOCKED";
      else reason = "NO_COMPATIBLE_CONTROL";
    }

    const payload: RunPayload = {
      mode,
      direction: chosen?.direction ?? "HOLD",
      reason,
      windowStart: window.start,
      windowEnd: window.end,
      campaignSnapshot: campaign,
      portfolioSnapshot: portfolio,
      businessSnapshot: chosen?.business ?? campaignBusiness,
      evidence: chosen?.evidence ?? campaignEvidence,
      action: chosen?.action ?? null,
      receipt: null,
      errorCode: null,
    };
    return this.execute(this.acquire(requestedRunId, customerId, campaignId, payload, nowMs, nowIso), mode);
  }

  async rollbackLastMutation(input: BiddingSupervisorRollbackInput): Promise<BiddingSupervisorResult> {
    const runId = normalizeIdentifier(input.runId, "runId");
    const customerId = normalizeNumericId(input.customerId, "customerId");
    const campaignId = normalizeNumericId(input.campaignId, "campaignId");
    const existing = this.readRun(runId, customerId, campaignId);
    if (existing) return this.execute(existing, "ACTIVE");
    const state = this.readState(customerId, campaignId);
    if (!state?.lastAppliedAction) throw new BiddingSupervisorError("POLICY_VIOLATION", "no applied action is available for rollback");
    if (state.inFlightRunId) {
      const inFlight = this.readRun(state.inFlightRunId, customerId, campaignId);
      if (!inFlight) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "state references missing in-flight run");
      return this.execute(inFlight, "ACTIVE");
    }
    const { ms: nowMs, iso: nowIso } = this.time();
    const window = reportWindow(nowMs, this.policy);
    const payload: RunPayload = { mode: "ACTIVE", direction: "HOLD", reason: "ROLLBACK_APPLIED", windowStart: window.start, windowEnd: window.end, campaignSnapshot: null, portfolioSnapshot: null, businessSnapshot: null, evidence: null, action: reverseAction(state.lastAppliedAction), receipt: null, errorCode: null };
    return this.execute(this.acquire(runId, customerId, campaignId, payload, nowMs, nowIso), "ACTIVE");
  }
}
