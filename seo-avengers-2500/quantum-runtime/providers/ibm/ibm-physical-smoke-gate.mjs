import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalQuantumSha256,
  exactKeys,
  freeze,
  integer,
  sha,
  text,
  TOKEN_RE,
} from "../../common.mjs";
import {
  buildPhysicalQpuPreparationRecord,
  validatePhysicalQpuFirstRunPlan,
} from "../../physical-first-run-plan.mjs";
import {
  createIbmFilesystemEvidenceSink,
  createIbmQuantumComputeBackend,
  IBM_QUANTUM_COMPUTE_ADAPTER_ID,
  IBM_QUANTUM_COMPUTE_PROVIDER,
  runIbmQpuBridge,
} from "./ibm-qpu-adapter.mjs";
import {
  createIbmPreflightFilesystemEvidenceSink,
  createIbmQuantumComputePreflight,
  IBM_QPU_PREFLIGHT_ENGINE_ID,
} from "./ibm-qpu-preflight.mjs";

const ENGINE_ID = "WALLE_IBM_PHYSICAL_QPU_SMOKE_GATE_V1";
const AUTHORIZATION_ENGINE_ID = "WALLE_PHYSICAL_QPU_LIVE_AUTHORIZATION_V1";
const EXECUTE_PHYSICAL_QPU = "EXECUTE_PHYSICAL_QPU";
const PREPARE_ONLY = "PREPARE_ONLY";
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const TEST_BACKEND_RE = /contract/i;
const DEFAULT_REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function gitSha(value, label) {
  const normalized = text(value, label, { maxBytes: 40 });
  if (!GIT_SHA_RE.test(normalized)) throw new Error(`${label} must be 40 lowercase hex`);
  return normalized;
}

