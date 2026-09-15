import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { buildOptimizationProblemReport } from "../optimization-problem/problem-builder.mjs";
import {
  buildCircuitBinding,
  buildProblemBinding,
  buildQaoaExecutableCircuitIr,
  buildQuantumProblemContract,
  canonicalQuantumSha256,
  validateExecutionReceipt,
  validateQaoaExecutableCircuitIr,
} from "../quantum-runtime/contracts.mjs";
import { SimulatorBackend } from "../quantum-runtime/simulator-backend.mjs";
import { PhysicalQPUBackend } from "../quantum-runtime/physical-qpu-backend.mjs";
import { buildQuantumJudgeComparison } from "../quantum-runtime/quantum-judge-comparison.mjs";

function sha256Text(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }

function promoted(name, rank, value) {
  return {
    decisionId: sha256Text(`qpu-runtime:${name}`), query: `${name} legal`, pageUrl: `/${name}`, priorityRank: rank,
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
      prioritizationReportSha256: sha256Text("qpu-runtime-prioritization"), rankTransitionReportSha256: sha256Text("qpu-runtime-transition"),
      outcomeCalibrationReportSha256: sha256Text("qpu-runtime-calibration"), rankContextReportSha256: sha256Text("qpu-runtime-rank-context"),
      growthAssumptionProfileSha256: sha256Text("qpu-runtime-growth"),
    },
    calibrationContext: {
      exactProfileReady: true, scenarioId: "BASE", growthAssumptionProfileSha256: sha256Text("qpu-runtime-growth"),
      matchedRecordCount: 4, minimumRecords: 3, empiricalErrorStats: {},
      decisionBoundary: "CALIBRATION_QUALIFIES_EVIDENCE_BUT_DOES_NOT_REWRITE_SCENARIO_VALUE",
    },
    summary: { prioritizedCandidateCount: 3, promotedToOptimizationCount: 3, heldForEvidenceCount: 0, heldTransitionCount: 0, heldCalibrationCount: 0 },
    decisions,
    decisionBoundary: "NO_HIDDEN_SCORE_NO_AUTONOMOUS_SITE_ACTION_OPTIMIZATION_BUILDER_MUST_ENFORCE_BUDGET_CAPACITY_DEPENDENCIES_RISK_AND_POLICY",
    warnings: ["NO_RANK_GUARANTEE"],
  };
  return { ...unsigned, reportSha256: canonicalQuantumSha256(unsigned) };
}

function planningProfile(report = decisionReport()) {
  const [alpha, beta, gamma] = report.decisions;
  return {
    schema_version: 1, profile_id: "qpu-runtime-planning", provenance: "controlled synthetic optimization fixture for contract validation only",
    budget_micros: 9, editorial_capacity_units: 4, engineering_capacity_units: 4, risk_capacity_units: 4, maximum_selected: 2,
    planning_items: [
      { decision_id: alpha.decisionId, cost_micros: 6, editorial_units: 1, engineering_units: 1, risk_units: 1, estimate_basis: "ESTIMATED" },
      { decision_id: beta.decisionId, cost_micros: 5, editorial_units: 2, engineering_units: 1, risk_units: 1, estimate_basis: "ESTIMATED" },
      { decision_id: gamma.decisionId, cost_micros: 4, editorial_units: 1, engineering_units: 2, risk_units: 1, estimate_basis: "ESTIMATED" },
    ],
    dependency_edges: [{ decision_id: gamma.decisionId, requires_decision_id: beta.decisionId }], mutex_groups: [],
  };
}

function optimizationProblem() {
  const source = decisionReport();
  return buildOptimizationProblemReport({ decisionReport: source, planningProfile: planningProfile(source) });
}

