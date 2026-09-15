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
import { buildPhysicalQpuExperimentReport } from "../../physical-experiment-protocol.mjs";
import { validatePhysicalQpuFirstRunPlan } from "../../physical-first-run-plan.mjs";
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

const ENGINE_ID = "WALLE_IBM_REPEATED_PHYSICAL_SERIES_GATE_V1";
const AUTHORIZATION_ENGINE_ID = "WALLE_PHYSICAL_QPU_REPEATED_SERIES_AUTHORIZATION_V1";
const SMOKE_GATE_ENGINE_ID = "WALLE_IBM_PHYSICAL_QPU_SMOKE_GATE_V1";
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

function repeatedRequestForPlan(physicalRequest, plan) {
  if (!physicalRequest || typeof physicalRequest !== "object" || Array.isArray(physicalRequest)) {
    throw new Error("REPEATED_SERIES_PHYSICAL_REQUEST_REQUIRED");
  }
  return freeze({ ...physicalRequest, shots: plan.repeatedSeries.shots });
}

function smokeReference(smokeGateResult, plan) {
  if (!smokeGateResult || typeof smokeGateResult !== "object" || Array.isArray(smokeGateResult)) {
    throw new Error("REPEATED_SERIES_SMOKE_GATE_RESULT_REQUIRED");
  }
  const report = smokeGateResult.gateReport;
  const execution = smokeGateResult.smokeExecution;
  const receipt = execution?.executionReceipt ?? null;
  if (!report || report.engineId !== SMOKE_GATE_ENGINE_ID
    || report.verdict !== "PASS"
    || report.repeatedSeriesAuthorized !== true
    || report.providerReconciliationRequired !== false
    || report.confirmedPhysicalJobCount !== 1
    || report.repeatedSeriesExecutionCount !== 0) {
    throw new Error("REPEATED_SERIES_REQUIRES_VERIFIED_SMOKE_GATE_PASS");
  }
  if (report.sourceRevision !== plan.sourceRevision
    || report.sourceTree !== plan.sourceTree
    || report.planSha256 !== plan.planSha256
    || report.provider !== plan.provider
    || report.backendName !== plan.backendName) {
    throw new Error("REPEATED_SERIES_SMOKE_GATE_PLAN_BINDING_MISMATCH");
  }
  if (!execution || execution.verdict !== "PASS" || !receipt) {
    throw new Error("REPEATED_SERIES_SMOKE_EXECUTION_RECEIPT_REQUIRED");
  }
  if (receipt.provider !== plan.provider
    || receipt.backendDevice !== plan.backendName
    || receipt.status !== "SUCCEEDED"
    || receipt.shotsRequested !== plan.smokeJob.shots
    || receipt.shotsCompleted !== plan.smokeJob.shots
    || !receipt.jobId
    || report.smokeProviderJobId !== receipt.jobId) {
    throw new Error("REPEATED_SERIES_SMOKE_RECEIPT_INVALID");
  }
  if (!receipt.transpiledCircuitSha256
    || !receipt.hardwareIdentity?.topologySha256
    || !receipt.hardwareIdentity?.capabilitiesSha256
    || !receipt.rawResultSha256
    || !receipt.providerReceiptSha256) {
    throw new Error("REPEATED_SERIES_SMOKE_REFERENCE_EVIDENCE_INCOMPLETE");
  }
  if (receipt.reproducibilityMetadata?.seed !== String(plan.transpilerSeed)) {
    throw new Error("REPEATED_SERIES_SMOKE_SEED_MISMATCH");
  }
  return freeze({
    smokeGateReportSha256: canonicalQuantumSha256(report),
    smokeExecutionSha256: canonicalQuantumSha256(execution),
    smokeReceiptSha256: sha(receipt.receiptSha256, "smoke receiptSha256"),
    smokeProviderJobId: text(receipt.jobId, "smoke provider jobId", { pattern: TOKEN_RE, maxBytes: 256 }),
    provider: receipt.provider,
    backendDevice: receipt.backendDevice,
    problemBindingSha256: receipt.problemBindingSha256,
    optimizationProblemReportSha256: receipt.optimizationProblemReportSha256,
    optimizationModelSha256: receipt.optimizationModelSha256,
    circuitSha256: receipt.circuitSha256,
    transpiledCircuitSha256: receipt.transpiledCircuitSha256,
    topologySha256: receipt.hardwareIdentity.topologySha256,
    capabilitiesSha256: receipt.hardwareIdentity.capabilitiesSha256,
    providerSdk: receipt.reproducibilityMetadata?.providerSdk ?? null,
    providerSdkVersion: receipt.reproducibilityMetadata?.providerSdkVersion ?? null,
    compiler: receipt.reproducibilityMetadata?.compiler ?? null,
    compilerVersion: receipt.reproducibilityMetadata?.compilerVersion ?? null,
    seed: receipt.reproducibilityMetadata?.seed ?? null,
  });
}

