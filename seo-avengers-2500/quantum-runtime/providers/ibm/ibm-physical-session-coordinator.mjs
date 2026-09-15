import { canonicalQuantumSha256, freeze } from "../../common.mjs";
import { validatePhysicalQpuFirstRunPlan } from "../../physical-first-run-plan.mjs";
import {
  createIbmPhysicalQpuSmokeGate,
  IBM_PHYSICAL_QPU_SMOKE_GATE_ENGINE_ID,
} from "./ibm-physical-smoke-gate.mjs";
import {
  createIbmRepeatedPhysicalSeriesGate,
  IBM_REPEATED_PHYSICAL_SERIES_GATE_ENGINE_ID,
} from "./ibm-repeated-series-gate.mjs";

const ENGINE_ID = "WALLE_IBM_PHYSICAL_SESSION_COORDINATOR_V1";
const PREPARE_ONLY = "PREPARE_ONLY";
const EXECUTE_SINGLE_PHYSICAL_SMOKE = "EXECUTE_SINGLE_PHYSICAL_SMOKE";
const EXECUTE_REPEATED_PHYSICAL_SERIES = "EXECUTE_REPEATED_PHYSICAL_SERIES";
const GATE_EXECUTE_AUTHORIZATION = "EXECUTE_PHYSICAL_QPU";
const TEST_BACKEND_RE = /contract/i;

function phase(value) {
  if (![PREPARE_ONLY, EXECUTE_SINGLE_PHYSICAL_SMOKE, EXECUTE_REPEATED_PHYSICAL_SERIES].includes(value)) {
    throw new Error("IBM physical session phase invalid");
  }
  return value;
}

function assertGate(gate, engineId, label) {
  if (!gate || typeof gate !== "object" || gate.engineId !== engineId || typeof gate.run !== "function") {
    throw new Error(`${label} gate contract mismatch`);
  }
  return gate;
}

function assertReportDigest(report, label) {
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error(`${label} missing`);
  const { reportSha256, ...unsigned } = report;
  if (typeof reportSha256 !== "string" || reportSha256 !== canonicalQuantumSha256(unsigned)) {
    throw new Error(`${label} digest mismatch`);
  }
  return report;
}

function assertVerifiedSmokeResult(result, plan) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("IBM physical session requires prior smoke result");
  }
  const report = assertReportDigest(result.gateReport, "IBM physical smoke gate report");
  if (report.engineId !== IBM_PHYSICAL_QPU_SMOKE_GATE_ENGINE_ID
    || report.sourceRevision !== plan.sourceRevision
    || report.sourceTree !== plan.sourceTree
    || report.planSha256 !== plan.planSha256
    || report.provider !== plan.provider
    || report.backendName !== plan.backendName) {
    throw new Error("IBM physical session smoke result binding mismatch");
  }
  if (report.verdict !== "PASS"
    || report.confirmedPhysicalJobCount !== 1
    || report.repeatedSeriesAuthorized !== true
    || report.providerReconciliationRequired !== false
    || report.repeatedSeriesExecutionCount !== 0) {
    throw new Error("IBM physical session requires verified smoke PASS before repeated series");
  }
  const execution = result.smokeExecution;
  if (!execution || !execution.executionReceipt || execution.executionReceipt.jobId !== report.smokeProviderJobId) {
    throw new Error("IBM physical session smoke execution receipt missing or inconsistent");
  }
  if (report.smokeExecutionSha256 !== canonicalQuantumSha256(execution)) {
    throw new Error("IBM physical session smoke execution digest mismatch");
  }
  return result;
}

function assertRepeatedSeriesResult(result, plan) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("IBM repeated physical series result missing");
  }
  const report = assertReportDigest(result.gateReport, "IBM repeated physical series gate report");
  if (report.engineId !== IBM_REPEATED_PHYSICAL_SERIES_GATE_ENGINE_ID
    || report.sourceRevision !== plan.sourceRevision
    || report.sourceTree !== plan.sourceTree
    || report.planSha256 !== plan.planSha256
    || report.provider !== plan.provider
    || report.backendName !== plan.backendName) {
    throw new Error("IBM repeated physical series result binding mismatch");
  }
  return result;
}

