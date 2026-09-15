import { canonicalQuantumSha256, freeze, integer } from "./common.mjs";
import { buildProblemBinding } from "./problem-contract.mjs";
import { buildClassicalBaselineReport } from "../classical-baseline/baseline-solver.mjs";
import { buildQuantumJudgeComparison } from "./quantum-judge-comparison.mjs";

const ENGINE_ID = "WALLE_PHYSICAL_QPU_EXPERIMENT_PROTOCOL_V1";
const MAX_RUNS = 256;

function compareStrings(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function sumNullable(values) {
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += integer(value, "aggregate timing value", 0);
    if (!Number.isSafeInteger(total)) throw new Error("aggregate timing overflow");
  }
  return total;
}

function stableIdentity(receipts) {
  if (receipts.length === 0) return { stable: false, provider: null, backendDevice: null, hardwareDeviceId: null, adapterId: null };
  const first = receipts[0];
  const target = {
    provider: first.receipt.provider,
    backendDevice: first.receipt.backendDevice,
    hardwareDeviceId: first.receipt.hardwareIdentity?.deviceId ?? null,
    adapterId: first.execution.backendAdapterId,
  };
  const stable = receipts.every(({ receipt, execution }) => receipt.provider === target.provider
    && receipt.backendDevice === target.backendDevice
    && (receipt.hardwareIdentity?.deviceId ?? null) === target.hardwareDeviceId
    && execution.backendAdapterId === target.adapterId);
  return { stable, ...target };
}

function stableCircuit(receipts) {
  if (receipts.length === 0) return { stable: false, circuitSha256: null, shotsRequested: null };
  const circuitSha256 = receipts[0].execution.circuitPayload.circuitSha256;
  const shotsRequested = receipts[0].receipt.shotsRequested;
  const stable = receipts.every(({ execution, receipt }) => execution.circuitPayload.circuitSha256 === circuitSha256
    && receipt.circuitSha256 === circuitSha256
    && receipt.shotsRequested === shotsRequested);
  return { stable, circuitSha256, shotsRequested };
}

function aggregateObjectives(comparableRuns) {
  if (comparableRuns.length === 0) {
    return freeze({
      runCount: 0,
      minimumCandidateToClassicalObjectiveRatioPpm: null,
      maximumCandidateToClassicalObjectiveRatioPpm: null,
      averageCandidateToClassicalObjectiveRatioPpm: null,
      objectiveTieCount: 0,
      classicalBetterCount: 0,
      qpuBetterClassicalUnprovenCount: 0,
    });
  }
  const ratios = comparableRuns.map(({ judge }) => integer(judge.comparison.candidateToClassicalObjectiveRatioPpm, "candidate/classical ratio", 0));
  const sum = ratios.reduce((acc, value) => acc + BigInt(value), 0n);
  return freeze({
    runCount: comparableRuns.length,
    minimumCandidateToClassicalObjectiveRatioPpm: Math.min(...ratios),
    maximumCandidateToClassicalObjectiveRatioPpm: Math.max(...ratios),
    averageCandidateToClassicalObjectiveRatioPpm: Number(sum / BigInt(ratios.length)),
    objectiveTieCount: comparableRuns.filter(({ judge }) => judge.comparison.objectiveComparison === "OBJECTIVE_TIE").length,
    classicalBetterCount: comparableRuns.filter(({ judge }) => judge.comparison.objectiveComparison === "CLASSICAL_OBJECTIVE_BETTER").length,
    qpuBetterClassicalUnprovenCount: comparableRuns.filter(({ judge }) => judge.comparison.objectiveComparison === "QPU_OBJECTIVE_BETTER_CLASSICAL_NOT_PROVEN").length,
  });
}