function baselineProfile(nodeBudget = 1_000) {
  return {
    schema_version: 1, profile_id: "qpu-runtime-classical-reference", provenance: "deterministic branch-and-bound comparison policy",
    maximum_candidates: 16, node_budget: nodeBudget,
    search_order_policy: "DEPENDENCY_TOPOLOGICAL_OBJECTIVE_DESC_PRIORITY_ASC_ID",
    tie_break_policy: "LOWER_COST_THEN_RISK_THEN_EDITORIAL_THEN_ENGINEERING_THEN_FEWER_SELECTED_THEN_IDENTITY",
  };
}

function experimentProfile() {
  return {
    schema_version: 1, profile_id: "qpu-runtime-statevector", provenance: "deterministic simulator contract fixture; not physical QPU evidence",
    backend_kind: "STATEVECTOR_QAOA_SIMULATOR", maximum_qubits: 8,
    parameter_selection_policy: "MAX_EXPECTED_HAMILTONIAN_THEN_FEASIBLE_MASS_THEN_ID",
    candidate_readout_policy: "MOST_PROBABLE_FEASIBLE_STATE_THEN_LOWEST_BASIS_INDEX",
    parameter_sets: [
      { parameter_set_id: "p1", gamma_microradians: [500_000], beta_microradians: [300_000] },
      { parameter_set_id: "p2", gamma_microradians: [1_000_000], beta_microradians: [600_000] },
      { parameter_set_id: "p3", gamma_microradians: [1_500_000], beta_microradians: [900_000] },
    ],
  };
}

function physicalBindings(problem = optimizationProblem()) {
  const problemBinding = buildProblemBinding(problem);
  const problemContract = buildQuantumProblemContract(problem);
  const circuitPayload = buildQaoaExecutableCircuitIr({
    optimizationProblemReport: problem,
    problemBinding,
    problemContract,
    parameterSetId: "contract-p1",
    gammaMicroradians: [500_000],
    betaMicroradians: [300_000],
  });
  const circuitBinding = buildCircuitBinding({
    problemBinding, circuitId: "contract-qaoa-v1", circuitFormat: circuitPayload.irKind,
    logicalQubitCount: circuitPayload.logicalQubitCount,
    circuitSha256: circuitPayload.circuitSha256,
    parameterBindingSha256: circuitPayload.parameterBindingSha256,
    measurementBitOrder: circuitPayload.measurementBitOrder,
  });
  return { problemBinding, problemContract, circuitBinding, circuitPayload };
}

function providerEvidence({ provider, backendDevice, jobId, adapterId, problemBinding, circuitBinding, shots, calibrationStatus = "PROVIDER_NOT_EXPOSED", wrongCircuit = false, transpiledCircuitCaptured = true }) {
  const captured = calibrationStatus === "CAPTURED";
  return {
    provider, backendDevice, jobId, status: "SUCCEEDED",
    timestamps: { submittedAt: "2026-09-15T07:00:00Z", startedAt: "2026-09-15T07:00:02Z", completedAt: "2026-09-15T07:00:03Z" },
    timing: { queueTimeMillis: 2_000, executionTimeMillis: 1_000, providerReportedTotalMillis: 3_000 },
    shotsRequested: shots, shotsCompleted: shots,
    problemBindingSha256: problemBinding.bindingSha256,
    optimizationProblemReportSha256: problemBinding.optimizationProblemReportSha256,
    optimizationModelSha256: problemBinding.optimizationModelSha256,
    circuitSha256: wrongCircuit ? sha256Text("wrong-circuit") : circuitBinding.circuitSha256,
    transpilationApplied: true, transpiledCircuitSha256: transpiledCircuitCaptured ? sha256Text(`${provider}-transpiled-contract-fixture`) : null,
    calibrationEvidence: {
      status: calibrationStatus,
      calibrationId: captured ? `${provider}-cal-1` : null,
      capturedAt: captured ? "2026-09-15T06:59:00Z" : null,
      providerReportedAt: "2026-09-15T07:00:03Z",
      metadataSha256: captured ? sha256Text(`${provider}-calibration`) : null,
    },
    rawResultSha256: sha256Text(`${provider}-raw-contract-fixture`),
    measurementCounts: shots === 100 ? { "000": 20, "010": 50, "110": 30 } : { "000": shots },
    hardwareIdentity: {
      manufacturer: provider, deviceId: backendDevice, deviceType: "QPU", topologySha256: null,
      capabilitiesSha256: sha256Text(`${provider}-capabilities-contract-fixture`),
    },
    providerReceiptSha256: sha256Text(`${provider}-receipt-contract-fixture`),
    reproducibilityMetadata: {
      adapterId, adapterVersion: "1.0.0", providerSdk: `${provider}-sdk`, providerSdkVersion: "contract-fixture",
      compiler: `${provider}-compiler`, compilerVersion: "contract-fixture", seed: null,
    },
  };
}

