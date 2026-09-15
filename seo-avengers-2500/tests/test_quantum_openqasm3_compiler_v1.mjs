import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { buildOptimizationProblemReport } from "../optimization-problem/problem-builder.mjs";
import {
  buildProblemBinding,
  buildQaoaExecutableCircuitIr,
  buildQuantumProblemContract,
  buildQaoaGateSequence,
  buildWalshScoreTerms,
  canonicalQuantumSha256,
  compileQaoaExecutableCircuitToOpenQasm3,
  validateCompiledOpenQasm3,
} from "../quantum-runtime/contracts.mjs";

function sha256Text(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }

function promoted(name, rank, value) {
  return {
    decisionId: sha256Text(`openqasm:${name}`), query: `${name} legal`, pageUrl: `/${name}`, priorityRank: rank,
    paretoLayer: 1, paretoFrontier: true,
    selectedTarget: { rankTarget: "TOP_3", feasibilityBand: "MEDIUM", gapMilli: 5_000 },
    economicObjective: { id: "INCREMENTAL_REVENUE_MICROS", scenarioValue: value },
    empiricalTransition: { horizonMs: 2_592_000_000, status: "EMPIRICAL_TRANSITION_FREQUENCY_READY", successCount: 3, sampleCount: 5, distinctOpportunityCount: 3, empiricalProbabilityPpm: 600_000 },
    exactGrowthProfileCalibrationReady: true, optimizationEligibility: "PROMOTE_TO_OPTIMIZATION", reasons: [],
  };
}

function decisionReport() {
  const decisions = [promoted("alpha", 1, 10), promoted("beta", 2, 8), promoted("gamma", 3, 7)];
  const unsigned = {
    schemaVersion: 1,
    engineId: "WALLE_DECISION_ENGINE_V1",
    status: "DECISION_READY",
    interpretation: "EVIDENCE_GATED_OPTIMIZATION_ELIGIBILITY_NOT_AUTONOMOUS_ACTION_OR_OUTCOME_FORECAST",
    decisionPolicyId: "PROMOTE_ONLY_WITH_PRIORITIZATION_EMPIRICAL_TRANSITION_AND_EXACT_PROFILE_CALIBRATION",
    inputs: {
      prioritizationReportSha256: sha256Text("openqasm-prioritization"),
      rankTransitionReportSha256: sha256Text("openqasm-transition"),
      outcomeCalibrationReportSha256: sha256Text("openqasm-calibration"),
      rankContextReportSha256: sha256Text("openqasm-rank-context"),
      growthAssumptionProfileSha256: sha256Text("openqasm-growth"),
    },
    calibrationContext: {
      exactProfileReady: true,
      scenarioId: "BASE",
      growthAssumptionProfileSha256: sha256Text("openqasm-growth"),
      matchedRecordCount: 4,
      minimumRecords: 3,
      empiricalErrorStats: {},
      decisionBoundary: "CALIBRATION_QUALIFIES_EVIDENCE_BUT_DOES_NOT_REWRITE_SCENARIO_VALUE",
    },
    summary: { prioritizedCandidateCount: 3, promotedToOptimizationCount: 3, heldForEvidenceCount: 0, heldTransitionCount: 0, heldCalibrationCount: 0 },
    decisions,
    decisionBoundary: "NO_HIDDEN_SCORE_NO_AUTONOMOUS_SITE_ACTION_OPTIMIZATION_BUILDER_MUST_ENFORCE_BUDGET_CAPACITY_DEPENDENCIES_RISK_AND_POLICY",
    warnings: ["NO_RANK_GUARANTEE"],
  };
  return { ...unsigned, reportSha256: canonicalQuantumSha256(unsigned) };
}