function validateSeriesAuthorizationRecord(record) {
  exactKeys(record, [
    "authorizationSha256",
    "baselineProfileSha256",
    "engineId",
    "exactHeadCiStatus",
    "fullExecutionClaim",
    "interpretation",
    "liveExecutionAuthorization",
    "planSha256",
    "providerCostOrEntitlementConfirmed",
    "providerCostOrEntitlementReference",
    "quantumAdvantageClaimAllowed",
    "repeatedRequestSha256",
    "repeatedRunCount",
    "repeatedShots",
    "schemaVersion",
    "smokeGateReportSha256",
    "smokeReceiptSha256",
    "sourceRevision",
    "sourceTree",
    "walleArtifactSha256",
    "walleBlockedModuleCount",
    "walleExecutedModuleCount",
    "walleFailedModuleCount",
    "walleNotTestedModuleCount",
    "walleProofSha256",
  ], "repeated physical series authorization record");
  if (record.schemaVersion !== 1 || record.engineId !== AUTHORIZATION_ENGINE_ID) {
    throw new Error("unsupported repeated physical series authorization record");
  }
  gitSha(record.sourceRevision, "series authorization sourceRevision");
  gitSha(record.sourceTree, "series authorization sourceTree");
  sha(record.planSha256, "series authorization planSha256");
  sha(record.smokeGateReportSha256, "series authorization smokeGateReportSha256");
  sha(record.smokeReceiptSha256, "series authorization smokeReceiptSha256");
  sha(record.repeatedRequestSha256, "series authorization repeatedRequestSha256");
  sha(record.baselineProfileSha256, "series authorization baselineProfileSha256");
  sha(record.walleArtifactSha256, "series authorization walleArtifactSha256");
  sha(record.walleProofSha256, "series authorization walleProofSha256");
  liveAuthorization(record.liveExecutionAuthorization);
  if (record.exactHeadCiStatus !== "SUCCESS") throw new Error("exact-head CI must be SUCCESS");
  if (bool(record.providerCostOrEntitlementConfirmed, "providerCostOrEntitlementConfirmed") !== true) {
    throw new Error("provider cost or entitlement must be externally confirmed");
  }
  text(record.providerCostOrEntitlementReference, "provider cost/entitlement reference", { pattern: TOKEN_RE, maxBytes: 256 });
  integer(record.repeatedRunCount, "authorized repeated run count", 5, 256);
  integer(record.repeatedShots, "authorized repeated shots", 1, 10_000_000);
  if (integer(record.walleExecutedModuleCount, "WALLE executed module count", 0, 2_500) !== 2_500
    || integer(record.walleFailedModuleCount, "WALLE failed module count", 0, 2_500) !== 0
    || integer(record.walleBlockedModuleCount, "WALLE blocked module count", 0, 2_500) !== 0
    || integer(record.walleNotTestedModuleCount, "WALLE not-tested module count", 0, 2_500) !== 0
    || bool(record.fullExecutionClaim, "WALLE fullExecutionClaim") !== true) {
    throw new Error("WALLE exact-head evidence is not a complete 2500-module execution claim");
  }
  if (record.quantumAdvantageClaimAllowed !== false
    || record.interpretation !== "EXACT_SMOKE_SERIES_REQUEST_BASELINE_CI_WALLE_AND_PROVIDER_COST_BINDING_NOT_QUANTUM_ADVANTAGE") {
    throw new Error("repeated physical series authorization claim boundary mismatch");
  }
  const { authorizationSha256, ...unsigned } = record;
  if (authorizationSha256 !== canonicalQuantumSha256(unsigned)) {
    throw new Error("repeated physical series authorization digest mismatch");
  }
  return freeze(record);
}

