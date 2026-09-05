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

const STATE_TYPE = "cortex.bandit_state";
const DECISION_TYPE = "cortex.bandit_decision";

const STATE = Object.freeze({
  experimentId: "cortex.bandit.state.experiment_id",
  configurationDigest: "cortex.bandit.state.configuration_digest",
  policyDigest: "cortex.bandit.state.policy_digest",
  armId: "cortex.bandit.state.arm_id",
  contextKey: "cortex.bandit.state.context_key",
  exposures: "cortex.bandit.state.exposures",
  observations: "cortex.bandit.state.observations",
  conversions: "cortex.bandit.state.conversions",
  economicValueSum: "cortex.bandit.state.economic_value_sum",
  rewardSum: "cortex.bandit.state.reward_sum",
  rewardSquareSum: "cortex.bandit.state.reward_square_sum",
  createdAt: "cortex.bandit.state.created_at",
  updatedAt: "cortex.bandit.state.updated_at",
  digest: "cortex.bandit.state.digest",
});

const DECISION = Object.freeze({
  experimentId: "cortex.bandit.decision.experiment_id",
  requestId: "cortex.bandit.decision.request_id",
  armId: "cortex.bandit.decision.arm_id",
  contextKey: "cortex.bandit.decision.context_key",
  contextDigest: "cortex.bandit.decision.context_digest",
  eligibilityDigest: "cortex.bandit.decision.eligibility_digest",
  configurationDigest: "cortex.bandit.decision.configuration_digest",
  policyDigest: "cortex.bandit.decision.policy_digest",
  mode: "cortex.bandit.decision.mode",
  reason: "cortex.bandit.decision.reason",
  issuedAt: "cortex.bandit.decision.issued_at",
  status: "cortex.bandit.decision.status",
  evidence: "cortex.bandit.decision.evidence",
  rewardConfig: "cortex.bandit.decision.reward_config",
  maxRewardDelayMs: "cortex.bandit.decision.max_reward_delay_ms",
  converted: "cortex.bandit.decision.converted",
  economicValue: "cortex.bandit.decision.economic_value",
  reward: "cortex.bandit.decision.reward",
  outcomeAt: "cortex.bandit.decision.outcome_at",
  digest: "cortex.bandit.decision.digest",
});

const IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;
const EPSILON = 1e-12;

export type CortexBanditMode = "ACTIVE" | "FALLBACK_ONLY" | "KILLED";
export type CortexBanditDecisionStatus = "PENDING" | "REWARDED";
export type CortexBanditDecisionReason =
  | "KILL_SWITCH"
  | "ROLLBACK_FALLBACK"
  | "TRAFFIC_FLOOR"
  | "MINIMUM_OBSERVATION"
  | "CONFIDENT_WINNER"
  | "DETERMINISTIC_FALLBACK"
  | "TRAFFIC_CAP_REBALANCE";

export type CortexBanditContextValue = string | number | boolean;
export type CortexBanditContext = Readonly<Record<string, CortexBanditContextValue>>;

export interface CortexBanditArmDefinition {
  readonly armId: string;
  readonly payload: Readonly<Record<string, JsonValue>>;
  readonly minTrafficShare: number;
  readonly maxTrafficShare: number;
}

export interface CreateCortexBanditPolicyInput {
  readonly policyId: string;
  readonly version: string;
  readonly defaultArmId: string;
  readonly minimumObservationsPerArm: number;
  readonly confidenceLevel: number;
  readonly ucbExplorationCoefficient: number;
  readonly maxArms: number;
  readonly maxContextFeatures: number;
  readonly allowedContextKeys: readonly string[];
  readonly maxRewardDelayMs: number;
  readonly conversionWeight: number;
  readonly economicValueWeight: number;
  readonly economicValueNormalizationCap: number;
  readonly maxWriteRetries?: number;
  readonly mode?: CortexBanditMode;
}

export interface CortexBanditPolicy extends Required<Omit<CreateCortexBanditPolicyInput, "maxWriteRetries" | "mode">> {
  readonly maxWriteRetries: number;
  readonly mode: CortexBanditMode;
  readonly digest: string;
}

export interface CortexBanditSelectionRequest {
  readonly requestId: string;
  readonly context: CortexBanditContext;
  readonly eligibleArmIds: readonly string[];
  readonly mode?: CortexBanditMode;
}

export interface CortexBanditOutcomeInput {
  readonly decisionId: string;
  readonly converted: boolean;
  readonly economicValue: number;
  readonly outcomeAt: string;
}

export interface CortexBanditArmEvidence {
  readonly armId: string;
  readonly exposures: number;
  readonly observations: number;
  readonly pendingOutcomes: number;
  readonly conversions: number;
  readonly conversionRate: number;
  readonly trafficShare: number;
  readonly economicValueSum: number;
  readonly revenuePerExposure: number;
  readonly meanReward: number;
  readonly confidenceLower: number;
  readonly confidenceUpper: number;
  readonly ucbScore: number;
  readonly minTrafficShare: number;
  readonly maxTrafficShare: number;
}

export interface CortexBanditSelectionEvidence {
  readonly totalExposures: number;
  readonly totalObservations: number;
  readonly confidenceLevel: number;
  readonly minimumObservationsPerArm: number;
  readonly confidentWinnerArmId: string | null;
  readonly arms: readonly CortexBanditArmEvidence[];
}

export interface CortexBanditDecision {
  readonly decisionId: string;
  readonly experimentId: string;
  readonly requestId: string;
  readonly armId: string;
  readonly payload: Readonly<Record<string, JsonValue>>;
  readonly contextKey: string;
  readonly contextDigest: string;
  readonly eligibilityDigest: string;
  readonly configurationDigest: string;
  readonly policyDigest: string;
  readonly mode: CortexBanditMode;
  readonly reason: CortexBanditDecisionReason;
  readonly issuedAt: string;
  readonly status: CortexBanditDecisionStatus;
  readonly evidence: CortexBanditSelectionEvidence;
  readonly converted: boolean | null;
  readonly economicValue: number | null;
  readonly reward: number | null;
  readonly outcomeAt: string | null;
  readonly digest: string;
}

export interface CortexBanditAuditSnapshot {
  readonly experimentId: string;
  readonly contextKey: string;
  readonly contextDigest: string;
  readonly configurationDigest: string;
  readonly policyDigest: string;
  readonly generatedAt: string;
  readonly evidence: CortexBanditSelectionEvidence;
  readonly digest: string;
}

interface RewardConfig {
  readonly conversionWeight: number;
  readonly economicValueWeight: number;
  readonly economicValueNormalizationCap: number;
}

interface StateRecord {
  readonly id: string;
  readonly experimentId: string;
  readonly configurationDigest: string;
  readonly policyDigest: string;
  readonly armId: string;
  readonly contextKey: string;
  readonly exposures: number;
  readonly observations: number;
  readonly conversions: number;
  readonly economicValueSum: number;
  readonly rewardSum: number;
  readonly rewardSquareSum: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly digest: string;
  readonly revision: number;
}