function optimizationProblem() {
  const report = decisionReport();
  const [alpha, beta, gamma] = report.decisions;
  const planningProfile = {
    schema_version: 1,
    profile_id: "openqasm-planning",
    provenance: "controlled deterministic compiler contract fixture",
    budget_micros: 9,
    editorial_capacity_units: 4,
    engineering_capacity_units: 4,
    risk_capacity_units: 4,
    maximum_selected: 2,
    planning_items: [
      { decision_id: alpha.decisionId, cost_micros: 6, editorial_units: 1, engineering_units: 1, risk_units: 1, estimate_basis: "ESTIMATED" },
      { decision_id: beta.decisionId, cost_micros: 5, editorial_units: 2, engineering_units: 1, risk_units: 1, estimate_basis: "ESTIMATED" },
      { decision_id: gamma.decisionId, cost_micros: 4, editorial_units: 1, engineering_units: 2, risk_units: 1, estimate_basis: "ESTIMATED" },
    ],
    dependency_edges: [{ decision_id: gamma.decisionId, requires_decision_id: beta.decisionId }],
    mutex_groups: [],
  };
  return buildOptimizationProblemReport({ decisionReport: report, planningProfile });
}

function executableIr() {
  const problem = optimizationProblem();
  const problemBinding = buildProblemBinding(problem);
  const problemContract = buildQuantumProblemContract(problem);
  return buildQaoaExecutableCircuitIr({
    optimizationProblemReport: problem,
    problemBinding,
    problemContract,
    parameterSetId: "openqasm-p1",
    gammaMicroradians: [500_000],
    betaMicroradians: [300_000],
  });
}

function parity(value) {
  let bits = value;
  let result = 0;
  while (bits) { result ^= bits & 1; bits >>>= 1; }
  return result;
}

test("Walsh score terms exactly reconstruct every QAOA basis score", () => {
  const ir = executableIr();
  const terms = buildWalshScoreTerms(ir);
  const commonDenominator = BigInt((1 << ir.logicalQubitCount) * 1_000_000);
  assert.ok(terms.some((term) => term.subsetMask === 0));
  for (let state = 0; state < ir.basisScoresPpm.length; state += 1) {
    let reconstructedNumerator = 0n;
    for (const term of terms) {
      const numerator = BigInt(term.coefficient.numerator);
      const denominator = BigInt(term.coefficient.denominator);
      assert.equal(commonDenominator % denominator, 0n);
      const signed = parity(state & term.subsetMask) ? -numerator : numerator;
      reconstructedNumerator += signed * (commonDenominator / denominator);
    }
    assert.equal(reconstructedNumerator, BigInt(ir.basisScoresPpm[state]) * BigInt(1 << ir.logicalQubitCount));
  }
});

test("OpenQASM 3 lowering is deterministic, source-bound, and preserves gate semantics", () => {
  const ir = executableIr();
  const gates = buildQaoaGateSequence(ir);
  const compiled = compileQaoaExecutableCircuitToOpenQasm3(ir);
  const rebuilt = compileQaoaExecutableCircuitToOpenQasm3(ir);
  assert.deepEqual(compiled, rebuilt);
  assert.equal(compiled.sourceCircuitSha256, ir.circuitSha256);
  assert.equal(compiled.logicalQubitCount, ir.logicalQubitCount);
  assert.equal(compiled.measurementBitOrder, "QUBIT_0_RIGHTMOST");
  assert.equal(compiled.gateCount, gates.length);
  assert.equal(compiled.twoQubitGateCount, gates.filter((gate) => gate.gate === "CX").length);
  assert.match(compiled.qasm3, /^OPENQASM 3\.0;/);
  assert.match(compiled.qasm3, /include "stdgates\.inc";/);
  assert.match(compiled.qasm3, /h q\[0\];/);
  assert.match(compiled.qasm3, /cx q\[/);
  assert.match(compiled.qasm3, /rz\(/);
  assert.match(compiled.qasm3, /rx\(/);
  assert.match(compiled.qasm3, /c\[0\] = measure q\[0\];/);
  assert.equal(validateCompiledOpenQasm3(compiled, ir).compilationSha256, compiled.compilationSha256);

  const firstMixer = gates.find((gate) => gate.gate === "RX");
  assert.deepEqual(firstMixer.angle, { numerator: "3", denominator: "5" });
  assert.equal(gates.filter((gate) => gate.gate === "MEASURE").length, ir.logicalQubitCount);
});

test("compiled OpenQASM evidence fails closed on byte tampering", () => {
  const ir = executableIr();
  const compiled = structuredClone(compileQaoaExecutableCircuitToOpenQasm3(ir));
  compiled.qasm3 = compiled.qasm3.replace("h q[0];", "x q[0];");
  assert.throws(() => validateCompiledOpenQasm3(compiled, ir), /artifact mismatch/);
});