export function buildRepeatedPhysicalSeriesAuthorizationRecord(input) {
  exactKeys(input, [
    "baselineProfile",
    "exactHeadCiStatus",
    "fullExecutionClaim",
    "physicalRequest",
    "plan",
    "providerCostOrEntitlementConfirmed",
    "providerCostOrEntitlementReference",
    "smokeGateResult",
    "sourceRevision",
    "sourceTree",
    "walleArtifactSha256",
    "walleBlockedModuleCount",
    "walleExecutedModuleCount",
    "walleFailedModuleCount",
    "walleNotTestedModuleCount",
    "walleProofSha256",
  ], "repeated physical series authorization input");
  const plan = validatePhysicalQpuFirstRunPlan(input.plan);
  const sourceRevision = gitSha(input.sourceRevision, "series authorization sourceRevision");
  const sourceTree = gitSha(input.sourceTree, "series authorization sourceTree");
  if (sourceRevision !== plan.sourceRevision || sourceTree !== plan.sourceTree) {
    throw new Error("series authorization source identity must match physical first-run plan");
  }
  const reference = smokeReference(input.smokeGateResult, plan);
  const repeatedRequest = repeatedRequestForPlan(input.physicalRequest, plan);
  const unsigned = {
    schemaVersion: 1,
    engineId: AUTHORIZATION_ENGINE_ID,
    sourceRevision,
    sourceTree,
    planSha256: plan.planSha256,
    smokeGateReportSha256: reference.smokeGateReportSha256,
    smokeReceiptSha256: reference.smokeReceiptSha256,
    repeatedRequestSha256: canonicalQuantumSha256(repeatedRequest),
    baselineProfileSha256: canonicalQuantumSha256(input.baselineProfile),
    repeatedRunCount: plan.repeatedSeries.runCount,
    repeatedShots: plan.repeatedSeries.shots,
    exactHeadCiStatus: input.exactHeadCiStatus,
    walleArtifactSha256: sha(input.walleArtifactSha256, "series authorization walleArtifactSha256"),
    walleProofSha256: sha(input.walleProofSha256, "series authorization walleProofSha256"),
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
    interpretation: "EXACT_SMOKE_SERIES_REQUEST_BASELINE_CI_WALLE_AND_PROVIDER_COST_BINDING_NOT_QUANTUM_ADVANTAGE",
  };
  return validateSeriesAuthorizationRecord(freeze({
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
          rejectPromise(new Error("REPEATED_SERIES_GIT_IDENTITY_UNAVAILABLE", { cause: error }));
          return;
        }
        const parts = String(stdout).trim().split(/\s+/u);
        if (parts.length !== 2 || !GIT_SHA_RE.test(parts[0]) || !GIT_SHA_RE.test(parts[1])) {
          rejectPromise(new Error("REPEATED_SERIES_GIT_IDENTITY_INVALID"));
          return;
        }
        resolvePromise(freeze({ sourceRevision: parts[0], sourceTree: parts[1] }));
      },
    );
  });
}

function assertPlanSourceIdentity(plan, identity) {
  if (identity.sourceRevision !== plan.sourceRevision || identity.sourceTree !== plan.sourceTree) {
    throw new Error("REPEATED_SERIES_EXACT_SOURCE_MISMATCH");
  }
}