function buildSessionReport({ plan, sessionPhase, smokeGateResult, repeatedSeriesResult, verdict, status, reasons }) {
  const smokeReport = smokeGateResult?.gateReport ?? null;
  const repeatedReport = repeatedSeriesResult?.gateReport ?? null;
  const confirmedPhysicalJobCount = repeatedReport?.totalConfirmedPhysicalJobCountIncludingSmoke
    ?? smokeReport?.confirmedPhysicalJobCount
    ?? 0;
  const providerReconciliationRequired = repeatedReport?.providerReconciliationRequired
    ?? smokeReport?.providerReconciliationRequired
    ?? false;
  const unsigned = {
    schemaVersion: 1,
    engineId: ENGINE_ID,
    sourceRevision: plan.sourceRevision,
    sourceTree: plan.sourceTree,
    planSha256: plan.planSha256,
    provider: plan.provider,
    backendName: plan.backendName,
    phase: sessionPhase,
    verdict,
    status,
    reasons: [...new Set(reasons)].sort(),
    smokeGateReportSha256: smokeReport?.reportSha256 ?? null,
    repeatedSeriesGateReportSha256: repeatedReport?.reportSha256 ?? null,
    confirmedPhysicalJobCount,
    smokeVerified: smokeReport?.verdict === "PASS",
    repeatedSeriesComplete: repeatedReport?.repeatedSeriesComplete === true,
    providerReconciliationRequired,
    automaticPhaseChainingAllowed: false,
    quantumAdvantageClaimAllowed: false,
    interpretation: verdict === "PASS"
      ? "PASS_CERTIFIES_PLANNED_IBM_PHYSICAL_SESSION_EVIDENCE_AND_CLASSICAL_COMPARABILITY_NOT_QUANTUM_ADVANTAGE"
      : sessionPhase === EXECUTE_SINGLE_PHYSICAL_SMOKE && smokeReport?.verdict === "PASS"
        ? "SMOKE_VERIFIED_BUT_REPEATED_SERIES_REQUIRES_A_SEPARATE_POST_SMOKE_AUTHORIZATION"
        : verdict === "NOT_TESTED"
          ? "NOT_TESTED_NEVER_CERTIFIES_PHYSICAL_EXECUTION"
          : providerReconciliationRequired
            ? "AMBIGUOUS_PROVIDER_STATE_REQUIRES_EXTERNAL_RECONCILIATION_BEFORE_ANY_FURTHER_PHYSICAL_JOB"
            : "NON_PASS_BLOCKS_PHYSICAL_SESSION_CERTIFICATION",
  };
  return freeze({ ...unsigned, sessionSha256: canonicalQuantumSha256(unsigned) });
}

