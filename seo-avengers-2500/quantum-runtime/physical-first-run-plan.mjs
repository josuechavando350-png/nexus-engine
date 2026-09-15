import {
  canonicalQuantumSha256,
  exactKeys,
  freeze,
  integer,
  text,
  TOKEN_RE,
} from "./common.mjs";

const ENGINE_ID = "WALLE_PHYSICAL_QPU_FIRST_RUN_PLAN_V1";
const PREPARATION_RECORD_ENGINE_ID = "WALLE_PHYSICAL_QPU_PREPARATION_RECORD_V1";
const PROVIDER = "IBM_QUANTUM_COMPUTE";
const IBM_ADAPTER_ID = "NEXUS_IBM_QUANTUM_COMPUTE_QPU_ADAPTER_V1";
const PREPARE_ONLY = "PREPARE_ONLY";
const EXECUTE_PHYSICAL_QPU = "EXECUTE_PHYSICAL_QPU";
const MAX_TRANSPILER_SEED = 2_147_483_647;
const MAX_RUNS = 256;
const MIN_REPEATED_RUNS = 5;
const MAX_SHOTS = 10_000_000;
const MIN_BRIDGE_TIMEOUT_MILLIS = 1_000;
const MAX_BRIDGE_TIMEOUT_MILLIS = 86_400_000;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const NON_PHYSICAL_BACKEND_RE = /(simulator|statevector|mock|fake|fixture|test-only|test_provider|emulator)/i;

const PHASES = Object.freeze([
  "PREPARE_ONLY",
  "SINGLE_PHYSICAL_SMOKE",
  "VALIDATE_SMOKE_RECEIPT",
  "REPEATED_PHYSICAL_SERIES",
  "CLASSICAL_BASELINE_COMPARISON",
]);

const EVIDENCE_REQUIREMENTS = Object.freeze([
  "PHYSICAL_PROVIDER_AND_BACKEND_IDENTITY",
  "UNIQUE_PROVIDER_JOB_ID",
  "PROVIDER_TIMESTAMPS_WHEN_EXPOSED",
  "REQUESTED_AND_COMPLETED_SHOTS",
  "PROBLEM_AND_OPTIMIZATION_HASH_BINDINGS",
  "LOGICAL_AND_ISA_TRANSPILED_CIRCUIT_HASHES",
  "LOGICAL_AND_TRANSPILED_QASM_ARTIFACTS_WHEN_AVAILABLE",
  "MEASUREMENT_COUNTS_MATCH_COMPLETED_SHOTS",
  "TOPOLOGY_AND_CAPABILITIES_HASHES",
  "CALIBRATION_CAPTURE_OR_PROVIDER_NOT_EXPOSED",
  "RAW_RESULT_AND_PROVIDER_RECEIPT_HASHES",
  "ADAPTER_SDK_COMPILER_AND_TRANSPILER_SEED_METADATA",
  "IMMUTABLE_HASH_VERIFIABLE_EVIDENCE_BUNDLE",
  "SAME_PROBLEM_CLASSICAL_BASELINE_COMPARISON",
]);

const ABORT_CONDITIONS = Object.freeze([
  "CREDENTIALS_OR_PROVIDER_CONFIGURATION_INCOMPLETE",
  "BACKEND_NOT_ACCESSIBLE_OR_NOT_PHYSICAL",
  "PROVIDER_JOB_ID_MISSING_OR_DUPLICATED",
  "PROVIDER_EXECUTION_NOT_TESTED_OR_FAILED",
  "SHOT_OR_MEASUREMENT_COUNT_MISMATCH",
  "PROBLEM_CIRCUIT_OR_ARTIFACT_DIGEST_MISMATCH",
  "TRANSPILED_ISA_CIRCUIT_NOT_CAPTURED",
  "TRANSPILER_SEED_MISSING_OR_DRIFTED",
  "COMPILER_IDENTITY_OR_VERSION_DRIFTED",
  "TOPOLOGY_OR_CAPABILITIES_DRIFTED",
  "PROVIDER_RECEIPT_OR_RAW_RESULT_HASH_MISSING",
  "LOCAL_BRIDGE_TIMEOUT_REQUIRES_PROVIDER_JOB_RECONCILIATION_BEFORE_RETRY",
  "SECRET_DETECTED_IN_LOG_OR_EVIDENCE",
  "EXACT_HEAD_CI_NOT_GREEN",
  "PROVIDER_COST_OR_ENTITLEMENT_NOT_CONFIRMED",
]);