interface DecisionRecord {
  readonly id: string;
  readonly experimentId: string;
  readonly requestId: string;
  readonly armId: string;
  readonly contextKey: string;
  readonly contextDigest: string;
  readonly eligibilityDigest: string;
  readonly configurationDigest: string;
  readonly policyDigest: string;
  readonly mode: CortexBanditMode;
  readonly reason: CortexBanditDecisionReason;
  readonly issuedAt: string;
  readonly status: CortexBanditDecisionStatus;
  readonly evidence: CortexBanditSelectionEvidence;
  readonly rewardConfig: RewardConfig;
  readonly maxRewardDelayMs: number;
  readonly converted: boolean | null;
  readonly economicValue: number | null;
  readonly reward: number | null;
  readonly outcomeAt: string | null;
  readonly digest: string;
  readonly revision: number;
}

export class CortexBanditError extends Error {
  constructor(
    public readonly code:
      | "INVALID_INPUT"
      | "NOT_FOUND"
      | "CONFLICT"
      | "POLICY_VIOLATION"
      | "INTEGRITY_FAILURE"
      | "REWARD_EXPIRED"
      | "PERSISTENCE_FAILURE",
    message: string,
  ) {
    super(message);
    this.name = "CortexBanditError";
  }
}

function digest(namespace: string, value: unknown): string {
  return `sha256:${createHash("sha256").update(`${namespace}\n${canonicalJson(value)}`, "utf8").digest("hex")}`;
}

function normalizeIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!IDENTIFIER.test(normalized)) throw new CortexBanditError("INVALID_INPUT", `${field} is malformed`);
  return normalized;
}

function finiteNonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) throw new CortexBanditError("INVALID_INPUT", `${field} must be finite and non-negative`);
  return value;
}

function storedFiniteNonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) throw new CortexBanditError("INTEGRITY_FAILURE", `${field} must be finite and non-negative`);
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new CortexBanditError("INVALID_INPUT", `${field} must be a positive integer`);
  return value;
}

function storedPositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new CortexBanditError("INTEGRITY_FAILURE", `${field} must be a positive integer`);
  return value;
}

function boundedShare(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new CortexBanditError("INVALID_INPUT", `${field} must be between 0 and 1`);
  return value;
}

function assertCanonicalUtc(value: string, field: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new CortexBanditError("INVALID_INPUT", `${field} must be canonical ISO-8601 UTC`);
  }
  return value;
}

function assertStoredCanonicalUtc(value: string, field: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new CortexBanditError("INTEGRITY_FAILURE", `${field} must be canonical ISO-8601 UTC`);
  }
  return value;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function cloneJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => cloneJson(item)));
  if (value && typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)])));
  }
  return value;
}

function clonePayload(payload: Readonly<Record<string, JsonValue>>): Readonly<Record<string, JsonValue>> {
  if (!isJsonValue(payload)) throw new CortexBanditError("INVALID_INPUT", "arm payload must be finite JSON data");
  return Object.freeze(Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, cloneJson(value)])));
}

function property(
  id: string,
  name: string,
  valueKind: "STRING" | "NUMBER" | "BOOLEAN" | "DATETIME" | "JSON",
  cardinality: "REQUIRED" | "OPTIONAL",
  immutable = false,
) {
  return { id, name, valueKind, cardinality, unique: false, immutable } as const;
}

function cortexBanditSchema(scope: OntologyScope): ValidatedSchema {
  const schema: SchemaVersion = {
    version: "cortex-contextual-bandit-v1",
    scope,
    properties: [
      property(STATE.experimentId, "StateExperimentId", "STRING", "REQUIRED", true),
      property(STATE.configurationDigest, "StateConfigurationDigest", "STRING", "REQUIRED", true),
      property(STATE.policyDigest, "StatePolicyDigest", "STRING", "REQUIRED", true),
      property(STATE.armId, "StateArmId", "STRING", "REQUIRED", true),
      property(STATE.contextKey, "StateContextKey", "STRING", "REQUIRED", true),
      property(STATE.exposures, "StateExposures", "NUMBER", "REQUIRED"),
      property(STATE.observations, "StateObservations", "NUMBER", "REQUIRED"),
      property(STATE.conversions, "StateConversions", "NUMBER", "REQUIRED"),
      property(STATE.economicValueSum, "StateEconomicValueSum", "NUMBER", "REQUIRED"),
      property(STATE.rewardSum, "StateRewardSum", "NUMBER", "REQUIRED"),
      property(STATE.rewardSquareSum, "StateRewardSquareSum", "NUMBER", "REQUIRED"),
      property(STATE.createdAt, "StateCreatedAt", "DATETIME", "REQUIRED", true),
      property(STATE.updatedAt, "StateUpdatedAt", "DATETIME", "REQUIRED"),
      property(STATE.digest, "StateDigest", "STRING", "REQUIRED"),
      property(DECISION.experimentId, "DecisionExperimentId", "STRING", "REQUIRED", true),
      property(DECISION.requestId, "DecisionRequestId", "STRING", "REQUIRED", true),
      property(DECISION.armId, "DecisionArmId", "STRING", "REQUIRED", true),
      property(DECISION.contextKey, "DecisionContextKey", "STRING", "REQUIRED", true),
      property(DECISION.contextDigest, "DecisionContextDigest", "STRING", "REQUIRED", true),
      property(DECISION.eligibilityDigest, "DecisionEligibilityDigest", "STRING", "REQUIRED", true),
      property(DECISION.configurationDigest, "DecisionConfigurationDigest", "STRING", "REQUIRED", true),
      property(DECISION.policyDigest, "DecisionPolicyDigest", "STRING", "REQUIRED", true),
      property(DECISION.mode, "DecisionMode", "STRING", "REQUIRED", true),
      property(DECISION.reason, "DecisionReason", "STRING", "REQUIRED", true),
      property(DECISION.issuedAt, "DecisionIssuedAt", "DATETIME", "REQUIRED", true),
      property(DECISION.status, "DecisionStatus", "STRING", "REQUIRED"),
      property(DECISION.evidence, "DecisionEvidence", "JSON", "REQUIRED", true),
      property(DECISION.rewardConfig, "DecisionRewardConfig", "JSON", "REQUIRED", true),
      property(DECISION.maxRewardDelayMs, "DecisionMaxRewardDelayMs", "NUMBER", "REQUIRED", true),
      property(DECISION.converted, "DecisionConverted", "BOOLEAN", "OPTIONAL"),
      property(DECISION.economicValue, "DecisionEconomicValue", "NUMBER", "OPTIONAL"),
      property(DECISION.reward, "DecisionReward", "NUMBER", "OPTIONAL"),
      property(DECISION.outcomeAt, "DecisionOutcomeAt", "DATETIME", "OPTIONAL"),
      property(DECISION.digest, "DecisionDigest", "STRING", "REQUIRED"),
    ],
    interfaces: [],
    objects: [
      {
        id: STATE_TYPE,
        name: "CortexBanditState",
        propertyIds: Object.values(STATE),
        interfaceIds: [],
      },
      {
        id: DECISION_TYPE,
        name: "CortexBanditDecision",
        propertyIds: Object.values(DECISION),
        interfaceIds: [],
      },
    ],
    relationships: [],
    actions: [],
    functions: [],
    events: [],
  };
  return validateSchema(schema);
}