test("QuantumProblemContract and ProblemBinding are hash-bound to the exact Optimization Problem Builder output", () => {
  const problem = optimizationProblem();
  const binding = buildProblemBinding(problem);
  const contract = buildQuantumProblemContract(problem);
  assert.equal(contract.optimizationProblemReportSha256, problem.reportSha256);
  assert.equal(contract.optimizationModelSha256, problem.summary.modelSha256);
  assert.equal(contract.problemBindingSha256, binding.bindingSha256);
  assert.equal(contract.decisionVariableCount, 3);
  const tampered = structuredClone(problem);
  tampered.model.variables[0].objectiveCoefficient += 1;
  assert.throws(() => buildQuantumProblemContract(tampered), /hash mismatch/);
});

test("provider-neutral QAOA IR carries executable cost and mixer semantics bound to original constraints", () => {
  const problem = optimizationProblem();
  const bindings = physicalBindings(problem);
  const ir = validateQaoaExecutableCircuitIr(bindings.circuitPayload);
  assert.equal(ir.logicalQubitCount, 3);
  assert.equal(ir.basisScoresPpm.length, 8);
  assert.equal(ir.basisScoresPpm[1], 666_666);
  assert.equal(ir.basisScoresPpm[3], -1_000_000);
  assert.equal(ir.basisScoresPpm[4], -1_000_000);
  assert.equal(ir.basisScoresPpm[6], 1_000_000);
  assert.deepEqual(ir.operations.map((row) => row.operation), ["HADAMARD_ALL", "DIAGONAL_COST_PHASE", "X_MIXER_ALL", "MEASURE_ALL"]);
  assert.equal(ir.circuitSha256, bindings.circuitBinding.circuitSha256);
  const rebuilt = physicalBindings(problem).circuitPayload;
  assert.deepEqual(ir, rebuilt);
});

test("SimulatorBackend executes existing QAOA V1 through the same executable circuit contract without hardware claims", async () => {
  const problem = optimizationProblem();
  const execution = await new SimulatorBackend().execute({ optimizationProblemReport: problem, baselineProfile: baselineProfile(), experimentProfile: experimentProfile() });
  assert.equal(execution.verdict, "PASS");
  assert.equal(execution.backendFamily, "SIMULATOR");
  assert.equal(execution.executionReceipt.hardwareExecution, false);
  assert.equal(execution.executionReceipt.providerReceiptSha256, null);
  assert.equal(execution.executionReceipt.hardwareIdentity, null);
  assert.equal(execution.problemContract.optimizationProblemReportSha256, problem.reportSha256);
  assert.equal(execution.circuitBinding.problemBindingSha256, execution.problemBinding.bindingSha256);
  assert.equal(execution.circuitPayload.circuitSha256, execution.circuitBinding.circuitSha256);
  assert.equal(execution.circuitPayload.irKind, "NEXUS_QAOA_EXECUTABLE_IR_V1");
  assert.equal(execution.candidate.simulatorQuantumAdvantageClaimAllowed, false);
});