function assertAuthorizationForSeries(record, plan, identity, reference, physicalRequest, baselineProfile) {
  const checked = validateSeriesAuthorizationRecord(record);
  if (checked.planSha256 !== plan.planSha256
    || checked.sourceRevision !== plan.sourceRevision
    || checked.sourceTree !== plan.sourceTree
    || checked.sourceRevision !== identity.sourceRevision
    || checked.sourceTree !== identity.sourceTree
    || checked.smokeGateReportSha256 !== reference.smokeGateReportSha256
    || checked.smokeReceiptSha256 !== reference.smokeReceiptSha256
    || checked.repeatedRunCount !== plan.repeatedSeries.runCount
    || checked.repeatedShots !== plan.repeatedSeries.shots) {
    throw new Error("REPEATED_SERIES_AUTHORIZATION_BINDING_MISMATCH");
  }
  if (checked.repeatedRequestSha256 !== canonicalQuantumSha256(repeatedRequestForPlan(physicalRequest, plan))) {
    throw new Error("REPEATED_SERIES_AUTHORIZED_REQUEST_MISMATCH");
  }
  if (checked.baselineProfileSha256 !== canonicalQuantumSha256(baselineProfile)) {
    throw new Error("REPEATED_SERIES_AUTHORIZED_BASELINE_MISMATCH");
  }
  return checked;
}

function preflightReasons(report, reference, plan) {
  const reasons = [];
  if (!report || report.engineId !== IBM_QPU_PREFLIGHT_ENGINE_ID) reasons.push("SERIES_PREFLIGHT_ENGINE_ID_MISMATCH");
  if (report?.provider !== IBM_QUANTUM_COMPUTE_PROVIDER) reasons.push("SERIES_PREFLIGHT_PROVIDER_MISMATCH");
  if (report?.verdict !== "PASS" || report?.readiness !== "READY") reasons.push("SERIES_PREFLIGHT_NOT_READY");
  if (report?.physicalExecutionVerdict !== "NOT_TESTED") reasons.push("SERIES_PREFLIGHT_PHYSICAL_VERDICT_PROMOTED");
  if (report?.submissionAttempted !== false) reasons.push("SERIES_PREFLIGHT_SUBMISSION_ATTEMPTED");
  const evidence = report?.preflightEvidence;
  if (!evidence) return [...new Set([...reasons, "SERIES_PREFLIGHT_EVIDENCE_MISSING"])].sort();
  if (evidence.backendDevice !== plan.backendName || evidence.backendDevice !== reference.backendDevice) {
    reasons.push("SERIES_PREFLIGHT_BACKEND_DRIFT_FROM_SMOKE");
  }
  if (evidence.transpilerSeed !== String(plan.transpilerSeed) || evidence.transpilerSeed !== reference.seed) {
    reasons.push("SERIES_PREFLIGHT_SEED_DRIFT_FROM_SMOKE");
  }
  if (evidence.physicalQpu !== true) reasons.push("SERIES_PREFLIGHT_BACKEND_NOT_PHYSICAL");
  if (evidence.operational !== true || String(evidence.statusMessage).toLowerCase() !== "active") {
    reasons.push("SERIES_PREFLIGHT_BACKEND_NOT_ACTIVE");
  }
  if (evidence.qubitCapacitySufficient !== true) reasons.push("SERIES_PREFLIGHT_QUBIT_CAPACITY_INSUFFICIENT");
  if (evidence.nativeOperationSetSatisfied !== true) reasons.push("SERIES_PREFLIGHT_TRANSPILED_CIRCUIT_NOT_NATIVE");
  if (evidence.transpiledCircuitSha256 !== reference.transpiledCircuitSha256) {
    reasons.push("SERIES_PREFLIGHT_TRANSPILED_CIRCUIT_DRIFT_FROM_SMOKE");
  }
  if (evidence.topologySha256 !== reference.topologySha256) {
    reasons.push("SERIES_PREFLIGHT_TOPOLOGY_DRIFT_FROM_SMOKE");
  }
  if (evidence.capabilitiesSha256 !== reference.capabilitiesSha256) {
    reasons.push("SERIES_PREFLIGHT_CAPABILITIES_DRIFT_FROM_SMOKE");
  }
  if (evidence.providerSdk !== reference.providerSdk
    || evidence.providerSdkVersion !== reference.providerSdkVersion
    || evidence.compiler !== reference.compiler
    || evidence.compilerVersion !== reference.compilerVersion) {
    reasons.push("SERIES_PREFLIGHT_COMPILER_OR_SDK_DRIFT_FROM_SMOKE");
  }
  return [...new Set(reasons)].sort();
}

