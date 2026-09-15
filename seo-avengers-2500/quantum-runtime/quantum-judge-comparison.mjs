import { buildClassicalBaselineReport } from "../classical-baseline/baseline-solver.mjs";
import {
  buildProblemBinding,
  canonicalQuantumSha256,
  normalizeMeasurementCounts,
  validateCircuitBinding,
  validateExecutionReceipt,
  validateProblemBinding,
  validateQaoaExecutableCircuitIrAgainstProblem,
  validateQuantumProblemContract,
} from "./contracts.mjs";

function compareStrings(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function decimal(value, label) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must be non-negative decimal string`);
  return BigInt(value);
}

function buildProblemEvaluator(report) {
  const variables = report.model.variables;
  const byId = new Map();
  for (const row of variables) {
    if (byId.has(row.decisionId)) throw new Error("duplicate problem decision identity");
    byId.set(row.decisionId, row);
  }
  const limits = new Map(report.model.constraints.resourceConstraints.map((row) => [row.constraintId, row.limit]));
  for (const id of ["BUDGET_MICROS", "EDITORIAL_CAPACITY_UNITS", "ENGINEERING_CAPACITY_UNITS", "RISK_CAPACITY_UNITS", "MAXIMUM_SELECTED"]) {
    if (!limits.has(id)) throw new Error(`missing constraint:${id}`);
  }

  function evaluate(selectedDecisionIds) {
    if (!Array.isArray(selectedDecisionIds)) throw new Error("selectedDecisionIds must be array");
    if (new Set(selectedDecisionIds).size !== selectedDecisionIds.length) throw new Error("selectedDecisionIds contain duplicates");
    const selectedSet = new Set(selectedDecisionIds);
    let objective = 0n, costMicros = 0, editorialUnits = 0, engineeringUnits = 0, riskUnits = 0;
    for (const id of selectedSet) {
      const row = byId.get(id);
      if (!row) throw new Error("selectedDecisionIds reference unknown variable");
      objective += BigInt(row.objectiveCoefficient);
      costMicros += row.resources.costMicros;
      editorialUnits += row.resources.editorialUnits;
      engineeringUnits += row.resources.engineeringUnits;
      riskUnits += row.resources.riskUnits;
    }
    let feasible = costMicros <= limits.get("BUDGET_MICROS")
      && editorialUnits <= limits.get("EDITORIAL_CAPACITY_UNITS")
      && engineeringUnits <= limits.get("ENGINEERING_CAPACITY_UNITS")
      && riskUnits <= limits.get("RISK_CAPACITY_UNITS")
      && selectedSet.size <= limits.get("MAXIMUM_SELECTED");
    if (feasible) {
      for (const edge of report.model.constraints.dependencyConstraints) {
        if (selectedSet.has(edge.decisionId) && !selectedSet.has(edge.requiresDecisionId)) { feasible = false; break; }
      }
    }
    if (feasible) {
      for (const group of report.model.constraints.mutexConstraints) {
        let count = 0;
        for (const id of group.decisionIds) if (selectedSet.has(id)) count += 1;
        if (count > group.limit) { feasible = false; break; }
      }
    }
    const sortedIds = [...selectedSet].sort(compareStrings);
    return freeze({
      feasible,
      objectiveValueDecimal: objective.toString(),
      selectedDecisionIds: sortedIds,
      selectedSetSha256: canonicalQuantumSha256(sortedIds),
      resourceUsage: { costMicros, editorialUnits, engineeringUnits, riskUnits },
    });
  }
  return freeze({ decisionVariableIds: variables.map((row) => row.decisionId), evaluate });
}

function candidateFromMeasurements(report, circuitBinding, receipt) {
  const evaluator = buildProblemEvaluator(report);
  if (circuitBinding.logicalQubitCount !== evaluator.decisionVariableIds.length) throw new Error("physical circuit qubit count does not match optimization decision count");
  let best = null;
  for (const [bits, count] of Object.entries(receipt.measurementCounts)) {
    const selected = [];
    for (let qubit = 0; qubit < bits.length; qubit += 1) {
      if (bits[bits.length - 1 - qubit] === "1") selected.push(evaluator.decisionVariableIds[qubit]);
    }
    const evaluated = evaluator.evaluate(selected);
    if (!evaluated.feasible) continue;
    const basisIndex = BigInt(`0b${bits}`);
    if (!best || count > best.count || (count === best.count && basisIndex < best.basisIndex)) best = { bits, count, basisIndex, evaluated };
  }
  if (!best) return null;
  return freeze({
    ...best.evaluated,
    measurementBitstring: best.bits,
    measurementCount: best.count,
    measurementProbabilityPpm: Math.floor((best.count * 1_000_000) / receipt.shotsCompleted),
    candidateSource: "PHYSICAL_QPU_MEASUREMENT_COUNTS",
  });
}

function candidateFromSimulator(report, execution) {
  if (!execution.candidate || typeof execution.candidate !== "object") throw new Error("simulator execution missing candidate");
  const checked = buildProblemEvaluator(report).evaluate(execution.candidate.selectedDecisionIds);
  if (!checked.feasible || execution.candidate.feasible !== true) throw new Error("simulator candidate is infeasible");
  if (checked.objectiveValueDecimal !== execution.candidate.objectiveValueDecimal || checked.selectedSetSha256 !== execution.candidate.selectedSetSha256) throw new Error("simulator candidate evidence mismatch");
  return freeze({ ...checked, candidateSource: "STATEVECTOR_QAOA_SIMULATOR" });
}

function comparison(candidate, classical) {
  const classicalObjective = decimal(classical.solution.objectiveValueDecimal, "classical objective");
  const candidateObjective = decimal(candidate.objectiveValueDecimal, "candidate objective");
  if (classical.solution.optimalityProven && candidateObjective > classicalObjective) {
    return freeze({ integrityFailure: true, objectiveComparison: "CANDIDATE_EXCEEDS_PROVEN_CLASSICAL_OPTIMUM", classicalObjectiveValueDecimal: classicalObjective.toString(), candidateObjectiveValueDecimal: candidateObjective.toString() });
  }
  const objectiveComparison = candidateObjective === classicalObjective ? "OBJECTIVE_TIE"
    : candidateObjective < classicalObjective ? "CLASSICAL_OBJECTIVE_BETTER" : "QPU_OBJECTIVE_BETTER_CLASSICAL_NOT_PROVEN";
  return freeze({
    integrityFailure: false,
    objectiveComparison,
    classicalObjectiveValueDecimal: classicalObjective.toString(),
    candidateObjectiveValueDecimal: candidateObjective.toString(),
    candidateToClassicalObjectiveRatioPpm: classicalObjective === 0n ? (candidateObjective === 0n ? 1_000_000 : 0) : Number((candidateObjective * 1_000_000n) / classicalObjective),
    selectedSetEqual: candidate.selectedSetSha256 === classical.solution.selectedSetSha256,
  });
}

export function buildQuantumJudgeComparison({ optimizationProblemReport, baselineProfile, quantumExecution }) {
  const expectedProblemBinding = buildProblemBinding(optimizationProblemReport);
  if (!quantumExecution || typeof quantumExecution !== "object") throw new Error("quantumExecution must be object");
  if (!["PASS", "FAIL", "INCONCLUSIVE", "NOT_TESTED"].includes(quantumExecution.verdict)) throw new Error("quantumExecution verdict invalid");
  if (!Array.isArray(quantumExecution.reasonCodes) || quantumExecution.reasonCodes.some((code) => typeof code !== "string")) throw new Error("quantumExecution reasonCodes invalid");
  const problemBinding = validateProblemBinding(quantumExecution.problemBinding);
  const problemContract = validateQuantumProblemContract(quantumExecution.problemContract);
  const circuitBinding = validateCircuitBinding(quantumExecution.circuitBinding);
  if (problemBinding.bindingSha256 !== expectedProblemBinding.bindingSha256) throw new Error("judge problem binding mismatch");
  if (problemContract.problemBindingSha256 !== problemBinding.bindingSha256) throw new Error("judge problem contract/binding mismatch");
  if (circuitBinding.problemBindingSha256 !== problemBinding.bindingSha256) throw new Error("judge circuit/problem binding mismatch");
  const circuitPayload = validateQaoaExecutableCircuitIrAgainstProblem({
    ir: quantumExecution.circuitPayload,
    optimizationProblemReport,
    problemBinding,
    problemContract,
  });
  if (circuitPayload.circuitSha256 !== circuitBinding.circuitSha256
    || circuitPayload.irKind !== circuitBinding.circuitFormat
    || circuitPayload.logicalQubitCount !== circuitBinding.logicalQubitCount
    || circuitPayload.parameterBindingSha256 !== circuitBinding.parameterBindingSha256
    || circuitPayload.measurementBitOrder !== circuitBinding.measurementBitOrder) throw new Error("judge circuit payload/binding mismatch");

  const classical = buildClassicalBaselineReport({ optimizationProblemReport, baselineProfile });
  if (classical.optimizationProblemReportSha256 !== expectedProblemBinding.optimizationProblemReportSha256
    || classical.optimizationModelSha256 !== expectedProblemBinding.optimizationModelSha256) throw new Error("classical baseline problem binding mismatch");

  const base = {
    schemaVersion: 1,
    engineId: "WALLE_QUANTUM_JUDGE_COMPARISON_V1",
    problemBindingSha256: problemBinding.bindingSha256,
    problemContractSha256: problemContract.contractSha256,
    circuitBindingSha256: circuitBinding.bindingSha256,
    circuitPayloadSha256: circuitPayload.circuitSha256,
    backendFamily: quantumExecution.backendFamily,
    backendAdapterId: quantumExecution.backendAdapterId,
    classicalBaselineReportSha256: classical.reportSha256,
    classicalOptimalityProven: classical.solution.optimalityProven,
    quantumAdvantageClaimAllowed: false,
    quantumAdvantageVerdict: "NOT_DEMONSTRATED_REQUIRES_REPEATED_PHYSICAL_QPU_STATISTICAL_EVIDENCE",
  };

  if (quantumExecution.verdict === "NOT_TESTED") {
    const unsigned = { ...base, verdict: "NOT_TESTED", status: "BLOCKED_PHYSICAL_EXECUTION_NOT_PERFORMED", reasons: [...quantumExecution.reasonCodes], candidate: null, comparison: null, executionReceiptSha256: null, interpretation: "NOT_TESTED_NEVER_CERTIFIES_AS_SUCCESS" };
    return freeze({ ...unsigned, reportSha256: canonicalQuantumSha256(unsigned) });
  }
  if (quantumExecution.verdict === "FAIL" && !quantumExecution.executionReceipt) {
    const unsigned = { ...base, verdict: "FAIL", status: "PROVIDER_EXECUTION_FAILED_BEFORE_VERIFIABLE_RECEIPT", reasons: [...quantumExecution.reasonCodes], candidate: null, comparison: null, executionReceiptSha256: null, interpretation: "FAIL_PRESERVES_NO_SUCCESS_CLAIM" };
    return freeze({ ...unsigned, reportSha256: canonicalQuantumSha256(unsigned) });
  }

  const receipt = validateExecutionReceipt(quantumExecution.executionReceipt);
  if (receipt.backendFamily === "PHYSICAL_QPU") {
    normalizeMeasurementCounts(receipt.measurementCounts, { logicalQubitCount: circuitBinding.logicalQubitCount, shotsCompleted: receipt.shotsCompleted, allowEmpty: receipt.shotsCompleted === 0 });
  }
  if (receipt.problemBindingSha256 !== problemBinding.bindingSha256
    || receipt.optimizationProblemReportSha256 !== problemBinding.optimizationProblemReportSha256
    || receipt.optimizationModelSha256 !== problemBinding.optimizationModelSha256
    || receipt.circuitSha256 !== circuitBinding.circuitSha256
    || receipt.backendFamily !== quantumExecution.backendFamily) {
    const unsigned = { ...base, verdict: "FAIL", status: "EXECUTION_RECEIPT_BINDING_MISMATCH", reasons: [...quantumExecution.reasonCodes, "EXECUTION_RECEIPT_BINDING_MISMATCH"], candidate: null, comparison: null, executionReceiptSha256: receipt.receiptSha256, interpretation: "FAIL_CLOSED_ON_RECEIPT_OR_PROBLEM_BINDING_MISMATCH" };
    return freeze({ ...unsigned, reportSha256: canonicalQuantumSha256(unsigned) });
  }
  if (quantumExecution.verdict === "FAIL") {
    const unsigned = { ...base, verdict: "FAIL", status: "BACKEND_EXECUTION_FAILED_WITH_VERIFIABLE_RECEIPT", reasons: [...quantumExecution.reasonCodes], candidate: null, comparison: null, executionReceiptSha256: receipt.receiptSha256, interpretation: "FAIL_PRESERVES_PROVIDER_RECEIPT_AND_NEVER_PROMOTES_TO_SUCCESS" };
    return freeze({ ...unsigned, reportSha256: canonicalQuantumSha256(unsigned) });
  }

  let candidate;
  if (quantumExecution.backendFamily === "PHYSICAL_QPU") candidate = receipt.status === "SUCCEEDED" ? candidateFromMeasurements(optimizationProblemReport, circuitBinding, receipt) : null;
  else if (quantumExecution.backendFamily === "SIMULATOR") candidate = candidateFromSimulator(optimizationProblemReport, quantumExecution);
  else throw new Error("unsupported judge backend family");

  if (!candidate) {
    const unsigned = { ...base, verdict: "FAIL", status: "NO_FEASIBLE_QUANTUM_CANDIDATE", reasons: [...quantumExecution.reasonCodes, "NO_FEASIBLE_MEASUREMENT"], candidate: null, comparison: null, executionReceiptSha256: receipt.receiptSha256, interpretation: "EXECUTION_EVIDENCE_EXISTS_BUT_NO_FEASIBLE_CANDIDATE_SURVIVES_ORIGINAL_CONSTRAINTS" };
    return freeze({ ...unsigned, reportSha256: canonicalQuantumSha256(unsigned) });
  }

  const compared = comparison(candidate, classical);
  if (compared.integrityFailure) {
    const unsigned = { ...base, verdict: "FAIL", status: "EVIDENCE_INCONSISTENT_WITH_PROVEN_CLASSICAL_OPTIMUM", reasons: [...quantumExecution.reasonCodes, "CANDIDATE_EXCEEDS_PROVEN_CLASSICAL_OPTIMUM"], candidate, comparison: compared, executionReceiptSha256: receipt.receiptSha256, interpretation: "FAIL_CLOSED_ON_CONTRADICTORY_EVIDENCE" };
    return freeze({ ...unsigned, reportSha256: canonicalQuantumSha256(unsigned) });
  }

  const reasons = [...quantumExecution.reasonCodes];
  let verdict = "PASS";
  let status = "COMPARABLE_EXECUTION_EVIDENCE_VERIFIED";
  const physicalLimitations = [];
  if (quantumExecution.backendFamily === "PHYSICAL_QPU") {
    if (receipt.calibrationEvidence.status !== "CAPTURED") physicalLimitations.push("CALIBRATION_METADATA_NOT_CAPTURED");
    if (!receipt.hardwareIdentity?.capabilitiesSha256) physicalLimitations.push("BACKEND_CAPABILITY_SNAPSHOT_NOT_CAPTURED");
    if (receipt.timing.queueTimeMillis === null || receipt.timing.executionTimeMillis === null) physicalLimitations.push("QUEUE_OR_EXECUTION_TIME_NOT_SEPARATED");
    if (receipt.transpilationApplied && !receipt.transpiledCircuitSha256) physicalLimitations.push("TRANSPILED_CIRCUIT_NOT_CAPTURED");
  }
  if (quantumExecution.verdict === "INCONCLUSIVE" || physicalLimitations.length) {
    verdict = "INCONCLUSIVE";
    status = "EXECUTION_VALID_BUT_REQUIRED_HARDWARE_METADATA_INCOMPLETE";
    reasons.push(...physicalLimitations);
  }
  if (!classical.solution.optimalityProven) {
    verdict = "INCONCLUSIVE";
    status = "CLASSICAL_BASELINE_NOT_PROVEN_OPTIMAL";
    reasons.push("CLASSICAL_BASELINE_NOT_PROVEN_OPTIMAL");
  }
  if (quantumExecution.backendFamily === "SIMULATOR") {
    status = verdict === "PASS" ? "SIMULATOR_CONTRACT_AND_COMPARISON_VERIFIED" : status;
    reasons.push("SIMULATOR_ONLY_NO_PHYSICAL_QPU_CLAIM");
  } else {
    reasons.push("SINGLE_PHYSICAL_RUN_CANNOT_ESTABLISH_QUANTUM_ADVANTAGE");
  }

  const unsigned = {
    ...base,
    verdict,
    status,
    reasons: [...new Set(reasons)].sort(compareStrings),
    candidate,
    comparison: compared,
    executionReceiptSha256: receipt.receiptSha256,
    interpretation: verdict === "PASS" ? "PASS_MEANS_EXECUTION_AND_COMPARISON_EVIDENCE_ARE_VALID_NOT_THAT_QUANTUM_ADVANTAGE_EXISTS" : "INCONCLUSIVE_BLOCKS_ADVANTAGE_OR_PRODUCTION_SUPERIORITY_CLAIMS",
  };
  return freeze({ ...unsigned, reportSha256: canonicalQuantumSha256(unsigned) });
}

export const QuantumJudgeComparison = Object.freeze({ build: buildQuantumJudgeComparison });