test("QuantumJudgeComparison accepts verified simulator evidence but still forbids quantum advantage claims", async () => {
  const problem = optimizationProblem();
  const execution = await new SimulatorBackend().execute({ optimizationProblemReport: problem, baselineProfile: baselineProfile(), experimentProfile: experimentProfile() });
  const judged = buildQuantumJudgeComparison({ optimizationProblemReport: problem, baselineProfile: baselineProfile(), quantumExecution: execution });
  assert.equal(judged.verdict, "PASS");
  assert.equal(judged.quantumAdvantageClaimAllowed, false);
  assert.match(judged.interpretation, /NOT_THAT_QUANTUM_ADVANTAGE_EXISTS/);
  assert.equal(judged.executionReceiptSha256, execution.executionReceipt.receiptSha256);
  assert.equal(judged.circuitPayloadSha256, execution.circuitPayload.circuitSha256);
});

test("PhysicalQPUBackend without a real provider executor blocks physical certification", async () => {
  const problem = optimizationProblem();
  const bindings = physicalBindings(problem);
  const backend = new PhysicalQPUBackend({ provider: "EXTERNAL_QPU_PROVIDER_REQUIRED", adapterId: "NEXUS_EXTERNAL_QPU_ADAPTER_PENDING_V1", executor: null });
  const execution = await backend.execute({ optimizationProblemReport: problem, ...bindings, shots: 100 });
  assert.equal(execution.verdict, "NOT_TESTED");
  assert.equal(execution.executionReceipt, null);
  assert.equal(execution.candidate, null);
  assert.equal(execution.circuitPayload.circuitSha256, bindings.circuitPayload.circuitSha256);
  const judged = buildQuantumJudgeComparison({ optimizationProblemReport: problem, baselineProfile: baselineProfile(), quantumExecution: execution });
  assert.equal(judged.verdict, "NOT_TESTED");
  assert.equal(judged.status, "BLOCKED_PHYSICAL_EXECUTION_NOT_PERFORMED");
  assert.equal(judged.quantumAdvantageClaimAllowed, false);
});

test("PhysicalQPUBackend rejects simulator/mock/test identities when an executor is configured", () => {
  for (const provider of ["statevector-provider", "mock-provider", "test_provider"]) {
    assert.throws(() => new PhysicalQPUBackend({ provider, adapterId: "NEXUS_QPU_ADAPTER_V1", executor: async () => ({}) }), /real provider identity/);
  }
});

test("physical executor receives the actual provider-neutral circuit payload and evidence binds it", async () => {
  const problem = optimizationProblem();
  const bindings = physicalBindings(problem);
  const adapterId = "NEXUS_PROVIDER_ALPHA_QPU_ADAPTER_V1";
  let observedPayload = null;
  const backend = new PhysicalQPUBackend({
    provider: "provider-alpha", adapterId,
    executor: async ({ problemBinding, circuitBinding, circuitPayload, shots }) => {
      observedPayload = circuitPayload;
      return providerEvidence({ provider: "provider-alpha", backendDevice: "qpu-alpha-7", jobId: "job-alpha-0001", adapterId, problemBinding, circuitBinding, shots });
    },
  });
  const execution = await backend.execute({ optimizationProblemReport: problem, ...bindings, shots: 100 });
  assert.equal(execution.verdict, "INCONCLUSIVE");
  assert.ok(execution.reasonCodes.includes("CALIBRATION_METADATA_NOT_CAPTURED"));
  assert.equal(observedPayload.circuitSha256, bindings.circuitPayload.circuitSha256);
  assert.equal(observedPayload.basisScoresPpm.length, 8);
  assert.equal(execution.executionReceipt.shotsCompleted, 100);
  assert.equal(execution.executionReceipt.optimizationProblemReportSha256, problem.reportSha256);
  assert.equal(execution.executionReceipt.optimizationModelSha256, problem.summary.modelSha256);
  assert.equal(validateExecutionReceipt(execution.executionReceipt).receiptSha256, execution.executionReceipt.receiptSha256);
  const judged = buildQuantumJudgeComparison({ optimizationProblemReport: problem, baselineProfile: baselineProfile(), quantumExecution: execution });
  assert.equal(judged.verdict, "INCONCLUSIVE");
  assert.equal(judged.quantumAdvantageClaimAllowed, false);
  assert.equal(judged.candidate.objectiveValueDecimal, "8");
  assert.equal(judged.candidate.candidateSource, "PHYSICAL_QPU_MEASUREMENT_COUNTS");
});