export function buildPhysicalQpuExperimentReport({ optimizationProblemReport, baselineProfile, quantumExecutions, minimumCompletedRuns = 5 }) {
  if (!Array.isArray(quantumExecutions)) throw new Error("quantumExecutions must be array");
  if (quantumExecutions.length > MAX_RUNS) throw new Error("physical experiment exceeds 256-run evidence bound");
  const requiredRuns = integer(minimumCompletedRuns, "minimumCompletedRuns", 2, MAX_RUNS);
  const expectedBinding = buildProblemBinding(optimizationProblemReport);
  const classical = buildClassicalBaselineReport({ optimizationProblemReport, baselineProfile });
  if (classical.optimizationProblemReportSha256 !== expectedBinding.optimizationProblemReportSha256
    || classical.optimizationModelSha256 !== expectedBinding.optimizationModelSha256) {
    throw new Error("physical experiment classical baseline/problem binding mismatch");
  }

  const judgedRuns = quantumExecutions.map((execution, index) => {
    if (!execution || typeof execution !== "object" || Array.isArray(execution)) throw new Error(`quantum execution ${index} must be object`);
    const judge = buildQuantumJudgeComparison({ optimizationProblemReport, baselineProfile, quantumExecution: execution });
    if (judge.problemBindingSha256 !== expectedBinding.bindingSha256) throw new Error(`quantum execution ${index} problem binding drift`);
    return { index, execution, judge, receipt: execution.executionReceipt ?? null };
  });

  const physicalRuns = judgedRuns.filter(({ execution }) => execution.backendFamily === "PHYSICAL_QPU");
  const nonPhysicalRuns = judgedRuns.filter(({ execution }) => execution.backendFamily !== "PHYSICAL_QPU");
  const receipts = physicalRuns.filter(({ receipt }) => receipt !== null);
  const succeededReceipts = receipts.filter(({ receipt }) => receipt.status === "SUCCEEDED");
  const comparableRuns = physicalRuns.filter(({ judge, receipt }) => receipt?.status === "SUCCEEDED" && judge.candidate && judge.comparison);

  const jobIds = receipts.map(({ receipt }) => receipt.jobId);
  const duplicateJobIds = [...new Set(jobIds.filter((jobId, index) => jobIds.indexOf(jobId) !== index))].sort(compareStrings);
  const identity = stableIdentity(succeededReceipts);
  const circuit = stableCircuit(succeededReceipts);

  const totalShotsRequested = receipts.reduce((sum, { receipt }) => sum + receipt.shotsRequested, 0);
  const totalShotsCompleted = receipts.reduce((sum, { receipt }) => sum + receipt.shotsCompleted, 0);
  if (!Number.isSafeInteger(totalShotsRequested) || !Number.isSafeInteger(totalShotsCompleted)) throw new Error("physical experiment shot aggregate overflow");
  const totalQueueTimeMillis = sumNullable(receipts.map(({ receipt }) => receipt.timing.queueTimeMillis));
  const totalExecutionTimeMillis = sumNullable(receipts.map(({ receipt }) => receipt.timing.executionTimeMillis));
  const totalProviderReportedMillis = sumNullable(receipts.map(({ receipt }) => receipt.timing.providerReportedTotalMillis));

  const runEvidence = judgedRuns.map(({ index, execution, judge, receipt }) => freeze({
    runIndex: index,
    backendFamily: execution.backendFamily,
    backendAdapterId: execution.backendAdapterId,
    backendVerdict: execution.verdict,
    judgeVerdict: judge.verdict,
    judgeStatus: judge.status,
    judgeReportSha256: judge.reportSha256,
    executionReceiptSha256: judge.executionReceiptSha256,
    circuitPayloadSha256: judge.circuitPayloadSha256,
    provider: receipt?.provider ?? null,
    backendDevice: receipt?.backendDevice ?? null,
    hardwareDeviceId: receipt?.hardwareIdentity?.deviceId ?? null,
    jobId: receipt?.jobId ?? null,
    shotsRequested: receipt?.shotsRequested ?? 0,
    shotsCompleted: receipt?.shotsCompleted ?? 0,
    candidateObjectiveValueDecimal: judge.candidate?.objectiveValueDecimal ?? null,
    candidateToClassicalObjectiveRatioPpm: judge.comparison?.candidateToClassicalObjectiveRatioPpm ?? null,
  }));

  const reasons = [];
  let verdict = "PASS";
  let status = "REPEATED_PHYSICAL_QPU_EVIDENCE_COMPARABLE";

  if (quantumExecutions.length === 0 || (physicalRuns.length > 0 && physicalRuns.every(({ judge }) => judge.verdict === "NOT_TESTED"))) {
    verdict = "NOT_TESTED";
    status = "BLOCKED_PHYSICAL_QPU_EXECUTION_NOT_PERFORMED";
    reasons.push("PHYSICAL_QPU_EXECUTION_NOT_PERFORMED");
  } else if (nonPhysicalRuns.length > 0) {
    verdict = "FAIL";
    status = "NON_PHYSICAL_EXECUTION_IN_PHYSICAL_EXPERIMENT";
    reasons.push("NON_PHYSICAL_EXECUTION_PRESENT");
  } else if (duplicateJobIds.length > 0) {
    verdict = "FAIL";
    status = "DUPLICATE_PROVIDER_JOB_EVIDENCE";
    reasons.push("DUPLICATE_PROVIDER_JOB_ID");
  } else if (judgedRuns.some(({ judge }) => judge.verdict === "FAIL")) {
    verdict = "FAIL";
    status = "PHYSICAL_RUN_EVIDENCE_FAILED_VALIDATION";
    reasons.push("AT_LEAST_ONE_PHYSICAL_RUN_FAILED_VALIDATION");
  } else {
    if (succeededReceipts.length < requiredRuns) reasons.push("INSUFFICIENT_COMPLETED_PHYSICAL_RUNS");
    if (!identity.stable) reasons.push("HARDWARE_IDENTITY_DRIFT_ACROSS_RUNS");
    if (!circuit.stable) reasons.push("CIRCUIT_OR_SHOT_POLICY_DRIFT_ACROSS_RUNS");
    if (judgedRuns.some(({ judge }) => judge.verdict === "INCONCLUSIVE" || judge.verdict === "NOT_TESTED")) reasons.push("AT_LEAST_ONE_RUN_NOT_FULLY_COMPARABLE");
    if (!classical.solution.optimalityProven) reasons.push("CLASSICAL_BASELINE_NOT_PROVEN_OPTIMAL");
    if (reasons.length > 0) {
      verdict = "INCONCLUSIVE";
      status = "REPEATED_PHYSICAL_QPU_EVIDENCE_INCOMPLETE_OR_NOT_CONTROLLED";
    }
  }

  const unsigned = {
    schemaVersion: 1,
    engineId: ENGINE_ID,
    verdict,
    status,
    reasons: [...new Set(reasons)].sort(compareStrings),
    optimizationProblemReportSha256: expectedBinding.optimizationProblemReportSha256,
    optimizationModelSha256: expectedBinding.optimizationModelSha256,
    problemBindingSha256: expectedBinding.bindingSha256,
    classicalBaselineReportSha256: classical.reportSha256,
    classicalOptimalityProven: classical.solution.optimalityProven,
    requiredCompletedPhysicalRuns: requiredRuns,
    submittedRunCount: quantumExecutions.length,
    physicalRunCount: physicalRuns.length,
    receiptCount: receipts.length,
    successfulReceiptCount: succeededReceipts.length,
    comparableRunCount: comparableRuns.length,
    duplicateProviderJobIds: duplicateJobIds,
    controlledIdentity: identity,
    controlledCircuit: circuit,
    resources: {
      totalShotsRequested,
      totalShotsCompleted,
      totalQueueTimeMillis,
      totalExecutionTimeMillis,
      totalProviderReportedMillis,
    },
    objectiveEvidence: aggregateObjectives(comparableRuns),
    runs: runEvidence,
    quantumAdvantageClaimAllowed: false,
    quantumAdvantageVerdict: "NOT_DEMONSTRATED_REPEATED_PHYSICAL_EVIDENCE_PROTOCOL_ONLY",
    interpretation: verdict === "PASS"
      ? "PASS_CERTIFIES_REPEATED_COMPARABLE_PHYSICAL_EXECUTION_EVIDENCE_NOT_QUANTUM_ADVANTAGE"
      : verdict === "NOT_TESTED"
        ? "NOT_TESTED_NEVER_CERTIFIES_AS_SUCCESS"
        : verdict === "FAIL"
          ? "FAIL_BLOCKS_PHYSICAL_EXPERIMENT_CERTIFICATION"
          : "INCONCLUSIVE_BLOCKS_PHYSICAL_SUPERIORITY_OR_ADVANTAGE_CLAIMS",
  };
  return freeze({ ...unsigned, reportSha256: canonicalQuantumSha256(unsigned) });
}

export const PhysicalQpuExperimentProtocol = Object.freeze({ build: buildPhysicalQpuExperimentReport });