function bool(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function liveAuthorization(value) {
  if (value !== EXECUTE_PHYSICAL_QPU) throw new Error(`liveExecutionAuthorization must be ${EXECUTE_PHYSICAL_QPU}`);
  return value;
}

function validateLiveAuthorizationRecord(record) {
  exactKeys(record, [
    "authorizationSha256",
    "engineId",
    "exactHeadCiStatus",
    "fullExecutionClaim",
    "interpretation",
    "liveExecutionAuthorization",
    "planSha256",
    "providerCostOrEntitlementConfirmed",
    "providerCostOrEntitlementReference",
    "quantumAdvantageClaimAllowed",
    "schemaVersion",
    "sourceRevision",
    "sourceTree",
    "walleArtifactSha256",
    "walleBlockedModuleCount",
    "walleExecutedModuleCount",
    "walleFailedModuleCount",
    "walleNotTestedModuleCount",
    "walleProofSha256",
  ], "physical QPU live authorization record");
  if (record.schemaVersion !== 1 || record.engineId !== AUTHORIZATION_ENGINE_ID) {
    throw new Error("unsupported physical QPU live authorization record");
  }
  gitSha(record.sourceRevision, "authorization sourceRevision");
  gitSha(record.sourceTree, "authorization sourceTree");
  sha(record.planSha256, "authorization planSha256");
  sha(record.walleArtifactSha256, "authorization walleArtifactSha256");
  sha(record.walleProofSha256, "authorization walleProofSha256");
  liveAuthorization(record.liveExecutionAuthorization);
  if (record.exactHeadCiStatus !== "SUCCESS") throw new Error("exact-head CI must be SUCCESS");
  if (bool(record.providerCostOrEntitlementConfirmed, "providerCostOrEntitlementConfirmed") !== true) {
    throw new Error("provider cost or entitlement must be externally confirmed");
  }
  text(record.providerCostOrEntitlementReference, "provider cost/entitlement reference", { pattern: TOKEN_RE, maxBytes: 256 });
  if (integer(record.walleExecutedModuleCount, "WALLE executed module count", 0, 2_500) !== 2_500
    || integer(record.walleFailedModuleCount, "WALLE failed module count", 0, 2_500) !== 0
    || integer(record.walleBlockedModuleCount, "WALLE blocked module count", 0, 2_500) !== 0
    || integer(record.walleNotTestedModuleCount, "WALLE not-tested module count", 0, 2_500) !== 0
    || bool(record.fullExecutionClaim, "WALLE fullExecutionClaim") !== true) {
    throw new Error("WALLE exact-head evidence is not a complete 2500-module execution claim");
  }
  if (record.quantumAdvantageClaimAllowed !== false
    || record.interpretation !== "EXTERNAL_CI_WALLE_AND_PROVIDER_COST_BINDING_NOT_PROVIDER_BILLING_VERIFICATION_OR_QUANTUM_ADVANTAGE") {
    throw new Error("physical QPU live authorization claim boundary mismatch");
  }
  const { authorizationSha256, ...unsigned } = record;
  if (authorizationSha256 !== canonicalQuantumSha256(unsigned)) {
    throw new Error("physical QPU live authorization digest mismatch");
  }
  return freeze(record);
}

export function buildPhysicalQpuLiveAuthorizationRecord(input) {
  exactKeys(input, [
    "exactHeadCiStatus",
    "fullExecutionClaim",
    "plan",
    "providerCostOrEntitlementConfirmed",
    "providerCostOrEntitlementReference",
    "sourceRevision",
    "sourceTree",
    "walleArtifactSha256",
    "walleBlockedModuleCount",
    "walleExecutedModuleCount",
    "walleFailedModuleCount",
    "walleNotTestedModuleCount",
    "walleProofSha256",
  ], "physical QPU live authorization input");
  const plan = validatePhysicalQpuFirstRunPlan(input.plan);
  const sourceRevision = gitSha(input.sourceRevision, "authorization sourceRevision");
  const sourceTree = gitSha(input.sourceTree, "authorization sourceTree");
  if (sourceRevision !== plan.sourceRevision || sourceTree !== plan.sourceTree) {
    throw new Error("authorization source identity must match physical first-run plan");
  }
  const unsigned = {
    schemaVersion: 1,
    engineId: AUTHORIZATION_ENGINE_ID,
    sourceRevision,
    sourceTree,
    planSha256: plan.planSha256,
    exactHeadCiStatus: input.exactHeadCiStatus,
    walleArtifactSha256: sha(input.walleArtifactSha256, "authorization walleArtifactSha256"),
    walleProofSha256: sha(input.walleProofSha256, "authorization walleProofSha256"),
    walleExecutedModuleCount: input.walleExecutedModuleCount,
    walleFailedModuleCount: input.walleFailedModuleCount,
    walleBlockedModuleCount: input.walleBlockedModuleCount,
    walleNotTestedModuleCount: input.walleNotTestedModuleCount,
    fullExecutionClaim: input.fullExecutionClaim,
    providerCostOrEntitlementConfirmed: input.providerCostOrEntitlementConfirmed,
    providerCostOrEntitlementReference: text(
      input.providerCostOrEntitlementReference,
      "provider cost/entitlement reference",
      { pattern: TOKEN_RE, maxBytes: 256 },
    ),
    liveExecutionAuthorization: EXECUTE_PHYSICAL_QPU,
    quantumAdvantageClaimAllowed: false,
    interpretation: "EXTERNAL_CI_WALLE_AND_PROVIDER_COST_BINDING_NOT_PROVIDER_BILLING_VERIFICATION_OR_QUANTUM_ADVANTAGE",
  };
  return validateLiveAuthorizationRecord(freeze({
    ...unsigned,
    authorizationSha256: canonicalQuantumSha256(unsigned),
  }));
}

function resolveGitSourceIdentity() {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      ["rev-parse", "HEAD", "HEAD^{tree}"],
      { cwd: DEFAULT_REPO_ROOT, encoding: "utf8", maxBuffer: 4_096, windowsHide: true },
      (error, stdout) => {
        if (error) {
          rejectPromise(new Error("PHYSICAL_SMOKE_GATE_GIT_IDENTITY_UNAVAILABLE", { cause: error }));
          return;
        }
        const parts = String(stdout).trim().split(/\s+/u);
        if (parts.length !== 2 || !GIT_SHA_RE.test(parts[0]) || !GIT_SHA_RE.test(parts[1])) {
          rejectPromise(new Error("PHYSICAL_SMOKE_GATE_GIT_IDENTITY_INVALID"));
          return;
        }
        resolvePromise(freeze({ sourceRevision: parts[0], sourceTree: parts[1] }));
      },
    );
  });
}

