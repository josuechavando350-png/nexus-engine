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
} from "../quantum-runtime/contracts.mjs";
import { PhysicalQPUBackend } from "../quantum-runtime/physical-qpu-backend.mjs";
import { buildPhysicalQpuExperimentReport } from "../quantum-runtime/physical-experiment-protocol.mjs";

function sha256Text(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }

function promoted(name, rank, value) {
  return {
    decisionId: sha256Text(`physical-protocol:${name}`), query: `${name} legal`, pageUrl: `/${name}`, priorityRank: rank,
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
      prioritizationReportSha256: sha256Text("physical-protocol-prioritization"),
      rankTransitionReportSha256: sha256Text("physical-protocol-transition"),
      outcomeCalibrationReportSha256: sha256Text("physical-protocol-calibration"),
      rankContextReportSha256: sha256Text("physical-protocol-rank-context"),
      growthAssumptionProfileSha256: sha256Text("physical-protocol-growth"),
    },
    calibrationContext: {
      exactProfileReady: true,
      scenarioId: "BASE",
      growthAssumptionProfileSha256: sha256Text("physical-protocol-growth"),
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
  const source = decisionReport();
  const [alpha, beta, gamma] = source.decisions;
  const planningProfile = {
    schema_version: 1,
    profile_id: "physical-protocol-planning",
    provenance: "controlled synthetic optimization fixture for physical experiment protocol validation only",
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
  return buildOptimizationProblemReport({ decisionReport: source, planningProfile });
}

function baselineProfile(nodeBudget = 1_000) {
  return {
    schema_version: 1,
    profile_id: "physical-protocol-classical-reference",
    provenance: "deterministic branch-and-bound comparison policy",
    maximum_candidates: 16,
    node_budget: nodeBudget,
    search_order_policy: "DEPENDENCY_TOPOLOGICAL_OBJECTIVE_DESC_PRIORITY_ASC_ID",
    tie_break_policy: "LOWER_COST_THEN_RISK_THEN_EDITORIAL_THEN_ENGINEERING_THEN_FEWER_SELECTED_THEN_IDENTITY",
  };
}

function bindings(problem = optimizationProblem(), gammaMicroradians = [500_000]) {
  const problemBinding = buildProblemBinding(problem);
  const problemContract = buildQuantumProblemContract(problem);
  const circuitPayload = buildQaoaExecutableCircuitIr({
    optimizationProblemReport: problem,
    problemBinding,
    problemContract,
    parameterSetId: `physical-protocol-${gammaMicroradians.join("-")}`,
    gammaMicroradians,
    betaMicroradians: gammaMicroradians.map(() => 300_000),
  });
  const circuitBinding = buildCircuitBinding({
    problemBinding,
    circuitId: `physical-protocol-qaoa-${gammaMicroradians.join("-")}`,
    circuitFormat: circuitPayload.irKind,
    logicalQubitCount: circuitPayload.logicalQubitCount,
    circuitSha256: circuitPayload.circuitSha256,
    parameterBindingSha256: circuitPayload.parameterBindingSha256,
    measurementBitOrder: circuitPayload.measurementBitOrder,
  });
  return { problemBinding, problemContract, circuitBinding, circuitPayload };
}

function providerEvidence({ provider, backendDevice, hardwareDeviceId, jobId, adapterId, problemBinding, circuitBinding, shots }) {
  return {
    provider,
    backendDevice,
    jobId,
    status: "SUCCEEDED",
    timestamps: {
      submittedAt: "2026-09-15T12:00:00Z",
      startedAt: "2026-09-15T12:00:02Z",
      completedAt: "2026-09-15T12:00:03Z",
    },
    timing: { queueTimeMillis: 2_000, executionTimeMillis: 1_000, providerReportedTotalMillis: 3_000 },
    shotsRequested: shots,
    shotsCompleted: shots,
    problemBindingSha256: problemBinding.bindingSha256,
    optimizationProblemReportSha256: problemBinding.optimizationProblemReportSha256,
    optimizationModelSha256: problemBinding.optimizationModelSha256,
    circuitSha256: circuitBinding.circuitSha256,
    transpilationApplied: true,
    transpiledCircuitSha256: sha256Text(`${provider}:${backendDevice}:isa:${circuitBinding.circuitSha256}`),
    calibrationEvidence: {
      status: "CAPTURED",
      calibrationId: `${backendDevice}-calibration-1`,
      capturedAt: "2026-09-15T11:59:00Z",
      providerReportedAt: "2026-09-15T12:00:03Z",
      metadataSha256: sha256Text(`${provider}:${backendDevice}:calibration`),
    },
    rawResultSha256: sha256Text(`${provider}:${jobId}:raw-result`),
    measurementCounts: shots === 100 ? { "010": 40, "110": 60 } : { "110": shots },
    hardwareIdentity: {
      manufacturer: provider,
      deviceId: hardwareDeviceId,
      deviceType: "QPU",
      topologySha256: sha256Text(`${provider}:${backendDevice}:topology`),
      capabilitiesSha256: sha256Text(`${provider}:${backendDevice}:capabilities`),
    },
    providerReceiptSha256: sha256Text(`${provider}:${jobId}:provider-receipt`),
    reproducibilityMetadata: {
      adapterId,
      adapterVersion: "1.0.0",
      providerSdk: `${provider}-sdk`,
      providerSdkVersion: "contract-test",
      compiler: `${provider}-isa-compiler`,
      compilerVersion: "contract-test",
      seed: null,
    },
  };
}

async function physicalExecution({ problem, physicalBindings, jobId, backendDevice = "qpu-alpha-1", hardwareDeviceId = "qpu-alpha-1", adapterId = "NEXUS_PHYSICAL_PROTOCOL_ADAPTER_V1" }) {
  const backend = new PhysicalQPUBackend({
    provider: "provider-alpha",
    adapterId,
    executor: async ({ problemBinding, circuitBinding, shots }) => providerEvidence({
      provider: "provider-alpha",
      backendDevice,
      hardwareDeviceId,
      jobId,
      adapterId,
      problemBinding,
      circuitBinding,
      shots,
    }),
  });
  return backend.execute({ optimizationProblemReport: problem, ...physicalBindings, shots: 100 });
}

test("empty physical experiment stays blocked and cannot claim success", () => {
  const problem = optimizationProblem();
  const report = buildPhysicalQpuExperimentReport({
    optimizationProblemReport: problem,
    baselineProfile: baselineProfile(),
    quantumExecutions: [],
    minimumCompletedRuns: 2,
  });
  assert.equal(report.verdict, "NOT_TESTED");
  assert.equal(report.status, "BLOCKED_PHYSICAL_QPU_EXECUTION_NOT_PERFORMED");
  assert.equal(report.quantumAdvantageClaimAllowed, false);
  assert.equal(report.submittedRunCount, 0);
});

test("repeated verified physical executions certify comparability but never quantum advantage", async () => {
  const problem = optimizationProblem();
  const physicalBindings = bindings(problem);
  const first = await physicalExecution({ problem, physicalBindings, jobId: "job-physical-1" });
  const second = await physicalExecution({ problem, physicalBindings, jobId: "job-physical-2" });
  assert.equal(first.verdict, "PASS");
  assert.equal(second.verdict, "PASS");

  const report = buildPhysicalQpuExperimentReport({
    optimizationProblemReport: problem,
    baselineProfile: baselineProfile(),
    quantumExecutions: [first, second],
    minimumCompletedRuns: 2,
  });
  assert.equal(report.verdict, "PASS");
  assert.equal(report.status, "REPEATED_PHYSICAL_QPU_EVIDENCE_COMPARABLE");
  assert.equal(report.successfulReceiptCount, 2);
  assert.equal(report.comparableRunCount, 2);
  assert.equal(report.controlledIdentity.stable, true);
  assert.equal(report.controlledCircuit.stable, true);
  assert.equal(report.resources.totalShotsRequested, 200);
  assert.equal(report.resources.totalShotsCompleted, 200);
  assert.equal(report.resources.totalQueueTimeMillis, 4_000);
  assert.equal(report.resources.totalExecutionTimeMillis, 2_000);
  assert.equal(report.objectiveEvidence.runCount, 2);
  assert.equal(report.objectiveEvidence.objectiveTieCount, 2);
  assert.equal(report.quantumAdvantageClaimAllowed, false);
  assert.match(report.interpretation, /NOT_QUANTUM_ADVANTAGE/);
});

test("reused provider job evidence fails closed instead of counting as repeated execution", async () => {
  const problem = optimizationProblem();
  const physicalBindings = bindings(problem);
  const execution = await physicalExecution({ problem, physicalBindings, jobId: "job-reused" });
  const report = buildPhysicalQpuExperimentReport({
    optimizationProblemReport: problem,
    baselineProfile: baselineProfile(),
    quantumExecutions: [execution, execution],
    minimumCompletedRuns: 2,
  });
  assert.equal(report.verdict, "FAIL");
  assert.equal(report.status, "DUPLICATE_PROVIDER_JOB_EVIDENCE");
  assert.deepEqual(report.duplicateProviderJobIds, ["job-reused"]);
  assert.equal(report.quantumAdvantageClaimAllowed, false);
});

test("hardware identity drift makes repeated physical evidence INCONCLUSIVE", async () => {
  const problem = optimizationProblem();
  const physicalBindings = bindings(problem);
  const first = await physicalExecution({ problem, physicalBindings, jobId: "job-drift-1", backendDevice: "qpu-alpha-1", hardwareDeviceId: "qpu-alpha-1" });
  const second = await physicalExecution({ problem, physicalBindings, jobId: "job-drift-2", backendDevice: "qpu-alpha-2", hardwareDeviceId: "qpu-alpha-2" });
  const report = buildPhysicalQpuExperimentReport({
    optimizationProblemReport: problem,
    baselineProfile: baselineProfile(),
    quantumExecutions: [first, second],
    minimumCompletedRuns: 2,
  });
  assert.equal(report.verdict, "INCONCLUSIVE");
  assert.equal(report.controlledIdentity.stable, false);
  assert.ok(report.reasons.includes("HARDWARE_IDENTITY_DRIFT_ACROSS_RUNS"));
});

test("circuit drift makes repeated physical evidence INCONCLUSIVE", async () => {
  const problem = optimizationProblem();
  const firstBindings = bindings(problem, [500_000]);
  const secondBindings = bindings(problem, [700_000]);
  const first = await physicalExecution({ problem, physicalBindings: firstBindings, jobId: "job-circuit-1" });
  const second = await physicalExecution({ problem, physicalBindings: secondBindings, jobId: "job-circuit-2" });
  const report = buildPhysicalQpuExperimentReport({
    optimizationProblemReport: problem,
    baselineProfile: baselineProfile(),
    quantumExecutions: [first, second],
    minimumCompletedRuns: 2,
  });
  assert.equal(report.verdict, "INCONCLUSIVE");
  assert.equal(report.controlledCircuit.stable, false);
  assert.ok(report.reasons.includes("CIRCUIT_OR_SHOT_POLICY_DRIFT_ACROSS_RUNS"));
});

test("all unconfigured physical runs stay blocked without certification", async () => {
  const problem = optimizationProblem();
  const physicalBindings = bindings(problem);
  const backend = new PhysicalQPUBackend({ provider: "EXTERNAL_QPU_PROVIDER_REQUIRED", adapterId: "NEXUS_EXTERNAL_QPU_ADAPTER_PENDING_V1", executor: null });
  const first = await backend.execute({ optimizationProblemReport: problem, ...physicalBindings, shots: 100 });
  const second = await backend.execute({ optimizationProblemReport: problem, ...physicalBindings, shots: 100 });
  const report = buildPhysicalQpuExperimentReport({
    optimizationProblemReport: problem,
    baselineProfile: baselineProfile(),
    quantumExecutions: [first, second],
    minimumCompletedRuns: 2,
  });
  assert.equal(report.verdict, "NOT_TESTED");
  assert.equal(report.quantumAdvantageClaimAllowed, false);
});

test("unproven classical optimum keeps otherwise repeated physical evidence INCONCLUSIVE", async () => {
  const problem = optimizationProblem();
  const physicalBindings = bindings(problem);
  const first = await physicalExecution({ problem, physicalBindings, jobId: "job-classical-1" });
  const second = await physicalExecution({ problem, physicalBindings, jobId: "job-classical-2" });
  const report = buildPhysicalQpuExperimentReport({
    optimizationProblemReport: problem,
    baselineProfile: baselineProfile(1),
    quantumExecutions: [first, second],
    minimumCompletedRuns: 2,
  });
  assert.equal(report.verdict, "INCONCLUSIVE");
  assert.ok(report.reasons.includes("CLASSICAL_BASELINE_NOT_PROVEN_OPTIMAL"));
  assert.equal(report.quantumAdvantageClaimAllowed, false);
});