test("provider-side transpilation without retrievable circuit bytes remains INCONCLUSIVE", async () => {
  const problem = optimizationProblem();
  const bindings = physicalBindings(problem);
  const adapterId = "NEXUS_PROVIDER_THETA_QPU_ADAPTER_V1";
  const backend = new PhysicalQPUBackend({
    provider: "provider-theta", adapterId,
    executor: async ({ problemBinding, circuitBinding, shots }) => providerEvidence({
      provider: "provider-theta", backendDevice: "qpu-theta-1", jobId: "job-theta-1", adapterId,
      problemBinding, circuitBinding, shots, calibrationStatus: "CAPTURED", transpiledCircuitCaptured: false,
    }),
  });
  const execution = await backend.execute({ optimizationProblemReport: problem, ...bindings, shots: 100 });
  assert.equal(execution.verdict, "INCONCLUSIVE");
  assert.equal(execution.executionReceipt.transpilationApplied, true);
  assert.equal(execution.executionReceipt.transpiledCircuitSha256, null);
  assert.deepEqual(execution.reasonCodes, ["TRANSPILED_CIRCUIT_NOT_CAPTURED"]);

  const promoted = structuredClone(execution);
  promoted.verdict = "PASS";
  promoted.reasonCodes = ["PHYSICAL_QPU_EXECUTION_RECEIPT_VERIFIED"];
  const judged = buildQuantumJudgeComparison({ optimizationProblemReport: problem, baselineProfile: baselineProfile(), quantumExecution: promoted });
  assert.equal(judged.verdict, "INCONCLUSIVE");
  assert.ok(judged.reasons.includes("TRANSPILED_CIRCUIT_NOT_CAPTURED"));
});

test("a transpiled circuit hash without a transpilation claim fails closed", async () => {
  const problem = optimizationProblem();
  const bindings = physicalBindings(problem);
  const adapterId = "NEXUS_PROVIDER_IOTA_QPU_ADAPTER_V1";
  const backend = new PhysicalQPUBackend({
    provider: "provider-iota", adapterId,
    executor: async ({ problemBinding, circuitBinding, shots }) => {
      const evidence = providerEvidence({
        provider: "provider-iota", backendDevice: "qpu-iota-1", jobId: "job-iota-1", adapterId,
        problemBinding, circuitBinding, shots, calibrationStatus: "CAPTURED",
      });
      evidence.transpilationApplied = false;
      return evidence;
    },
  });
  const execution = await backend.execute({ optimizationProblemReport: problem, ...bindings, shots: 100 });
  assert.equal(execution.verdict, "FAIL");
  assert.deepEqual(execution.reasonCodes, ["PHYSICAL_QPU_PROVIDER_EVIDENCE_INVALID"]);
  assert.equal(execution.executionReceipt, null);
});

test("tampered executable circuit payload is rejected before a provider executor can run", async () => {
  const problem = optimizationProblem();
  const bindings = physicalBindings(problem);
  const tampered = structuredClone(bindings.circuitPayload);
  tampered.basisScoresPpm[1] += 1;
  let called = false;
  const backend = new PhysicalQPUBackend({
    provider: "provider-delta", adapterId: "NEXUS_PROVIDER_DELTA_QPU_ADAPTER_V1",
    executor: async () => { called = true; return {}; },
  });
  await assert.rejects(
    () => backend.execute({ optimizationProblemReport: problem, ...bindings, circuitPayload: tampered, shots: 100 }),
    /score table hash mismatch|circuit hash mismatch|semantic reconstruction mismatch/,
  );
  assert.equal(called, false);
});