function assertPlanSourceIdentity(plan, identity) {
  if (identity.sourceRevision !== plan.sourceRevision || identity.sourceTree !== plan.sourceTree) {
    throw new Error("PHYSICAL_SMOKE_GATE_EXACT_SOURCE_MISMATCH");
  }
}

function assertAuthorizationForPlan(record, plan, identity) {
  const checked = validateLiveAuthorizationRecord(record);
  if (checked.planSha256 !== plan.planSha256
    || checked.sourceRevision !== plan.sourceRevision
    || checked.sourceTree !== plan.sourceTree
    || checked.sourceRevision !== identity.sourceRevision
    || checked.sourceTree !== identity.sourceTree) {
    throw new Error("PHYSICAL_SMOKE_GATE_AUTHORIZATION_BINDING_MISMATCH");
  }
  return checked;
}

function preflightReasons(report, plan) {
  const reasons = [];
  if (!report || report.engineId !== IBM_QPU_PREFLIGHT_ENGINE_ID) reasons.push("PREFLIGHT_ENGINE_ID_MISMATCH");
  if (report?.provider !== IBM_QUANTUM_COMPUTE_PROVIDER) reasons.push("PREFLIGHT_PROVIDER_MISMATCH");
  if (report?.verdict !== "PASS" || report?.readiness !== "READY") reasons.push("PREFLIGHT_NOT_READY");
  if (report?.physicalExecutionVerdict !== "NOT_TESTED") reasons.push("PREFLIGHT_PHYSICAL_VERDICT_PROMOTED");
  if (report?.submissionAttempted !== false) reasons.push("PREFLIGHT_SUBMISSION_ATTEMPTED");
  const evidence = report?.preflightEvidence;
  if (!evidence) reasons.push("PREFLIGHT_EVIDENCE_MISSING");
  else {
    if (evidence.backendDevice !== plan.backendName) reasons.push("PREFLIGHT_BACKEND_MISMATCH");
    if (evidence.transpilerSeed !== String(plan.transpilerSeed)) reasons.push("PREFLIGHT_TRANSPILER_SEED_MISMATCH");
    if (evidence.physicalQpu !== true) reasons.push("PREFLIGHT_BACKEND_NOT_PHYSICAL");
    if (evidence.operational !== true || String(evidence.statusMessage).toLowerCase() !== "active") {
      reasons.push("PREFLIGHT_BACKEND_NOT_ACTIVE");
    }
    if (evidence.qubitCapacitySufficient !== true) reasons.push("PREFLIGHT_QUBIT_CAPACITY_INSUFFICIENT");
    if (evidence.nativeOperationSetSatisfied !== true) reasons.push("PREFLIGHT_TRANSPILED_CIRCUIT_NOT_NATIVE");
  }
  return [...new Set(reasons)].sort();
}