function measurementCountTotal(counts) {
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) return null;
  let total = 0;
  for (const value of Object.values(counts)) {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function repeatedReceiptReasons(execution, preflightEvidence, reference, plan, seenJobIds) {
  const reasons = [];
  if (!execution || execution.verdict !== "PASS") reasons.push("SERIES_EXECUTION_NOT_PASS");
  const receipt = execution?.executionReceipt;
  if (!receipt) return [...new Set([...reasons, "SERIES_EXECUTION_RECEIPT_MISSING"])].sort();
  if (receipt.provider !== plan.provider || receipt.provider !== reference.provider) reasons.push("SERIES_PROVIDER_DRIFT_FROM_SMOKE");
  if (receipt.backendDevice !== plan.backendName || receipt.backendDevice !== reference.backendDevice) reasons.push("SERIES_BACKEND_DRIFT_FROM_SMOKE");
  if (receipt.status !== "SUCCEEDED") reasons.push("SERIES_PROVIDER_STATUS_NOT_SUCCEEDED");
  if (receipt.shotsRequested !== plan.repeatedSeries.shots || receipt.shotsCompleted !== plan.repeatedSeries.shots) {
    reasons.push("SERIES_SHOT_COUNT_MISMATCH");
  }
  if (!receipt.jobId) reasons.push("SERIES_PROVIDER_JOB_ID_MISSING");
  else if (seenJobIds.has(receipt.jobId)) reasons.push("SERIES_DUPLICATE_PROVIDER_JOB_ID");
  if (measurementCountTotal(receipt.measurementCounts) !== receipt.shotsCompleted) {
    reasons.push("SERIES_MEASUREMENT_COUNT_MISMATCH");
  }
  if (receipt.problemBindingSha256 !== reference.problemBindingSha256
    || receipt.optimizationProblemReportSha256 !== reference.optimizationProblemReportSha256
    || receipt.optimizationModelSha256 !== reference.optimizationModelSha256
    || receipt.circuitSha256 !== reference.circuitSha256) {
    reasons.push("SERIES_PROBLEM_OR_CIRCUIT_DRIFT_FROM_SMOKE");
  }
  if (receipt.reproducibilityMetadata?.seed !== reference.seed
    || receipt.reproducibilityMetadata?.seed !== String(plan.transpilerSeed)) {
    reasons.push("SERIES_TRANSPILER_SEED_DRIFT_FROM_SMOKE");
  }
  if (receipt.transpiledCircuitSha256 !== reference.transpiledCircuitSha256
    || receipt.transpiledCircuitSha256 !== preflightEvidence.transpiledCircuitSha256) {
    reasons.push("SERIES_TRANSPILED_CIRCUIT_DRIFT");
  }
  if (receipt.hardwareIdentity?.topologySha256 !== reference.topologySha256
    || receipt.hardwareIdentity?.topologySha256 !== preflightEvidence.topologySha256) {
    reasons.push("SERIES_TOPOLOGY_DRIFT");
  }
  if (receipt.hardwareIdentity?.capabilitiesSha256 !== reference.capabilitiesSha256
    || receipt.hardwareIdentity?.capabilitiesSha256 !== preflightEvidence.capabilitiesSha256) {
    reasons.push("SERIES_CAPABILITIES_DRIFT");
  }
  if (receipt.reproducibilityMetadata?.providerSdk !== reference.providerSdk
    || receipt.reproducibilityMetadata?.providerSdkVersion !== reference.providerSdkVersion
    || receipt.reproducibilityMetadata?.compiler !== reference.compiler
    || receipt.reproducibilityMetadata?.compilerVersion !== reference.compilerVersion
    || receipt.reproducibilityMetadata?.providerSdk !== preflightEvidence.providerSdk
    || receipt.reproducibilityMetadata?.providerSdkVersion !== preflightEvidence.providerSdkVersion
    || receipt.reproducibilityMetadata?.compiler !== preflightEvidence.compiler
    || receipt.reproducibilityMetadata?.compilerVersion !== preflightEvidence.compilerVersion) {
    reasons.push("SERIES_COMPILER_OR_SDK_DRIFT");
  }
  if (!receipt.rawResultSha256) reasons.push("SERIES_RAW_RESULT_HASH_MISSING");
  if (!receipt.providerReceiptSha256) reasons.push("SERIES_PROVIDER_RECEIPT_HASH_MISSING");
  return [...new Set(reasons)].sort();
}

function buildExperimentReport({ physicalRequest, baselineProfile, executions, plan }) {
  return buildPhysicalQpuExperimentReport({
    optimizationProblemReport: physicalRequest.optimizationProblemReport,
    baselineProfile,
    quantumExecutions: executions,
    minimumCompletedRuns: plan.repeatedSeries.runCount,
  });
}

function buildGateReport({
  plan,
  identity,
  authorization,
  reference,
  verdict,
  status,
  reasons,
  requestedRunCount,
  preflightCheckCount,
  executions,
  experimentReport,
  reconciliationRequired,
}) {
  const jobIds = executions.map((execution) => execution?.executionReceipt?.jobId).filter(Boolean);
  const unsigned = {
    schemaVersion: 1,
    engineId: ENGINE_ID,
    sourceRevision: identity.sourceRevision,
    sourceTree: identity.sourceTree,
    planSha256: plan.planSha256,
    authorizationSha256: authorization?.authorizationSha256 ?? null,
    smokeGateReportSha256: reference.smokeGateReportSha256,
    smokeReceiptSha256: reference.smokeReceiptSha256,
    provider: plan.provider,
    backendName: plan.backendName,
    verdict,
    status,
    reasons: [...new Set(reasons)].sort(),
    requestedRepeatedRunCount: requestedRunCount,
    attemptedRepeatedRunCount: executions.length,
    confirmedRepeatedPhysicalJobCount: jobIds.length,
    totalConfirmedPhysicalJobCountIncludingSmoke: 1 + jobIds.length,
    preflightCheckCount,
    repeatedProviderJobIds: jobIds,
    repeatedSeriesComplete: verdict === "PASS"
      && executions.length === requestedRunCount
      && jobIds.length === requestedRunCount
      && !reconciliationRequired,
    physicalExperimentReportSha256: experimentReport?.reportSha256 ?? null,
    providerReconciliationRequired: reconciliationRequired,
    automaticRetryAllowed: false,
    quantumAdvantageClaimAllowed: false,
    interpretation: verdict === "PASS"
      ? "PASS_CERTIFIES_CONTROLLED_REPEATED_PHYSICAL_SERIES_AND_CLASSICAL_COMPARABILITY_NOT_QUANTUM_ADVANTAGE"
      : verdict === "NOT_TESTED"
        ? "NO_REPEATED_PHYSICAL_JOB_WAS_AUTHORIZED_OR_EXECUTED"
        : reconciliationRequired
          ? "AMBIGUOUS_PROVIDER_STATE_REQUIRES_EXTERNAL_RECONCILIATION_BEFORE_ANY_RETRY"
          : "NON_PASS_STOPS_BEFORE_THE_NEXT_PHYSICAL_SUBMISSION",
  };
  return freeze({ ...unsigned, reportSha256: canonicalQuantumSha256(unsigned) });
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

function createGate({ plan, preflight, backend, liveBridgeState }) {
  const checkedPlan = validatePhysicalQpuFirstRunPlan(plan);
  if (!backend?.descriptor
    || backend.descriptor.adapterId !== IBM_QUANTUM_COMPUTE_ADAPTER_ID
    || backend.descriptor.backendFamily !== "PHYSICAL_QPU"
    || backend.descriptor.hardwareExecution !== true) {
    throw new Error("IBM repeated physical series gate requires the IBM physical QPU backend");
  }
  if (!preflight || preflight.engineId !== IBM_QPU_PREFLIGHT_ENGINE_ID || typeof preflight.run !== "function") {
    throw new Error("IBM repeated physical series gate requires the IBM live preflight");
  }

  return freeze({
    engineId: ENGINE_ID,
    async run({
      physicalRequest = null,
      baselineProfile = null,
      smokeGateResult = null,
      executionAuthorization = PREPARE_ONLY,
      authorizationRecord = null,
    } = {}) {
      const identity = await resolveGitSourceIdentity();
      assertPlanSourceIdentity(checkedPlan, identity);
      const reference = smokeReference(smokeGateResult, checkedPlan);
      const repeatedRequest = repeatedRequestForPlan(physicalRequest, checkedPlan);

      if (executionAuthorization === PREPARE_ONLY) {
        return freeze({
          executions: freeze([]),
          preflightReports: freeze([]),
          physicalExperimentReport: null,
          gateReport: buildGateReport({
            plan: checkedPlan,
            identity,
            authorization: null,
            reference,
            verdict: "NOT_TESTED",
            status: "REPEATED_PHYSICAL_SERIES_PREPARED_NOT_AUTHORIZED",
            reasons: ["REPEATED_PHYSICAL_QPU_EXECUTION_NOT_PERFORMED"],
            requestedRunCount: checkedPlan.repeatedSeries.runCount,
            preflightCheckCount: 0,
            executions: [],
            experimentReport: null,
            reconciliationRequired: false,
          }),
        });
      }
      if (executionAuthorization !== EXECUTE_PHYSICAL_QPU) {
        throw new Error("REPEATED_SERIES_INVALID_EXECUTION_AUTHORIZATION");
      }
      const authorization = assertAuthorizationForSeries(
        authorizationRecord,
        checkedPlan,
        identity,
        reference,
        physicalRequest,
        baselineProfile,
      );

      const executions = [];
      const preflightReports = [];
      const seenJobIds = new Set([reference.smokeProviderJobId]);
      let reconciliationRequired = false;
      let terminalReasons = [];
      let terminalStatus = null;

      for (let index = 0; index < checkedPlan.repeatedSeries.runCount; index += 1) {
        const preflightReport = await preflight.run(repeatedRequest);
        preflightReports.push(preflightReport);
        const readinessReasons = preflightReasons(preflightReport, reference, checkedPlan);
        if (readinessReasons.length > 0) {
          terminalReasons = readinessReasons;
          terminalStatus = "REPEATED_SERIES_BLOCKED_BY_PREFLIGHT_BEFORE_SUBMISSION";
          break;
        }

        liveBridgeState.lastErrorCode = null;
        const execution = await backend.execute(repeatedRequest);
        executions.push(execution);
        const noReceipt = execution?.executionReceipt == null;
        reconciliationRequired = noReceipt;
        const receiptReasons = repeatedReceiptReasons(
          execution,
          preflightReport.preflightEvidence,
          reference,
          checkedPlan,
          seenJobIds,
        );
        if (liveBridgeState.lastErrorCode === "IBM_QPU_BRIDGE_TIMEOUT") {
          receiptReasons.push("LOCAL_BRIDGE_TIMEOUT_REQUIRES_PROVIDER_JOB_RECONCILIATION_BEFORE_RETRY");
          reconciliationRequired = true;
        } else if (noReceipt) {
          receiptReasons.push("UNVERIFIED_LIVE_SUBMISSION_REQUIRES_PROVIDER_RECONCILIATION_BEFORE_RETRY");
        }
        terminalReasons = [...new Set(receiptReasons)].sort();
        if (terminalReasons.length > 0) {
          terminalStatus = reconciliationRequired
            ? "REPEATED_SERIES_PROVIDER_RECONCILIATION_REQUIRED"
            : "REPEATED_SERIES_STOPPED_AFTER_RECEIPT_VALIDATION";
          break;
        }
        seenJobIds.add(execution.executionReceipt.jobId);
      }

      const experimentReport = buildExperimentReport({
        physicalRequest: repeatedRequest,
        baselineProfile,
        executions,
        plan: checkedPlan,
      });

      if (terminalReasons.length > 0) {
        const failLike = terminalReasons.some((reason) => reason.includes("DRIFT")
          || reason.includes("DUPLICATE")
          || reason.includes("MISMATCH")
          || reason.includes("MISSING")
          || reason.includes("NOT_PASS"));
        return freeze({
          executions: freeze([...executions]),
          preflightReports: freeze([...preflightReports]),
          physicalExperimentReport: experimentReport,
          gateReport: buildGateReport({
            plan: checkedPlan,
            identity,
            authorization,
            reference,
            verdict: failLike || reconciliationRequired ? "FAIL" : "INCONCLUSIVE",
            status: terminalStatus,
            reasons: terminalReasons,
            requestedRunCount: checkedPlan.repeatedSeries.runCount,
            preflightCheckCount: preflightReports.length,
            executions,
            experimentReport,
            reconciliationRequired,
          }),
        });
      }

      const experimentReasons = experimentReport.verdict === "PASS"
        ? []
        : ["REPEATED_SERIES_CLASSICAL_COMPARISON_NOT_PASS", ...experimentReport.reasons];
      const passed = experimentReport.verdict === "PASS"
        && executions.length === checkedPlan.repeatedSeries.runCount;
      return freeze({
        executions: freeze([...executions]),
        preflightReports: freeze([...preflightReports]),
        physicalExperimentReport: experimentReport,
        gateReport: buildGateReport({
          plan: checkedPlan,
          identity,
          authorization,
          reference,
          verdict: passed ? "PASS" : experimentReport.verdict === "FAIL" ? "FAIL" : "INCONCLUSIVE",
          status: passed
            ? "REPEATED_PHYSICAL_SERIES_VERIFIED_AND_CLASSICALLY_COMPARABLE"
            : "REPEATED_PHYSICAL_SERIES_COMPARISON_INCOMPLETE",
          reasons: experimentReasons,
          requestedRunCount: checkedPlan.repeatedSeries.runCount,
          preflightCheckCount: preflightReports.length,
          executions,
          experimentReport,
          reconciliationRequired: false,
        }),
      });
    },
  });
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
    ? createIbmPreflightFilesystemEvidenceSink({ rootDir: join(checkedPlan.evidenceRoot, "repeated-series-preflight") })
    : async () => Object.freeze({ testOnly: true });
  const executionEvidenceSink = evidenceMode === "FILESYSTEM"
    ? createIbmFilesystemEvidenceSink({ rootDir: join(checkedPlan.evidenceRoot, "repeated-series") })
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

export function createIbmRepeatedPhysicalSeriesGate({
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

export function createIbmRepeatedPhysicalSeriesGateForContractTest({
  plan,
  apiKey,
  instanceCrn,
  preflightBridgeRunner,
  executionBridgeRunner,
} = {}) {
  const checkedPlan = validatePhysicalQpuFirstRunPlan(plan);
  if (!TEST_BACKEND_RE.test(checkedPlan.backendName)) {
    throw new Error("contract-test repeated physical series gate requires backendName containing 'contract'");
  }
  if (typeof preflightBridgeRunner !== "function" || typeof executionBridgeRunner !== "function") {
    throw new Error("contract-test repeated physical series gate requires explicit bridge runners");
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

export const IBM_REPEATED_PHYSICAL_SERIES_GATE_ENGINE_ID = ENGINE_ID;
export const PHYSICAL_QPU_REPEATED_SERIES_AUTHORIZATION_ENGINE_ID = AUTHORIZATION_ENGINE_ID;