function gitSha(value, label) {
  const normalized = text(value, label, { maxBytes: 40 });
  if (!GIT_SHA_RE.test(normalized)) throw new Error(`${label} must be 40 lowercase hex`);
  return normalized;
}

function backendName(value) {
  const normalized = text(value, "physical backendName", { pattern: TOKEN_RE, maxBytes: 256 });
  if (NON_PHYSICAL_BACKEND_RE.test(normalized)) throw new Error("physical backendName identifies a simulator/fake/test backend");
  return normalized;
}

function hasControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if ((codePoint >= 0 && codePoint <= 31) || codePoint === 127) return true;
  }
  return false;
}

function evidenceRoot(value) {
  const normalized = text(value, "physical evidenceRoot", { maxBytes: 2_048 });
  if (hasControlCharacter(normalized)) throw new Error("physical evidenceRoot contains control characters");
  return normalized;
}

function assertExactArray(actual, expected, label) {
  if (!Array.isArray(actual) || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} contract mismatch`);
  }
}

export function validatePhysicalQpuFirstRunPlan(plan) {
  exactKeys(plan, [
    "abortConditions",
    "backendName",
    "engineId",
    "evidenceRequirements",
    "evidenceRoot",
    "executionInterlock",
    "interpretation",
    "limits",
    "phases",
    "planSha256",
    "provider",
    "providerCostControl",
    "quantumAdvantageClaimAllowed",
    "repeatedSeries",
    "schemaVersion",
    "smokeJob",
    "sourceRevision",
    "sourceTree",
    "transpilerSeed",
  ], "physical QPU first-run plan");

  if (plan.schemaVersion !== 1 || plan.engineId !== ENGINE_ID || plan.provider !== PROVIDER) {
    throw new Error("unsupported physical QPU first-run plan");
  }
  gitSha(plan.sourceRevision, "physical plan sourceRevision");
  gitSha(plan.sourceTree, "physical plan sourceTree");
  backendName(plan.backendName);
  evidenceRoot(plan.evidenceRoot);
  integer(plan.transpilerSeed, "physical plan transpilerSeed", 0, MAX_TRANSPILER_SEED);

  exactKeys(plan.executionInterlock, ["liveExecutionAuthorization", "prepareOnlyAuthorization"], "physical plan executionInterlock");
  if (plan.executionInterlock.prepareOnlyAuthorization !== PREPARE_ONLY
    || plan.executionInterlock.liveExecutionAuthorization !== EXECUTE_PHYSICAL_QPU) {
    throw new Error("physical plan execution interlock mismatch");
  }

  exactKeys(plan.smokeJob, ["runCount", "shots"], "physical plan smokeJob");
  if (plan.smokeJob.runCount !== 1) throw new Error("physical smoke runCount must be exactly 1");
  integer(plan.smokeJob.shots, "physical smoke shots", 1, MAX_SHOTS);

  exactKeys(plan.repeatedSeries, ["minimumCompletedRuns", "runCount", "shots"], "physical plan repeatedSeries");
  const repeatedRunCount = integer(plan.repeatedSeries.runCount, "physical repeated runCount", MIN_REPEATED_RUNS, MAX_RUNS);
  if (plan.repeatedSeries.minimumCompletedRuns !== repeatedRunCount) {
    throw new Error("physical repeated minimumCompletedRuns must equal runCount");
  }
  integer(plan.repeatedSeries.shots, "physical repeated shots", 1, MAX_SHOTS);

  exactKeys(plan.limits, ["bridgeTimeoutMillis", "maximumLocalBridgeWaitMillis", "maximumProviderJobs", "maximumTotalShots"], "physical plan limits");
  const bridgeTimeoutMillis = integer(
    plan.limits.bridgeTimeoutMillis,
    "physical local bridge timeout",
    MIN_BRIDGE_TIMEOUT_MILLIS,
    MAX_BRIDGE_TIMEOUT_MILLIS,
  );
  const expectedJobs = 1 + repeatedRunCount;
  const expectedShots = plan.smokeJob.shots + (plan.repeatedSeries.shots * repeatedRunCount);
  const expectedLocalWait = bridgeTimeoutMillis * expectedJobs;
  if (plan.limits.maximumProviderJobs !== expectedJobs
    || plan.limits.maximumTotalShots !== expectedShots
    || plan.limits.maximumLocalBridgeWaitMillis !== expectedLocalWait) {
    throw new Error("physical plan derived execution limits mismatch");
  }

  exactKeys(plan.providerCostControl, [
    "billingApiIntegrated",
    "liveExecutionRequiresExternalConfirmation",
    "policy",
  ], "physical plan providerCostControl");
  if (plan.providerCostControl.billingApiIntegrated !== false
    || plan.providerCostControl.liveExecutionRequiresExternalConfirmation !== true
    || plan.providerCostControl.policy !== "NO_LIVE_RUN_UNTIL_PROVIDER_COST_OR_ENTITLEMENT_CONFIRMED") {
    throw new Error("physical provider cost-control contract mismatch");
  }

  assertExactArray(plan.phases, PHASES, "physical plan phases");
  assertExactArray(plan.evidenceRequirements, EVIDENCE_REQUIREMENTS, "physical plan evidence requirements");
  assertExactArray(plan.abortConditions, ABORT_CONDITIONS, "physical plan abort conditions");
  if (plan.quantumAdvantageClaimAllowed !== false
    || plan.interpretation !== "PREPARATION_PLAN_ONLY_NOT_PHYSICAL_HARDWARE_EVIDENCE_OR_QUANTUM_ADVANTAGE") {
    throw new Error("physical plan interpretation boundary mismatch");
  }

  const { planSha256, ...unsigned } = plan;
  if (planSha256 !== canonicalQuantumSha256(unsigned)) throw new Error("physical QPU first-run plan digest mismatch");
  return freeze(plan);
}

export function buildPhysicalQpuFirstRunPlan(input) {
  exactKeys(input, [
    "backendName",
    "bridgeTimeoutMillis",
    "evidenceRoot",
    "repeatedRunCount",
    "repeatedShots",
    "smokeShots",
    "sourceRevision",
    "sourceTree",
    "transpilerSeed",
  ], "physical QPU first-run plan input");

  const normalizedBackendName = backendName(input.backendName);
  const normalizedEvidenceRoot = evidenceRoot(input.evidenceRoot);
  const sourceRevision = gitSha(input.sourceRevision, "physical plan sourceRevision");
  const sourceTree = gitSha(input.sourceTree, "physical plan sourceTree");
  const transpilerSeed = integer(input.transpilerSeed, "physical plan transpilerSeed", 0, MAX_TRANSPILER_SEED);
  const smokeShots = integer(input.smokeShots, "physical smoke shots", 1, MAX_SHOTS);
  const repeatedShots = integer(input.repeatedShots, "physical repeated shots", 1, MAX_SHOTS);
  const repeatedRunCount = integer(input.repeatedRunCount, "physical repeated runCount", MIN_REPEATED_RUNS, MAX_RUNS);
  const bridgeTimeoutMillis = integer(
    input.bridgeTimeoutMillis,
    "physical local bridge timeout",
    MIN_BRIDGE_TIMEOUT_MILLIS,
    MAX_BRIDGE_TIMEOUT_MILLIS,
  );

  const maximumProviderJobs = 1 + repeatedRunCount;
  const maximumTotalShots = smokeShots + (repeatedShots * repeatedRunCount);
  const maximumLocalBridgeWaitMillis = bridgeTimeoutMillis * maximumProviderJobs;
  if (!Number.isSafeInteger(maximumTotalShots) || !Number.isSafeInteger(maximumLocalBridgeWaitMillis)) {
    throw new Error("physical plan derived limits exceed safe integer range");
  }

  const unsigned = {
    schemaVersion: 1,
    engineId: ENGINE_ID,
    sourceRevision,
    sourceTree,
    provider: PROVIDER,
    backendName: normalizedBackendName,
    transpilerSeed,
    evidenceRoot: normalizedEvidenceRoot,
    executionInterlock: {
      prepareOnlyAuthorization: PREPARE_ONLY,
      liveExecutionAuthorization: EXECUTE_PHYSICAL_QPU,
    },
    phases: [...PHASES],
    smokeJob: { runCount: 1, shots: smokeShots },
    repeatedSeries: {
      runCount: repeatedRunCount,
      minimumCompletedRuns: repeatedRunCount,
      shots: repeatedShots,
    },
    limits: {
      maximumProviderJobs,
      maximumTotalShots,
      bridgeTimeoutMillis,
      maximumLocalBridgeWaitMillis,
    },
    providerCostControl: {
      billingApiIntegrated: false,
      liveExecutionRequiresExternalConfirmation: true,
      policy: "NO_LIVE_RUN_UNTIL_PROVIDER_COST_OR_ENTITLEMENT_CONFIRMED",
    },
    evidenceRequirements: [...EVIDENCE_REQUIREMENTS],
    abortConditions: [...ABORT_CONDITIONS],
    quantumAdvantageClaimAllowed: false,
    interpretation: "PREPARATION_PLAN_ONLY_NOT_PHYSICAL_HARDWARE_EVIDENCE_OR_QUANTUM_ADVANTAGE",
  };
  return validatePhysicalQpuFirstRunPlan(freeze({ ...unsigned, planSha256: canonicalQuantumSha256(unsigned) }));
}

export function buildPhysicalQpuPreparationRecord(input) {
  exactKeys(input, ["backendDescriptor", "plan"], "physical QPU preparation record input");
  const plan = validatePhysicalQpuFirstRunPlan(input.plan);
  const descriptor = input.backendDescriptor;
  exactKeys(descriptor, ["adapterId", "adapterVersion", "backendFamily", "hardwareExecution", "schemaVersion"], "physical backend descriptor");
  if (descriptor.schemaVersion !== 1
    || descriptor.adapterId !== IBM_ADAPTER_ID
    || descriptor.backendFamily !== "PHYSICAL_QPU"
    || descriptor.hardwareExecution !== true) {
    throw new Error("physical preparation record requires the IBM physical QPU adapter descriptor");
  }
  const adapterVersion = text(descriptor.adapterVersion, "physical backend adapterVersion", { pattern: TOKEN_RE, maxBytes: 256 });

  const unsigned = {
    schemaVersion: 1,
    engineId: PREPARATION_RECORD_ENGINE_ID,
    sourceRevision: plan.sourceRevision,
    sourceTree: plan.sourceTree,
    planSha256: plan.planSha256,
    provider: plan.provider,
    backendName: plan.backendName,
    backendAdapterId: descriptor.adapterId,
    backendAdapterVersion: adapterVersion,
    executionAuthorization: PREPARE_ONLY,
    hardwareInvocationCount: 0,
    verdict: "NOT_TESTED",
    status: "PREPARED_PHYSICAL_QPU_RUN_NOT_AUTHORIZED_FOR_EXECUTION",
    providerCostOrEntitlementConfirmed: false,
    quantumAdvantageClaimAllowed: false,
    interpretation: "PREPARATION_RECORD_IS_NOT_PHYSICAL_HARDWARE_EVIDENCE_OR_QUANTUM_ADVANTAGE",
  };
  return freeze({ ...unsigned, recordSha256: canonicalQuantumSha256(unsigned) });
}

export const PHYSICAL_QPU_FIRST_RUN_PLAN_ENGINE_ID = ENGINE_ID;
export const PHYSICAL_QPU_PREPARATION_RECORD_ENGINE_ID = PREPARATION_RECORD_ENGINE_ID;
export const PHYSICAL_QPU_FIRST_RUN_MIN_REPEATED_RUNS = MIN_REPEATED_RUNS;
export const PHYSICAL_QPU_FIRST_RUN_MAX_TRANSPILER_SEED = MAX_TRANSPILER_SEED;