test("physical provider evidence fails closed on circuit or problem binding drift", async () => {
  const problem = optimizationProblem();
  const bindings = physicalBindings(problem);
  const adapterId = "NEXUS_PROVIDER_BETA_QPU_ADAPTER_V1";
  const backend = new PhysicalQPUBackend({
    provider: "provider-beta", adapterId,
    executor: async ({ problemBinding, circuitBinding, shots }) => providerEvidence({ provider: "provider-beta", backendDevice: "qpu-beta-1", jobId: "job-beta-1", adapterId, problemBinding, circuitBinding, shots, calibrationStatus: "CAPTURED", wrongCircuit: true }),
  });
  const execution = await backend.execute({ optimizationProblemReport: problem, ...bindings, shots: 100 });
  assert.equal(execution.verdict, "FAIL");
  assert.deepEqual(execution.reasonCodes, ["PHYSICAL_QPU_PROVIDER_EVIDENCE_INVALID"]);
  assert.equal(execution.executionReceipt, null);
});

test("malformed physical receipt metadata becomes structured failure instead of escaping validation", async () => {
  const problem = optimizationProblem();
  const bindings = physicalBindings(problem);
  const adapterId = "NEXUS_PROVIDER_EPSILON_QPU_ADAPTER_V1";
  const backend = new PhysicalQPUBackend({
    provider: "provider-epsilon", adapterId,
    executor: async ({ problemBinding, circuitBinding, shots }) => {
      const evidence = providerEvidence({ provider: "provider-epsilon", backendDevice: "qpu-epsilon-1", jobId: "job-epsilon-1", adapterId, problemBinding, circuitBinding, shots, calibrationStatus: "CAPTURED" });
      evidence.timestamps.startedAt = "2026-09-15T06:59:59Z";
      return evidence;
    },
  });
  const execution = await backend.execute({ optimizationProblemReport: problem, ...bindings, shots: 100 });
  assert.equal(execution.verdict, "FAIL");
  assert.deepEqual(execution.reasonCodes, ["PHYSICAL_QPU_PROVIDER_EVIDENCE_INVALID"]);
  assert.equal(execution.executionReceipt, null);
});

test("WALLE recomputes physical evidence limitations instead of trusting a promoted backend verdict", async () => {
  const problem = optimizationProblem();
  const bindings = physicalBindings(problem);
  const adapterId = "NEXUS_PROVIDER_GAMMA_QPU_ADAPTER_V1";
  const backend = new PhysicalQPUBackend({
    provider: "provider-gamma", adapterId,
    executor: async ({ problemBinding, circuitBinding, shots }) => providerEvidence({ provider: "provider-gamma", backendDevice: "qpu-gamma-1", jobId: "job-gamma-1", adapterId, problemBinding, circuitBinding, shots }),
  });
  const execution = await backend.execute({ optimizationProblemReport: problem, ...bindings, shots: 64 });
  assert.equal(execution.verdict, "INCONCLUSIVE");
  const promoted = structuredClone(execution);
  promoted.verdict = "PASS";
  promoted.reasonCodes = ["PHYSICAL_QPU_EXECUTION_RECEIPT_VERIFIED"];
  const judged = buildQuantumJudgeComparison({ optimizationProblemReport: problem, baselineProfile: baselineProfile(), quantumExecution: promoted });
  assert.equal(judged.verdict, "INCONCLUSIVE");
  assert.ok(judged.reasons.includes("CALIBRATION_METADATA_NOT_CAPTURED"));
});

test("classical baseline uncertainty keeps a valid simulator comparison INCONCLUSIVE", async () => {
  const problem = optimizationProblem();
  const execution = await new SimulatorBackend().execute({ optimizationProblemReport: problem, baselineProfile: baselineProfile(1), experimentProfile: experimentProfile() });
  const judged = buildQuantumJudgeComparison({ optimizationProblemReport: problem, baselineProfile: baselineProfile(1), quantumExecution: execution });
  assert.equal(judged.verdict, "INCONCLUSIVE");
  assert.equal(judged.status, "CLASSICAL_BASELINE_NOT_PROVEN_OPTIMAL");
  assert.equal(judged.quantumAdvantageClaimAllowed, false);
});