function createCoordinator({ plan, smokeGate, repeatedSeriesGate }) {
  const checkedPlan = validatePhysicalQpuFirstRunPlan(plan);
  const checkedSmokeGate = assertGate(smokeGate, IBM_PHYSICAL_QPU_SMOKE_GATE_ENGINE_ID, "IBM smoke");
  const checkedRepeatedGate = assertGate(
    repeatedSeriesGate,
    IBM_REPEATED_PHYSICAL_SERIES_GATE_ENGINE_ID,
    "IBM repeated series",
  );

  return freeze({
    engineId: ENGINE_ID,
    async run({
      sessionPhase = PREPARE_ONLY,
      physicalRequest = null,
      baselineProfile = null,
      smokeAuthorizationRecord = null,
      repeatedSeriesAuthorizationRecord = null,
      priorSmokeGateResult = null,
    } = {}) {
      const normalizedPhase = phase(sessionPhase);

      if (normalizedPhase === PREPARE_ONLY) {
        if (smokeAuthorizationRecord !== null
          || repeatedSeriesAuthorizationRecord !== null
          || priorSmokeGateResult !== null) {
          throw new Error("PREPARE_ONLY cannot carry live authorization or prior smoke evidence");
        }
        const smokeGateResult = await checkedSmokeGate.run({ executionAuthorization: PREPARE_ONLY });
        return freeze({
          schemaVersion: 1,
          engineId: ENGINE_ID,
          smokeGateResult,
          repeatedSeriesResult: null,
          sessionReport: buildSessionReport({
            plan: checkedPlan,
            sessionPhase: normalizedPhase,
            smokeGateResult,
            repeatedSeriesResult: null,
            verdict: "NOT_TESTED",
            status: "IBM_PHYSICAL_SESSION_PREPARED_NOT_AUTHORIZED",
            reasons: ["PHYSICAL_QPU_EXECUTION_NOT_PERFORMED"],
          }),
        });
      }

      if (normalizedPhase === EXECUTE_SINGLE_PHYSICAL_SMOKE) {
        if (smokeAuthorizationRecord === null) throw new Error("single physical smoke requires smoke authorization record");
        if (repeatedSeriesAuthorizationRecord !== null || priorSmokeGateResult !== null) {
          throw new Error("single physical smoke phase cannot pre-authorize or chain the repeated series");
        }
        const smokeGateResult = await checkedSmokeGate.run({
          physicalRequest,
          executionAuthorization: GATE_EXECUTE_AUTHORIZATION,
          authorizationRecord: smokeAuthorizationRecord,
        });
        const smokeReport = smokeGateResult?.gateReport;
        const smokePassed = smokeReport?.verdict === "PASS";
        if (smokePassed) assertVerifiedSmokeResult(smokeGateResult, checkedPlan);
        const reconciliationRequired = smokeReport?.providerReconciliationRequired === true;
        return freeze({
          schemaVersion: 1,
          engineId: ENGINE_ID,
          smokeGateResult,
          repeatedSeriesResult: null,
          sessionReport: buildSessionReport({
            plan: checkedPlan,
            sessionPhase: normalizedPhase,
            smokeGateResult,
            repeatedSeriesResult: null,
            verdict: smokePassed ? "INCONCLUSIVE" : (smokeReport?.verdict ?? "FAIL"),
            status: smokePassed
              ? "SINGLE_PHYSICAL_SMOKE_VERIFIED_REPEATED_SERIES_AWAITING_SEPARATE_AUTHORIZATION"
              : reconciliationRequired
                ? "SMOKE_PROVIDER_RECONCILIATION_REQUIRED"
                : "SINGLE_PHYSICAL_SMOKE_NOT_CERTIFIED",
            reasons: smokePassed
              ? ["REPEATED_PHYSICAL_SERIES_NOT_YET_SEPARATELY_AUTHORIZED"]
              : (smokeReport?.reasons ?? ["SMOKE_GATE_RESULT_INVALID"]),
          }),
        });
      }

      if (smokeAuthorizationRecord !== null) {
        throw new Error("repeated physical series phase must use its separate post-smoke authorization only");
      }
      if (repeatedSeriesAuthorizationRecord === null) {
        throw new Error("repeated physical series requires separate authorization record");
      }
      const verifiedSmoke = assertVerifiedSmokeResult(priorSmokeGateResult, checkedPlan);
      const repeatedSeriesResult = assertRepeatedSeriesResult(
        await checkedRepeatedGate.run({
          physicalRequest,
          baselineProfile,
          smokeGateResult: verifiedSmoke,
          executionAuthorization: GATE_EXECUTE_AUTHORIZATION,
          authorizationRecord: repeatedSeriesAuthorizationRecord,
        }),
        checkedPlan,
      );
      const repeatedReport = repeatedSeriesResult.gateReport;
      return freeze({
        schemaVersion: 1,
        engineId: ENGINE_ID,
        smokeGateResult: verifiedSmoke,
        repeatedSeriesResult,
        sessionReport: buildSessionReport({
          plan: checkedPlan,
          sessionPhase: normalizedPhase,
          smokeGateResult: verifiedSmoke,
          repeatedSeriesResult,
          verdict: repeatedReport.verdict,
          status: repeatedReport.verdict === "PASS"
            ? "PLANNED_IBM_PHYSICAL_SESSION_VERIFIED"
            : "REPEATED_PHYSICAL_SERIES_NOT_CERTIFIED",
          reasons: repeatedReport.reasons ?? [],
        }),
      });
    },
  });
}

export function createIbmPhysicalSessionCoordinator({
  plan,
  apiKey,
  instanceCrn,
  pythonExecutable = "python3",
} = {}) {
  const checkedPlan = validatePhysicalQpuFirstRunPlan(plan);
  return createCoordinator({
    plan: checkedPlan,
    smokeGate: createIbmPhysicalQpuSmokeGate({ plan: checkedPlan, apiKey, instanceCrn, pythonExecutable }),
    repeatedSeriesGate: createIbmRepeatedPhysicalSeriesGate({ plan: checkedPlan, apiKey, instanceCrn, pythonExecutable }),
  });
}

export function createIbmPhysicalSessionCoordinatorForContractTest({ plan, smokeGate, repeatedSeriesGate } = {}) {
  const checkedPlan = validatePhysicalQpuFirstRunPlan(plan);
  if (!TEST_BACKEND_RE.test(checkedPlan.backendName)) {
    throw new Error("contract-test IBM physical session coordinator requires backendName containing 'contract'");
  }
  return createCoordinator({ plan: checkedPlan, smokeGate, repeatedSeriesGate });
}

export const IBM_PHYSICAL_SESSION_COORDINATOR_ENGINE_ID = ENGINE_ID;
export const IBM_PHYSICAL_SESSION_PREPARE_ONLY = PREPARE_ONLY;
export const IBM_PHYSICAL_SESSION_EXECUTE_SMOKE = EXECUTE_SINGLE_PHYSICAL_SMOKE;
export const IBM_PHYSICAL_SESSION_EXECUTE_REPEATED_SERIES = EXECUTE_REPEATED_PHYSICAL_SERIES;