export function createCortexBanditPolicy(input: CreateCortexBanditPolicyInput): CortexBanditPolicy {
  const policyId = normalizeIdentifier(input.policyId, "policyId");
  const version = normalizeIdentifier(input.version, "version");
  const defaultArmId = normalizeIdentifier(input.defaultArmId, "defaultArmId");
  const minimumObservationsPerArm = positiveInteger(input.minimumObservationsPerArm, "minimumObservationsPerArm");
  if (!Number.isFinite(input.confidenceLevel) || input.confidenceLevel <= 0.5 || input.confidenceLevel >= 1) {
    throw new CortexBanditError("INVALID_INPUT", "confidenceLevel must be greater than 0.5 and less than 1");
  }
  if (!Number.isFinite(input.ucbExplorationCoefficient) || input.ucbExplorationCoefficient <= 0) {
    throw new CortexBanditError("INVALID_INPUT", "ucbExplorationCoefficient must be positive");
  }
  const maxArms = positiveInteger(input.maxArms, "maxArms");
  if (maxArms < 2 || maxArms > 64) throw new CortexBanditError("INVALID_INPUT", "maxArms must be between 2 and 64");
  const maxContextFeatures = positiveInteger(input.maxContextFeatures, "maxContextFeatures");
  if (maxContextFeatures > 32) throw new CortexBanditError("INVALID_INPUT", "maxContextFeatures must be at most 32");
  const allowedContextKeys = [...new Set(input.allowedContextKeys.map((key) => normalizeIdentifier(key, "allowedContextKey")))].sort();
  if (allowedContextKeys.length !== input.allowedContextKeys.length) throw new CortexBanditError("INVALID_INPUT", "allowedContextKeys must be unique");
  if (allowedContextKeys.length < 1) throw new CortexBanditError("INVALID_INPUT", "allowedContextKeys must not be empty");
  const maxRewardDelayMs = positiveInteger(input.maxRewardDelayMs, "maxRewardDelayMs");
  const conversionWeight = boundedShare(input.conversionWeight, "conversionWeight");
  const economicValueWeight = boundedShare(input.economicValueWeight, "economicValueWeight");
  if (Math.abs(conversionWeight + economicValueWeight - 1) > 1e-9) {
    throw new CortexBanditError("INVALID_INPUT", "conversionWeight and economicValueWeight must sum to 1");
  }
  if (!Number.isFinite(input.economicValueNormalizationCap) || input.economicValueNormalizationCap <= 0) {
    throw new CortexBanditError("INVALID_INPUT", "economicValueNormalizationCap must be positive");
  }
  const maxWriteRetries = input.maxWriteRetries ?? 3;
  if (!Number.isInteger(maxWriteRetries) || maxWriteRetries < 0 || maxWriteRetries > 10) {
    throw new CortexBanditError("INVALID_INPUT", "maxWriteRetries must be an integer from 0 to 10");
  }
  const mode = input.mode ?? "ACTIVE";
  if (!(["ACTIVE", "FALLBACK_ONLY", "KILLED"] as const).includes(mode)) throw new CortexBanditError("INVALID_INPUT", "mode is invalid");
  const core = {
    policyId,
    version,
    defaultArmId,
    minimumObservationsPerArm,
    confidenceLevel: input.confidenceLevel,
    ucbExplorationCoefficient: input.ucbExplorationCoefficient,
    maxArms,
    maxContextFeatures,
    allowedContextKeys,
    maxRewardDelayMs,
    conversionWeight,
    economicValueWeight,
    economicValueNormalizationCap: input.economicValueNormalizationCap,
    maxWriteRetries,
    mode,
  };
  return Object.freeze({ ...core, allowedContextKeys: Object.freeze(allowedContextKeys), digest: digest("cortex-bandit-policy-v1", core) });
}

function normalizeArm(raw: CortexBanditArmDefinition): CortexBanditArmDefinition {
  const armId = normalizeIdentifier(raw.armId, "armId");
  const minTrafficShare = boundedShare(raw.minTrafficShare, `${armId}.minTrafficShare`);
  const maxTrafficShare = boundedShare(raw.maxTrafficShare, `${armId}.maxTrafficShare`);
  if (minTrafficShare > maxTrafficShare) throw new CortexBanditError("INVALID_INPUT", `${armId} minTrafficShare exceeds maxTrafficShare`);
  if (maxTrafficShare === 0 && minTrafficShare !== 0) throw new CortexBanditError("INVALID_INPUT", `${armId} cannot require traffic when maxTrafficShare is zero`);
  return Object.freeze({ armId, minTrafficShare, maxTrafficShare, payload: clonePayload(raw.payload) });
}

function normalizeContext(context: CortexBanditContext, policy: CortexBanditPolicy) {
  const entries = Object.entries(context);
  if (entries.length > policy.maxContextFeatures) throw new CortexBanditError("POLICY_VIOLATION", "context exceeds maxContextFeatures");
  const allowed = new Set(policy.allowedContextKeys);
  const normalized: Record<string, CortexBanditContextValue> = {};
  for (const [rawKey, rawValue] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    const key = normalizeIdentifier(rawKey, "context key");
    if (!allowed.has(key)) throw new CortexBanditError("POLICY_VIOLATION", `context key ${key} is not allowed`);
    if (typeof rawValue === "string") {
      const value = rawValue.trim();
      if (!value || value.length > 256) throw new CortexBanditError("INVALID_INPUT", `context value ${key} must be 1-256 characters`);
      normalized[key] = value;
    } else if (typeof rawValue === "number") {
      if (!Number.isFinite(rawValue)) throw new CortexBanditError("INVALID_INPUT", `context value ${key} must be finite`);
      normalized[key] = rawValue;
    } else if (typeof rawValue === "boolean") {
      normalized[key] = rawValue;
    } else {
      throw new CortexBanditError("INVALID_INPUT", `context value ${key} has unsupported type`);
    }
  }
  const contextDigest = digest("cortex-bandit-context-v1", normalized);
  return { contextKey: contextDigest, contextDigest };
}

function propertyString(record: ObjectRecord, key: string): string {
  const value = record.properties[key];
  if (typeof value !== "string" || !value) throw new CortexBanditError("INTEGRITY_FAILURE", `record ${record.id} has invalid ${key}`);
  return value;
}