function smokeReceiptReasons(execution, preflightEvidence, plan) {
  const reasons = [];
  if (!execution || execution.verdict !== "PASS") reasons.push("SMOKE_EXECUTION_NOT_PASS");
  const receipt = execution?.executionReceipt;
  if (!receipt) return [...new Set([...reasons, "SMOKE_EXECUTION_RECEIPT_MISSING"])].sort();
  if (receipt.provider !== plan.provider) reasons.push("SMOKE_PROVIDER_MISMATCH");
  if (receipt.backendDevice !== plan.backendName) reasons.push("SMOKE_BACKEND_MISMATCH");
  if (receipt.status !== "SUCCEEDED") reasons.push("SMOKE_PROVIDER_STATUS_NOT_SUCCEEDED");
  if (receipt.shotsRequested !== plan.smokeJob.shots || receipt.shotsCompleted !== plan.smokeJob.shots) {
    reasons.push("SMOKE_SHOT_COUNT_MISMATCH");
  }
  if (!receipt.jobId) reasons.push("SMOKE_PROVIDER_JOB_ID_MISSING");
  if (receipt.reproducibilityMetadata?.seed !== String(plan.transpilerSeed)) {
    reasons.push("SMOKE_TRANSPILER_SEED_MISMATCH");
  }
  if (receipt.transpiledCircuitSha256 !== preflightEvidence.transpiledCircuitSha256) {
    reasons.push("SMOKE_TRANSPILED_CIRCUIT_DRIFT_FROM_PREFLIGHT");
  }
  if (receipt.hardwareIdentity?.topologySha256 !== preflightEvidence.topologySha256) {
    reasons.push("SMOKE_TOPOLOGY_DRIFT_FROM_PREFLIGHT");
  }
  if (receipt.hardwareIdentity?.capabilitiesSha256 !== preflightEvidence.capabilitiesSha256) {
    reasons.push("SMOKE_CAPABILITIES_DRIFT_FROM_PREFLIGHT");
  }
  if (receipt.reproducibilityMetadata?.providerSdk !== preflightEvidence.providerSdk
    || receipt.reproducibilityMetadata?.providerSdkVersion !== preflightEvidence.providerSdkVersion
    || receipt.reproducibilityMetadata?.compiler !== preflightEvidence.compiler
    || receipt.reproducibilityMetadata?.compilerVersion !== preflightEvidence.compilerVersion) {
    reasons.push("SMOKE_COMPILER_OR_SDK_DRIFT_FROM_PREFLIGHT");
  }
  if (!receipt.rawResultSha256) reasons.push("SMOKE_RAW_RESULT_HASH_MISSING");
  if (!receipt.providerReceiptSha256) reasons.push("SMOKE_PROVIDER_RECEIPT_HASH_MISSING");
  return [...new Set(reasons)].sort();
}

function buildGateReport({
  plan,
  identity,
  authorization,
  verdict,
  status,
  reasons,
  preflight,
  execution,
  liveExecutionAttempted,
  reconciliationRequired,
}) {
  const receipt = execution?.executionReceipt ?? null;
  const confirmedPhysicalJobCount = receipt?.jobId ? 1 : 0;
  const unsigned = {
    schemaVersion: 1,
    engineId: ENGINE_ID,
    sourceRevision: identity.sourceRevision,
    sourceTree: identity.sourceTree,
    planSha256: plan.planSha256,
    authorizationSha256: authorization?.authorizationSha256 ?? null,
    provider: plan.provider,
    backendName: plan.backendName,
    verdict,
    status,
    reasons: [...new Set(reasons)].sort(),
    preflightReportSha256: preflight ? canonicalQuantumSha256(preflight) : null,
    smokeExecutionSha256: execution ? canonicalQuantumSha256(execution) : null,
    smokeProviderJobId: receipt?.jobId ?? null,
    liveExecutionAttempted,
    confirmedPhysicalJobCount,
    repeatedSeriesExecutionCount: 0,
    repeatedSeriesAuthorized: verdict === "PASS" && confirmedPhysicalJobCount === 1 && !reconciliationRequired,
    providerReconciliationRequired: reconciliationRequired,
    quantumAdvantageClaimAllowed: false,
    interpretation: verdict === "PASS"
      ? "PASS_CERTIFIES_ONE_VALIDATED_PHYSICAL_SMOKE_JOB_AND_AUTHORIZES_BUT_DOES_NOT_EXECUTE_REPEATED_SERIES"
      : liveExecutionAttempted
        ? "NON_PASS_BLOCKS_REPEATED_SERIES_AND_REQUIRES_OPERATOR_REVIEW"
        : "NO_PHYSICAL_JOB_WAS_AUTHORIZED_OR_CONFIRMED_BY_THIS_REPORT",
  };
  return freeze({ ...unsigned, reportSha256: canonicalQuantumSha256(unsigned) });
}