function propertyNumber(record: ObjectRecord, key: string): number {
  const value = record.properties[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new CortexBanditError("INTEGRITY_FAILURE", `record ${record.id} has invalid ${key}`);
  return value;
}

function nullableNumber(record: ObjectRecord, key: string): number | null {
  const value = record.properties[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new CortexBanditError("INTEGRITY_FAILURE", `record ${record.id} has invalid ${key}`);
  return value;
}

function nullableBoolean(record: ObjectRecord, key: string): boolean | null {
  const value = record.properties[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") throw new CortexBanditError("INTEGRITY_FAILURE", `record ${record.id} has invalid ${key}`);
  return value;
}

function nullableString(record: ObjectRecord, key: string): string | null {
  const value = record.properties[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new CortexBanditError("INTEGRITY_FAILURE", `record ${record.id} has invalid ${key}`);
  return value;
}

function propertyJson(record: ObjectRecord, key: string): JsonValue {
  const value = record.properties[key];
  if (!isJsonValue(value)) throw new CortexBanditError("INTEGRITY_FAILURE", `record ${record.id} has invalid ${key}`);
  return value;
}

function requireInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) throw new CortexBanditError("INTEGRITY_FAILURE", `${field} must be a non-negative integer`);
  return value;
}

function stateDigest(input: Omit<StateRecord, "id" | "digest" | "revision">): string {
  return digest("cortex-bandit-state-v1", input);
}

function decisionDigest(input: Omit<DecisionRecord, "id" | "digest" | "revision">): string {
  return digest("cortex-bandit-decision-v1", input);
}

function parseEvidence(value: JsonValue): CortexBanditSelectionEvidence {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new CortexBanditError("INTEGRITY_FAILURE", "decision evidence must be an object");
  const raw = value as Record<string, JsonValue>;
  if (!Array.isArray(raw.arms)) throw new CortexBanditError("INTEGRITY_FAILURE", "decision evidence arms must be an array");
  const numberField = (key: string) => {
    const item = raw[key];
    if (typeof item !== "number" || !Number.isFinite(item)) throw new CortexBanditError("INTEGRITY_FAILURE", `decision evidence ${key} is invalid`);
    return item;
  };
  const winner = raw.confidentWinnerArmId;
  if (!(winner === null || typeof winner === "string")) throw new CortexBanditError("INTEGRITY_FAILURE", "decision evidence winner is invalid");
  const arms = raw.arms.map((item) => {
    if (!item || Array.isArray(item) || typeof item !== "object") throw new CortexBanditError("INTEGRITY_FAILURE", "decision arm evidence is invalid");
    const arm = item as Record<string, JsonValue>;
    const armNumber = (key: string) => {
      const observed = arm[key];
      if (typeof observed !== "number" || !Number.isFinite(observed)) throw new CortexBanditError("INTEGRITY_FAILURE", `decision arm evidence ${key} is invalid`);
      return observed;
    };
    if (typeof arm.armId !== "string") throw new CortexBanditError("INTEGRITY_FAILURE", "decision arm evidence armId is invalid");
    return Object.freeze({
      armId: arm.armId,
      exposures: armNumber("exposures"),
      observations: armNumber("observations"),
      pendingOutcomes: armNumber("pendingOutcomes"),
      conversions: armNumber("conversions"),
      conversionRate: armNumber("conversionRate"),
      trafficShare: armNumber("trafficShare"),
      economicValueSum: armNumber("economicValueSum"),
      revenuePerExposure: armNumber("revenuePerExposure"),
      meanReward: armNumber("meanReward"),
      confidenceLower: armNumber("confidenceLower"),
      confidenceUpper: armNumber("confidenceUpper"),
      ucbScore: armNumber("ucbScore"),
      minTrafficShare: armNumber("minTrafficShare"),
      maxTrafficShare: armNumber("maxTrafficShare"),
    });
  });
  return Object.freeze({
    totalExposures: numberField("totalExposures"),
    totalObservations: numberField("totalObservations"),
    confidenceLevel: numberField("confidenceLevel"),
    minimumObservationsPerArm: numberField("minimumObservationsPerArm"),
    confidentWinnerArmId: winner,
    arms: Object.freeze(arms),
  });
}

function parseRewardConfig(value: JsonValue): RewardConfig {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new CortexBanditError("INTEGRITY_FAILURE", "rewardConfig must be an object");
  const raw = value as Record<string, JsonValue>;
  const get = (key: string) => {
    const item = raw[key];
    if (typeof item !== "number" || !Number.isFinite(item)) throw new CortexBanditError("INTEGRITY_FAILURE", `rewardConfig ${key} is invalid`);
    return item;
  };
  const config = {
    conversionWeight: get("conversionWeight"),
    economicValueWeight: get("economicValueWeight"),
    economicValueNormalizationCap: get("economicValueNormalizationCap"),
  };
  if (config.economicValueNormalizationCap <= 0 || Math.abs(config.conversionWeight + config.economicValueWeight - 1) > 1e-9) {
    throw new CortexBanditError("INTEGRITY_FAILURE", "rewardConfig violates normalization invariants");
  }
  return Object.freeze(config);
}

function projectState(record: ObjectRecord): StateRecord {
  if (record.typeId !== STATE_TYPE) throw new CortexBanditError("INTEGRITY_FAILURE", `record ${record.id} is not a bandit state`);
  const core = {
    experimentId: propertyString(record, STATE.experimentId),
    configurationDigest: propertyString(record, STATE.configurationDigest),
    policyDigest: propertyString(record, STATE.policyDigest),
    armId: propertyString(record, STATE.armId),
    contextKey: propertyString(record, STATE.contextKey),
    exposures: requireInteger(propertyNumber(record, STATE.exposures), "state exposures"),
    observations: requireInteger(propertyNumber(record, STATE.observations), "state observations"),
    conversions: requireInteger(propertyNumber(record, STATE.conversions), "state conversions"),
    economicValueSum: storedFiniteNonNegative(propertyNumber(record, STATE.economicValueSum), "state economicValueSum"),
    rewardSum: storedFiniteNonNegative(propertyNumber(record, STATE.rewardSum), "state rewardSum"),
    rewardSquareSum: storedFiniteNonNegative(propertyNumber(record, STATE.rewardSquareSum), "state rewardSquareSum"),
    createdAt: propertyString(record, STATE.createdAt),
    updatedAt: propertyString(record, STATE.updatedAt),
  };
  assertStoredCanonicalUtc(core.createdAt, "state createdAt");
  assertStoredCanonicalUtc(core.updatedAt, "state updatedAt");
  if (core.observations > core.exposures || core.conversions > core.observations) throw new CortexBanditError("INTEGRITY_FAILURE", "bandit state count invariants are invalid");
  const observedDigest = propertyString(record, STATE.digest);
  const expectedDigest = stateDigest(core);
  if (observedDigest !== expectedDigest) throw new CortexBanditError("INTEGRITY_FAILURE", `bandit state ${record.id} digest mismatch`);
  return Object.freeze({ id: record.id, ...core, digest: observedDigest, revision: record.revision });
}

function projectDecision(record: ObjectRecord): DecisionRecord {
  if (record.typeId !== DECISION_TYPE) throw new CortexBanditError("INTEGRITY_FAILURE", `record ${record.id} is not a bandit decision`);
  const mode = propertyString(record, DECISION.mode) as CortexBanditMode;
  const reason = propertyString(record, DECISION.reason) as CortexBanditDecisionReason;
  const status = propertyString(record, DECISION.status) as CortexBanditDecisionStatus;
  if (!(["ACTIVE", "FALLBACK_ONLY", "KILLED"] as const).includes(mode)) throw new CortexBanditError("INTEGRITY_FAILURE", "decision mode is invalid");
  if (!(["KILL_SWITCH", "ROLLBACK_FALLBACK", "TRAFFIC_FLOOR", "MINIMUM_OBSERVATION", "CONFIDENT_WINNER", "DETERMINISTIC_FALLBACK", "TRAFFIC_CAP_REBALANCE"] as const).includes(reason)) {
    throw new CortexBanditError("INTEGRITY_FAILURE", "decision reason is invalid");
  }
  if (!(["PENDING", "REWARDED"] as const).includes(status)) throw new CortexBanditError("INTEGRITY_FAILURE", "decision status is invalid");
  const evidence = parseEvidence(propertyJson(record, DECISION.evidence));
  const rewardConfig = parseRewardConfig(propertyJson(record, DECISION.rewardConfig));
  const core = {
    experimentId: propertyString(record, DECISION.experimentId),
    requestId: propertyString(record, DECISION.requestId),
    armId: propertyString(record, DECISION.armId),
    contextKey: propertyString(record, DECISION.contextKey),
    contextDigest: propertyString(record, DECISION.contextDigest),
    eligibilityDigest: propertyString(record, DECISION.eligibilityDigest),
    configurationDigest: propertyString(record, DECISION.configurationDigest),
    policyDigest: propertyString(record, DECISION.policyDigest),
    mode,
    reason,
    issuedAt: propertyString(record, DECISION.issuedAt),
    status,
    evidence,
    rewardConfig,
    maxRewardDelayMs: storedPositiveInteger(propertyNumber(record, DECISION.maxRewardDelayMs), "decision maxRewardDelayMs"),
    converted: nullableBoolean(record, DECISION.converted),
    economicValue: nullableNumber(record, DECISION.economicValue),
    reward: nullableNumber(record, DECISION.reward),
    outcomeAt: nullableString(record, DECISION.outcomeAt),
  };
  assertStoredCanonicalUtc(core.issuedAt, "decision issuedAt");
  if (core.outcomeAt !== null) assertStoredCanonicalUtc(core.outcomeAt, "decision outcomeAt");
  if (status === "PENDING" && (core.converted !== null || core.economicValue !== null || core.reward !== null || core.outcomeAt !== null)) {
    throw new CortexBanditError("INTEGRITY_FAILURE", "pending decision contains outcome data");
  }
  if (status === "REWARDED" && (core.converted === null || core.economicValue === null || core.reward === null || core.outcomeAt === null)) {
    throw new CortexBanditError("INTEGRITY_FAILURE", "rewarded decision is missing outcome data");
  }
  if (status === "REWARDED" && (core.economicValue! < 0 || core.reward! < 0 || core.reward! > 1)) {
    throw new CortexBanditError("INTEGRITY_FAILURE", "rewarded decision outcome values violate reward invariants");
  }
  const observedDigest = propertyString(record, DECISION.digest);
  const expectedDigest = decisionDigest(core);
  if (observedDigest !== expectedDigest) throw new CortexBanditError("INTEGRITY_FAILURE", `bandit decision ${record.id} digest mismatch`);
  return Object.freeze({ id: record.id, ...core, digest: observedDigest, revision: record.revision });
}

function stateProperties(input: Omit<StateRecord, "id" | "digest" | "revision">): Readonly<Record<string, JsonValue>> {
  return Object.freeze({
    [STATE.experimentId]: input.experimentId,
    [STATE.configurationDigest]: input.configurationDigest,
    [STATE.policyDigest]: input.policyDigest,
    [STATE.armId]: input.armId,
    [STATE.contextKey]: input.contextKey,
    [STATE.exposures]: input.exposures,
    [STATE.observations]: input.observations,
    [STATE.conversions]: input.conversions,
    [STATE.economicValueSum]: input.economicValueSum,
    [STATE.rewardSum]: input.rewardSum,
    [STATE.rewardSquareSum]: input.rewardSquareSum,
    [STATE.createdAt]: input.createdAt,
    [STATE.updatedAt]: input.updatedAt,
    [STATE.digest]: stateDigest(input),
  });
}

function evidenceJson(evidence: CortexBanditSelectionEvidence): JsonValue {
  return {
    totalExposures: evidence.totalExposures,
    totalObservations: evidence.totalObservations,
    confidenceLevel: evidence.confidenceLevel,
    minimumObservationsPerArm: evidence.minimumObservationsPerArm,
    confidentWinnerArmId: evidence.confidentWinnerArmId,
    arms: evidence.arms.map((arm) => ({ ...arm })),
  };
}

function rewardConfigJson(config: RewardConfig): JsonValue {
  return { ...config };
}

function decisionProperties(input: Omit<DecisionRecord, "id" | "digest" | "revision">): Readonly<Record<string, JsonValue>> {
  return Object.freeze({
    [DECISION.experimentId]: input.experimentId,
    [DECISION.requestId]: input.requestId,
    [DECISION.armId]: input.armId,
    [DECISION.contextKey]: input.contextKey,
    [DECISION.contextDigest]: input.contextDigest,
    [DECISION.eligibilityDigest]: input.eligibilityDigest,
    [DECISION.configurationDigest]: input.configurationDigest,
    [DECISION.policyDigest]: input.policyDigest,
    [DECISION.mode]: input.mode,
    [DECISION.reason]: input.reason,
    [DECISION.issuedAt]: input.issuedAt,
    [DECISION.status]: input.status,
    [DECISION.evidence]: evidenceJson(input.evidence),
    [DECISION.rewardConfig]: rewardConfigJson(input.rewardConfig),
    [DECISION.maxRewardDelayMs]: input.maxRewardDelayMs,
    [DECISION.converted]: input.converted,
    [DECISION.economicValue]: input.economicValue,
    [DECISION.reward]: input.reward,
    [DECISION.outcomeAt]: input.outcomeAt,
    [DECISION.digest]: decisionDigest(input),
  });
}

function confidenceRadius(observations: number, confidenceLevel: number): number {
  if (observations <= 0) return 1;
  const alpha = 1 - confidenceLevel;
  return Math.sqrt(Math.log(2 / alpha) / (2 * observations));
}

function effectiveMode(policyMode: CortexBanditMode, requestMode: CortexBanditMode | undefined): CortexBanditMode {
  const rank: Record<CortexBanditMode, number> = { ACTIVE: 0, FALLBACK_ONLY: 1, KILLED: 2 };
  const requested = requestMode ?? "ACTIVE";
  if (!(requested in rank)) throw new CortexBanditError("INVALID_INPUT", "request mode is invalid");
  return rank[requested] > rank[policyMode] ? requested : policyMode;
}

function calculateReward(converted: boolean, economicValue: number, config: RewardConfig): number {
  const normalizedValue = Math.min(1, economicValue / config.economicValueNormalizationCap);
  return config.conversionWeight * (converted ? 1 : 0) + config.economicValueWeight * normalizedValue;
}

function isConflict(error: unknown): boolean {
  return error instanceof OntologyTransactionError && error.code === "CONFLICT";
}

function assertEligibleTrafficEnvelope(arms: readonly CortexBanditArmDefinition[]): void {
  const sumMin = arms.reduce((sum, arm) => sum + arm.minTrafficShare, 0);
  const sumMax = arms.reduce((sum, arm) => sum + arm.maxTrafficShare, 0);
  if (sumMin > 1 + EPSILON) {
    throw new CortexBanditError("POLICY_VIOLATION", "eligible-arm minimum traffic shares exceed 100 percent");
  }
  if (sumMax < 1 - EPSILON) {
    throw new CortexBanditError("POLICY_VIOLATION", "eligible-arm maximum traffic shares cannot cover 100 percent of assignments");
  }
}

export class ServerSideContextualBanditEngine {
  readonly experimentId: string;
  readonly policy: CortexBanditPolicy;
  readonly configurationDigest: string;
  readonly schema: ValidatedSchema;
  private readonly arms = new Map<string, CortexBanditArmDefinition>();

  constructor(
    private readonly transactions: OntologyTransactionPort,
    readonly scope: OntologyScope,
    experimentId: string,
    policy: CortexBanditPolicy,
    armDefinitions: readonly CortexBanditArmDefinition[],
    private readonly now: () => number = Date.now,
  ) {
    this.experimentId = normalizeIdentifier(experimentId, "experimentId");
    this.policy = policy;
    if (armDefinitions.length < 2) throw new CortexBanditError("INVALID_INPUT", "bandit experiment requires at least two arms");
    if (armDefinitions.length > policy.maxArms) throw new CortexBanditError("POLICY_VIOLATION", "arm count exceeds policy maxArms");
    for (const raw of armDefinitions) {
      const arm = normalizeArm(raw);
      if (this.arms.has(arm.armId)) throw new CortexBanditError("INVALID_INPUT", `duplicate arm ${arm.armId}`);
      this.arms.set(arm.armId, arm);
    }
    if (!this.arms.has(policy.defaultArmId)) throw new CortexBanditError("INVALID_INPUT", "defaultArmId must reference a registered arm");
    const allArms = [...this.arms.values()];
    const sumMin = allArms.reduce((sum, arm) => sum + arm.minTrafficShare, 0);
    const sumMax = allArms.reduce((sum, arm) => sum + arm.maxTrafficShare, 0);
    if (sumMin > 1 + EPSILON) throw new CortexBanditError("INVALID_INPUT", "sum of minTrafficShare cannot exceed 1");
    if (sumMax < 1 - EPSILON) throw new CortexBanditError("INVALID_INPUT", "sum of maxTrafficShare must be at least 1");
    const armConfig = allArms
      .sort((a, b) => a.armId.localeCompare(b.armId))
      .map((arm) => ({ armId: arm.armId, payload: arm.payload, minTrafficShare: arm.minTrafficShare, maxTrafficShare: arm.maxTrafficShare }));
    this.configurationDigest = digest("cortex-bandit-configuration-v1", {
      experimentId: this.experimentId,
      policyDigest: policy.digest,
      arms: armConfig,
    });
    this.schema = cortexBanditSchema(scope);
  }

  private currentTime(): { readonly ms: number; readonly iso: string } {
    const ms = this.now();
    if (!Number.isFinite(ms)) throw new CortexBanditError("INTEGRITY_FAILURE", "engine clock is invalid");
    return { ms, iso: new Date(ms).toISOString() };
  }

  private stateId(configurationDigest: string, armId: string, contextKey: string): string {
    return ontologyId("cortex-bandit-state", { scope: this.scope, experimentId: this.experimentId, configurationDigest, armId, contextKey });
  }

  private decisionId(requestId: string): string {
    return ontologyId("cortex-bandit-decision", { scope: this.scope, experimentId: this.experimentId, requestId });
  }

  private readState(configurationDigest: string, armId: string, contextKey: string): StateRecord | undefined {
    const raw = this.transactions.getObject(this.scope, this.stateId(configurationDigest, armId, contextKey));
    return raw ? projectState(raw) : undefined;
  }

  private armEvidence(eligible: readonly CortexBanditArmDefinition[], contextKey: string): CortexBanditSelectionEvidence {
    const rawRows = eligible.map((arm) => ({ arm, state: this.readState(this.configurationDigest, arm.armId, contextKey) }));
    const totalExposures = rawRows.reduce((sum, row) => sum + (row.state?.exposures ?? 0), 0);
    const totalObservations = rawRows.reduce((sum, row) => sum + (row.state?.observations ?? 0), 0);
    const rows = rawRows.map(({ arm, state }) => {
      const exposures = state?.exposures ?? 0;
      const observations = state?.observations ?? 0;
      const conversions = state?.conversions ?? 0;
      const economicValueSum = state?.economicValueSum ?? 0;
      const rewardSum = state?.rewardSum ?? 0;
      const meanReward = observations === 0 ? 0 : rewardSum / observations;
      const radius = confidenceRadius(observations, this.policy.confidenceLevel);
      const confidenceLower = Math.max(0, meanReward - radius);
      const confidenceUpper = Math.min(1, meanReward + radius);
      const explorationBonus = observations === 0
        ? 1_000_000
        : this.policy.ucbExplorationCoefficient * Math.sqrt(Math.log(Math.max(2, totalObservations + 1)) / observations);
      const ucbScore = observations === 0 ? explorationBonus : meanReward + explorationBonus;
      return Object.freeze({
        armId: arm.armId,
        exposures,
        observations,
        pendingOutcomes: exposures - observations,
        conversions,
        conversionRate: observations === 0 ? 0 : conversions / observations,
        trafficShare: totalExposures === 0 ? 0 : exposures / totalExposures,
        economicValueSum,
        revenuePerExposure: exposures === 0 ? 0 : economicValueSum / exposures,
        meanReward,
        confidenceLower,
        confidenceUpper,
        ucbScore,
        minTrafficShare: arm.minTrafficShare,
        maxTrafficShare: arm.maxTrafficShare,
      } satisfies CortexBanditArmEvidence);
    });
    let confidentWinnerArmId: string | null = null;
    if (rows.every((row) => row.observations >= this.policy.minimumObservationsPerArm)) {
      const ranked = [...rows].sort((a, b) => b.meanReward - a.meanReward || a.armId.localeCompare(b.armId));
      const best = ranked[0];
      const competitorUpper = Math.max(...ranked.slice(1).map((row) => row.confidenceUpper));
      if (best && best.confidenceLower > competitorUpper) confidentWinnerArmId = best.armId;
    }
    return Object.freeze({
      totalExposures,
      totalObservations,
      confidenceLevel: this.policy.confidenceLevel,
      minimumObservationsPerArm: this.policy.minimumObservationsPerArm,
      confidentWinnerArmId,
      arms: Object.freeze(rows.sort((a, b) => a.armId.localeCompare(b.armId))),
    });
  }

  private selectArm(
    evidence: CortexBanditSelectionEvidence,
    eligibleArms: readonly CortexBanditArmDefinition[],
    mode: CortexBanditMode,
  ): { readonly arm: CortexBanditArmDefinition; readonly reason: CortexBanditDecisionReason } {
    const defaultArm = this.arms.get(this.policy.defaultArmId)!;
    if (mode === "KILLED") return { arm: defaultArm, reason: "KILL_SWITCH" };
    if (mode === "FALLBACK_ONLY") return { arm: defaultArm, reason: "ROLLBACK_FALLBACK" };

    const byId = new Map(evidence.arms.map((row) => [row.armId, row]));
    const nextTotal = evidence.totalExposures + 1;
    const allowed = eligibleArms.filter((arm) => {
      const row = byId.get(arm.armId)!;
      const quota = Math.ceil(arm.maxTrafficShare * nextTotal - EPSILON);
      return row.exposures + 1 <= quota;
    });
    if (allowed.length === 0) throw new CortexBanditError("POLICY_VIOLATION", "traffic ceilings leave no eligible arm for the next assignment");

    const floorCandidates = allowed
      .map((arm) => {
        const row = byId.get(arm.armId)!;
        const target = Math.floor(arm.minTrafficShare * nextTotal + EPSILON);
        return { arm, row, deficit: target - row.exposures };
      })
      .filter((item) => item.deficit > 0)
      .sort((a, b) => b.deficit - a.deficit || a.row.observations - b.row.observations || a.arm.armId.localeCompare(b.arm.armId));
    if (floorCandidates[0]) return { arm: floorCandidates[0].arm, reason: "TRAFFIC_FLOOR" };

    const underObserved = allowed
      .filter((arm) => byId.get(arm.armId)!.observations < this.policy.minimumObservationsPerArm)
      .sort((a, b) => {
        const left = byId.get(a.armId)!;
        const right = byId.get(b.armId)!;
        return left.observations - right.observations || left.exposures - right.exposures || right.ucbScore - left.ucbScore || a.armId.localeCompare(b.armId);
      });
    if (underObserved[0]) return { arm: underObserved[0], reason: "MINIMUM_OBSERVATION" };

    if (evidence.confidentWinnerArmId) {
      const winner = allowed.find((arm) => arm.armId === evidence.confidentWinnerArmId);
      if (winner) return { arm: winner, reason: "CONFIDENT_WINNER" };
    } else {
      const fallback = allowed.find((arm) => arm.armId === this.policy.defaultArmId);
      if (fallback) return { arm: fallback, reason: "DETERMINISTIC_FALLBACK" };
    }

    const ranked = [...allowed].sort((a, b) => {
      const left = byId.get(a.armId)!;
      const right = byId.get(b.armId)!;
      return right.ucbScore - left.ucbScore || left.exposures - right.exposures || a.armId.localeCompare(b.armId);
    });
    return { arm: ranked[0]!, reason: "TRAFFIC_CAP_REBALANCE" };
  }

  private publicDecision(record: DecisionRecord): CortexBanditDecision {
    const arm = this.arms.get(record.armId);
    if (!arm) throw new CortexBanditError("INTEGRITY_FAILURE", `decision references unknown arm ${record.armId}`);
    return Object.freeze({
      decisionId: record.id,
      experimentId: record.experimentId,
      requestId: record.requestId,
      armId: record.armId,
      payload: arm.payload,
      contextKey: record.contextKey,
      contextDigest: record.contextDigest,
      eligibilityDigest: record.eligibilityDigest,
      configurationDigest: record.configurationDigest,
      policyDigest: record.policyDigest,
      mode: record.mode,
      reason: record.reason,
      issuedAt: record.issuedAt,
      status: record.status,
      evidence: record.evidence,
      converted: record.converted,
      economicValue: record.economicValue,
      reward: record.reward,
      outcomeAt: record.outcomeAt,
      digest: record.digest,
    });
  }

  select(request: CortexBanditSelectionRequest): CortexBanditDecision {
    const requestId = normalizeIdentifier(request.requestId, "requestId");
    const { contextKey, contextDigest } = normalizeContext(request.context, this.policy);
    const eligibleIds = [...new Set(request.eligibleArmIds.map((id) => normalizeIdentifier(id, "eligibleArmId")))].sort();
    if (eligibleIds.length !== request.eligibleArmIds.length) throw new CortexBanditError("INVALID_INPUT", "eligibleArmIds must be unique");
    if (eligibleIds.length < 2) throw new CortexBanditError("INVALID_INPUT", "at least two eligible arms are required for experimentation");
    if (!eligibleIds.includes(this.policy.defaultArmId)) throw new CortexBanditError("POLICY_VIOLATION", "eligibleArmIds must include the default arm");
    const eligibleArms = eligibleIds.map((armId) => {
      const arm = this.arms.get(armId);
      if (!arm) throw new CortexBanditError("POLICY_VIOLATION", `eligible arm ${armId} is not registered`);
      return arm;
    });
    const eligibilityDigest = digest("cortex-bandit-eligibility-v1", eligibleIds);
    const mode = effectiveMode(this.policy.mode, request.mode);
    if (mode === "ACTIVE") assertEligibleTrafficEnvelope(eligibleArms);
    const id = this.decisionId(requestId);

    for (let attempt = 0; attempt <= this.policy.maxWriteRetries; attempt += 1) {
      const existingRaw = this.transactions.getObject(this.scope, id);
      if (existingRaw) {
        const existing = projectDecision(existingRaw);
        if (existing.experimentId !== this.experimentId || existing.contextDigest !== contextDigest || existing.eligibilityDigest !== eligibilityDigest) {
          throw new CortexBanditError("CONFLICT", "requestId cannot be reused with different experiment context or eligible arms");
        }
        if (existing.configurationDigest !== this.configurationDigest) {
          throw new CortexBanditError("CONFLICT", "requestId was already assigned under a different experiment configuration");
        }
        return this.publicDecision(existing);
      }

      const evidence = this.armEvidence(eligibleArms, contextKey);
      const selection = this.selectArm(evidence, eligibleArms, mode);
      const { iso: issuedAt } = this.currentTime();
      const selectedState = this.readState(this.configurationDigest, selection.arm.armId, contextKey);
      const nextStateCore = {
        experimentId: this.experimentId,
        configurationDigest: this.configurationDigest,
        policyDigest: this.policy.digest,
        armId: selection.arm.armId,
        contextKey,
        exposures: (selectedState?.exposures ?? 0) + 1,
        observations: selectedState?.observations ?? 0,
        conversions: selectedState?.conversions ?? 0,
        economicValueSum: selectedState?.economicValueSum ?? 0,
        rewardSum: selectedState?.rewardSum ?? 0,
        rewardSquareSum: selectedState?.rewardSquareSum ?? 0,
        createdAt: selectedState?.createdAt ?? issuedAt,
        updatedAt: issuedAt,
      };
      const rewardConfig = Object.freeze({
        conversionWeight: this.policy.conversionWeight,
        economicValueWeight: this.policy.economicValueWeight,
        economicValueNormalizationCap: this.policy.economicValueNormalizationCap,
      });
      const decisionCore = {
        experimentId: this.experimentId,
        requestId,
        armId: selection.arm.armId,
        contextKey,
        contextDigest,
        eligibilityDigest,
        configurationDigest: this.configurationDigest,
        policyDigest: this.policy.digest,
        mode,
        reason: selection.reason,
        issuedAt,
        status: "PENDING" as const,
        evidence,
        rewardConfig,
        maxRewardDelayMs: this.policy.maxRewardDelayMs,
        converted: null,
        economicValue: null,
        reward: null,
        outcomeAt: null,
      };
      const operations: TransactionOperation[] = [
        {
          kind: "CREATE_OBJECT",
          record: {
            id,
            typeId: DECISION_TYPE,
            scope: this.scope,
            properties: decisionProperties(decisionCore),
          },
        },
        selectedState
          ? {
              kind: "UPDATE_OBJECT",
              id: selectedState.id,
              expectedRevision: selectedState.revision,
              properties: stateProperties(nextStateCore),
            }
          : {
              kind: "CREATE_OBJECT",
              record: {
                id: this.stateId(this.configurationDigest, selection.arm.armId, contextKey),
                typeId: STATE_TYPE,
                scope: this.scope,
                properties: stateProperties(nextStateCore),
              },
            },
      ];
      try {
        this.transactions.transact(this.scope, this.schema, operations);
        const stored = this.transactions.getObject(this.scope, id);
        if (!stored) throw new CortexBanditError("PERSISTENCE_FAILURE", "decision was not readable after commit");
        return this.publicDecision(projectDecision(stored));
      } catch (error) {
        if (isConflict(error) && attempt < this.policy.maxWriteRetries) continue;
        if (isConflict(error)) throw new CortexBanditError("CONFLICT", "bandit assignment conflicted after configured retries");
        if (error instanceof CortexBanditError) throw error;
        throw new CortexBanditError("PERSISTENCE_FAILURE", error instanceof Error ? error.message : "bandit assignment persistence failed");
      }
    }
    throw new CortexBanditError("CONFLICT", "bandit assignment exhausted retries");
  }

  recordOutcome(input: CortexBanditOutcomeInput): CortexBanditDecision {
    const decisionId = normalizeIdentifier(input.decisionId, "decisionId");
    if (typeof input.converted !== "boolean") throw new CortexBanditError("INVALID_INPUT", "converted must be boolean");
    const economicValue = finiteNonNegative(input.economicValue, "economicValue");
    const outcomeAt = assertCanonicalUtc(input.outcomeAt, "outcomeAt");

    for (let attempt = 0; attempt <= this.policy.maxWriteRetries; attempt += 1) {
      const raw = this.transactions.getObject(this.scope, decisionId);
      if (!raw) throw new CortexBanditError("NOT_FOUND", "bandit decision does not exist");
      const decision = projectDecision(raw);
      if (decision.experimentId !== this.experimentId) throw new CortexBanditError("CONFLICT", "decision belongs to another experiment");
      if (decision.status === "REWARDED") {
        if (decision.converted === input.converted && decision.economicValue === economicValue && decision.outcomeAt === outcomeAt) {
          return this.publicDecision(decision);
        }
        throw new CortexBanditError("CONFLICT", "decision was already rewarded with a different outcome");
      }
      const issuedMs = Date.parse(decision.issuedAt);
      const outcomeMs = Date.parse(outcomeAt);
      const nowMs = this.currentTime().ms;
      if (outcomeMs > nowMs) throw new CortexBanditError("INVALID_INPUT", "outcomeAt cannot be in the future");
      if (outcomeMs < issuedMs) throw new CortexBanditError("INVALID_INPUT", "outcomeAt cannot precede assignment");
      if (outcomeMs - issuedMs > decision.maxRewardDelayMs) throw new CortexBanditError("REWARD_EXPIRED", "outcome arrived after the assignment attribution window");
      const stateId = this.stateId(decision.configurationDigest, decision.armId, decision.contextKey);
      const stateRaw = this.transactions.getObject(this.scope, stateId);
      if (!stateRaw) throw new CortexBanditError("INTEGRITY_FAILURE", "assignment state is missing");
      const state = projectState(stateRaw);
      if (state.exposures <= state.observations) throw new CortexBanditError("INTEGRITY_FAILURE", "assignment state has no pending exposure for this outcome");
      const reward = calculateReward(input.converted, economicValue, decision.rewardConfig);
      const nextStateCore = {
        experimentId: state.experimentId,
        configurationDigest: state.configurationDigest,
        policyDigest: state.policyDigest,
        armId: state.armId,
        contextKey: state.contextKey,
        exposures: state.exposures,
        observations: state.observations + 1,
        conversions: state.conversions + (input.converted ? 1 : 0),
        economicValueSum: state.economicValueSum + economicValue,
        rewardSum: state.rewardSum + reward,
        rewardSquareSum: state.rewardSquareSum + reward * reward,
        createdAt: state.createdAt,
        updatedAt: outcomeAt,
      };
      const nextDecisionCore = {
        experimentId: decision.experimentId,
        requestId: decision.requestId,
        armId: decision.armId,
        contextKey: decision.contextKey,
        contextDigest: decision.contextDigest,
        eligibilityDigest: decision.eligibilityDigest,
        configurationDigest: decision.configurationDigest,
        policyDigest: decision.policyDigest,
        mode: decision.mode,
        reason: decision.reason,
        issuedAt: decision.issuedAt,
        status: "REWARDED" as const,
        evidence: decision.evidence,
        rewardConfig: decision.rewardConfig,
        maxRewardDelayMs: decision.maxRewardDelayMs,
        converted: input.converted,
        economicValue,
        reward,
        outcomeAt,
      };
      const operations: TransactionOperation[] = [
        {
          kind: "UPDATE_OBJECT",
          id: state.id,
          expectedRevision: state.revision,
          properties: stateProperties(nextStateCore),
        },
        {
          kind: "UPDATE_OBJECT",
          id: decision.id,
          expectedRevision: decision.revision,
          properties: decisionProperties(nextDecisionCore),
        },
      ];
      try {
        this.transactions.transact(this.scope, this.schema, operations);
        const stored = this.transactions.getObject(this.scope, decision.id);
        if (!stored) throw new CortexBanditError("PERSISTENCE_FAILURE", "rewarded decision was not readable after commit");
        return this.publicDecision(projectDecision(stored));
      } catch (error) {
        if (isConflict(error) && attempt < this.policy.maxWriteRetries) continue;
        if (isConflict(error)) throw new CortexBanditError("CONFLICT", "bandit outcome conflicted after configured retries");
        if (error instanceof CortexBanditError) throw error;
        throw new CortexBanditError("PERSISTENCE_FAILURE", error instanceof Error ? error.message : "bandit outcome persistence failed");
      }
    }
    throw new CortexBanditError("CONFLICT", "bandit outcome exhausted retries");
  }

  auditSnapshot(context: CortexBanditContext, eligibleArmIds: readonly string[]): CortexBanditAuditSnapshot {
    const { contextKey, contextDigest } = normalizeContext(context, this.policy);
    const ids = [...new Set(eligibleArmIds.map((id) => normalizeIdentifier(id, "eligibleArmId")))].sort();
    if (ids.length !== eligibleArmIds.length || ids.length < 2) throw new CortexBanditError("INVALID_INPUT", "audit requires at least two unique eligible arms");
    const arms = ids.map((armId) => {
      const arm = this.arms.get(armId);
      if (!arm) throw new CortexBanditError("POLICY_VIOLATION", `eligible arm ${armId} is not registered`);
      return arm;
    });
    const evidence = this.armEvidence(arms, contextKey);
    const generatedAt = this.currentTime().iso;
    const core = {
      experimentId: this.experimentId,
      contextKey,
      contextDigest,
      configurationDigest: this.configurationDigest,
      policyDigest: this.policy.digest,
      generatedAt,
      evidence,
    };
    return Object.freeze({ ...core, digest: digest("cortex-bandit-audit-v1", core) });
  }
}