function createGate({
  plan,
  preflight,
  backend,
  liveBridgeState,
}) {
  const checkedPlan = validatePhysicalQpuFirstRunPlan(plan);
  if (!backend?.descriptor
    || backend.descriptor.adapterId !== IBM_QUANTUM_COMPUTE_ADAPTER_ID
    || backend.descriptor.backendFamily !== "PHYSICAL_QPU"
    || backend.descriptor.hardwareExecution !== true) {
    throw new Error("IBM physical smoke gate requires the IBM physical QPU backend");
  }
  if (!preflight || preflight.engineId !== IBM_QPU_PREFLIGHT_ENGINE_ID || typeof preflight.run !== "function") {
    throw new Error("IBM physical smoke gate requires the IBM live preflight");
  }

  return freeze({
    engineId: ENGINE_ID,
    async run({ physicalRequest = null, executionAuthorization = PREPARE_ONLY, authorizationRecord = null } = {}) {
      const identity = await resolveGitSourceIdentity();
      assertPlanSourceIdentity(checkedPlan, identity);

      if (executionAuthorization === PREPARE_ONLY) {
        const preparationRecord = buildPhysicalQpuPreparationRecord({
          plan: checkedPlan,
          backendDescriptor: backend.descriptor,
        });
        return freeze({
          preparationRecord,
          preflight: null,
          smokeExecution: null,
          gateReport: buildGateReport({
            plan: checkedPlan,
            identity,
            authorization: null,
            verdict: "NOT_TESTED",
            status: "PREPARED_PHYSICAL_QPU_RUN_NOT_AUTHORIZED_FOR_EXECUTION",
            reasons: ["PHYSICAL_QPU_EXECUTION_NOT_PERFORMED"],
            preflight: null,
            execution: null,
            liveExecutionAttempted: false,
            reconciliationRequired: false,
          }),
        });
      }
      if (executionAuthorization !== EXECUTE_PHYSICAL_QPU) {
        throw new Error("PHYSICAL_SMOKE_GATE_INVALID_EXECUTION_AUTHORIZATION");
      }
      if (!physicalRequest || typeof physicalRequest !== "object" || Array.isArray(physicalRequest)) {
        throw new Error("PHYSICAL_SMOKE_GATE_PHYSICAL_REQUEST_REQUIRED");
      }
      const authorization = assertAuthorizationForPlan(authorizationRecord, checkedPlan, identity);
      const preflightReport = await preflight.run(physicalRequest);
      const readinessReasons = preflightReasons(preflightReport, checkedPlan);
      if (readinessReasons.length > 0) {
        return freeze({
          preparationRecord: null,
          preflight: preflightReport,
          smokeExecution: null,
          gateReport: buildGateReport({
            plan: checkedPlan,
            identity,
            authorization,
            verdict: preflightReport?.verdict === "FAIL" ? "FAIL" : "INCONCLUSIVE",
            status: "PHYSICAL_SMOKE_BLOCKED_BY_PREFLIGHT",
            reasons: readinessReasons,
            preflight: preflightReport,
            execution: null,
            liveExecutionAttempted: false,
            reconciliationRequired: false,
          }),
        });
      }

      liveBridgeState.lastErrorCode = null;
      const smokeRequest = freeze({ ...physicalRequest, shots: checkedPlan.smokeJob.shots });
      const smokeExecution = await backend.execute(smokeRequest);
      const reconciliationRequired = smokeExecution?.executionReceipt == null;
      const receiptReasons = smokeReceiptReasons(smokeExecution, preflightReport.preflightEvidence, checkedPlan);
      if (liveBridgeState.lastErrorCode === "IBM_QPU_BRIDGE_TIMEOUT") {
        receiptReasons.push("LOCAL_BRIDGE_TIMEOUT_REQUIRES_PROVIDER_JOB_RECONCILIATION_BEFORE_RETRY");
      } else if (reconciliationRequired) {
        receiptReasons.push("UNVERIFIED_LIVE_SUBMISSION_REQUIRES_PROVIDER_RECONCILIATION_BEFORE_RETRY");
      }
      const reasons = [...new Set(receiptReasons)].sort();
      const passed = reasons.length === 0;
      return freeze({
        preparationRecord: null,
        preflight: preflightReport,
        smokeExecution,
        gateReport: buildGateReport({
          plan: checkedPlan,
          identity,
          authorization,
          verdict: passed ? "PASS" : "FAIL",
          status: passed
            ? "SINGLE_PHYSICAL_SMOKE_VERIFIED_REPEATED_SERIES_AUTHORIZED"
            : reconciliationRequired
              ? "SMOKE_PROVIDER_RECONCILIATION_REQUIRED"
              : "PHYSICAL_SMOKE_FAILED_VALIDATION",
          reasons,
          preflight: preflightReport,
          execution: smokeExecution,
          liveExecutionAttempted: true,
          reconciliationRequired,
        }),
      });
    },
  });
}

function trackedLiveRunner(delegate, state) {
  return async (args) => {
    try {
      return await delegate(args);
    } catch (error) {
      state.lastErrorCode = String(error?.message ?? "IBM_QPU_BRIDGE_FAILED").split(":", 1)[0].slice(0, 128);
      throw error;
    }
  };
}

function createConfiguredGate({
  plan,
  apiKey,
  instanceCrn,
  pythonExecutable,
  preflightBridgeRunner,
  executionBridgeRunner,
  evidenceMode,
}) {
  const checkedPlan = validatePhysicalQpuFirstRunPlan(plan);
  const liveBridgeState = { lastErrorCode: null };
  const preflightEvidenceSink = evidenceMode === "FILESYSTEM"
    ? createIbmPreflightFilesystemEvidenceSink({ rootDir: join(checkedPlan.evidenceRoot, "preflight") })
    : async () => Object.freeze({ testOnly: true });
  const executionEvidenceSink = evidenceMode === "FILESYSTEM"
    ? createIbmFilesystemEvidenceSink({ rootDir: join(checkedPlan.evidenceRoot, "smoke") })
    : async () => Object.freeze({ testOnly: true });

  const preflight = createIbmQuantumComputePreflight({
    apiKey,
    instanceCrn,
    backendName: checkedPlan.backendName,
    transpilerSeed: checkedPlan.transpilerSeed,
    evidenceSink: preflightEvidenceSink,
    pythonExecutable,
    timeoutMillis: checkedPlan.limits.bridgeTimeoutMillis,
    bridgeRunner: preflightBridgeRunner,
  });
  const backend = createIbmQuantumComputeBackend({
    apiKey,
    instanceCrn,
    backendName: checkedPlan.backendName,
    evidenceSink: executionEvidenceSink,
    transpilerSeed: checkedPlan.transpilerSeed,
    pythonExecutable,
    timeoutMillis: checkedPlan.limits.bridgeTimeoutMillis,
    bridgeRunner: trackedLiveRunner(executionBridgeRunner, liveBridgeState),
  });
  return createGate({ plan: checkedPlan, preflight, backend, liveBridgeState });
}

export function createIbmPhysicalQpuSmokeGate({
  plan,
  apiKey,
  instanceCrn,
  pythonExecutable = "python3",
} = {}) {
  return createConfiguredGate({
    plan,
    apiKey,
    instanceCrn,
    pythonExecutable,
    preflightBridgeRunner: undefined,
    executionBridgeRunner: runIbmQpuBridge,
    evidenceMode: "FILESYSTEM",
  });
}

export function createIbmPhysicalQpuSmokeGateForContractTest({
  plan,
  apiKey,
  instanceCrn,
  preflightBridgeRunner,
  executionBridgeRunner,
} = {}) {
  const checkedPlan = validatePhysicalQpuFirstRunPlan(plan);
  if (!TEST_BACKEND_RE.test(checkedPlan.backendName)) {
    throw new Error("contract-test physical smoke gate requires backendName containing 'contract'");
  }
  if (typeof preflightBridgeRunner !== "function" || typeof executionBridgeRunner !== "function") {
    throw new Error("contract-test physical smoke gate requires explicit bridge runners");
  }
  return createConfiguredGate({
    plan: checkedPlan,
    apiKey,
    instanceCrn,
    pythonExecutable: "python3",
    preflightBridgeRunner,
    executionBridgeRunner,
    evidenceMode: "TEST_MEMORY",
  });
}

export const IBM_PHYSICAL_QPU_SMOKE_GATE_ENGINE_ID = ENGINE_ID;
export const PHYSICAL_QPU_LIVE_AUTHORIZATION_ENGINE_ID = AUTHORIZATION_ENGINE_ID;
