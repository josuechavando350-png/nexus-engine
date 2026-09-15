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
import {
  PHYSICAL_QPU_RUN_EXECUTION_AUTHORIZATION,
  PHYSICAL_QPU_RUN_PREPARE_ONLY,
  runPhysicalQpuExperiment,
} from "../quantum-runtime/physical-run-operator.mjs";

function sha256Text(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }

function promoted(name, rank, value) {
  return {
    decisionId: sha256Text(`operator:${name}`), query: `${name} legal`, pageUrl: `/${name}`, priorityRank: rank,
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
      prioritizationReportSha256: sha256Text("operator-prioritization"),
      rankTransitionReportSha256: sha256Text("operator-transition"),
      outcomeCalibrationReportSha256: sha256Text("operator-calibration"),
      rankContextReportSha256: sha256Text("operator-rank-context"),
      growthAssumptionProfileSha256: sha256Text("operator-growth"),
    },
    calibrationContext: {
      exactProfileReady: true,
      scenarioId: "BASE",
      growthAssumptionProfileSha256: sha256Text("operator-growth"),
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
    profile_id: "operator-planning",
    provenance: "controlled synthetic optimization fixture for physical run operator validation only",
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

function baselineProfile() {
  return {
    schema_version: 1,
    profile_id: "operator-classical-reference",
    provenance: "deterministic branch-and-bound comparison policy",
    maximum_candidates: 16,
    node_budget: 1_000,
    search_order_policy: "DEPENDENCY_TOPOLOGICAL_OBJECTIVE_DESC_PRIORITY_ASC_ID",
    tie_break_policy: "LOWER_COST_THEN_RISK_THEN_EDITORIAL_THEN_ENGINEERING_THEN_FEWER_SELECTED_THEN_IDENTITY",
  };
}

function bindings(problem = optimizationProblem()) {
  const problemBinding = buildProblemBinding(problem);
  const problemContract = buildQuantumProblemContract(problem);
  const circuitPayload = buildQaoaExecutableCircuitIr({
    optimizationProblemReport: problem,
    problemBinding,
    problemContract,
    parameterSetId: "operator-qaoa-params",
    gammaMicroradians: [500_000],
    betaMicroradians: [300_000],
  });
  const circuitBinding = buildCircuitBinding({
    problemBinding,
    circuitId: "operator-qaoa-circuit",
    circuitFormat: circuitPayload.irKind,
    logicalQubitCount: circuitPayload.logicalQubitCount,
    circuitSha256: circuitPayload.circuitSha256,
    parameterBindingSha256: circuitPayload.parameterBindingSha256,
    measurementBitOrder: circuitPayload.measurementBitOrder,
  });
  return { problemBinding, problemContract, circuitBinding, circuitPayload };
}

function backendWithEvidence({ seed = "1337", transpiledDigestForRun = null } = {}) {
  let runIndex = 0;
  return new PhysicalQPUBackend({
    provider: "provider-alpha",
    adapterId: "NEXUS_OPERATOR_PROVIDER_ALPHA_V1",
    adapterVersion: "1.0.0",
    executor: async ({ problemBinding, circuitBinding, shots }) => {
      runIndex += 1;
      const jobId = `operator-job-${runIndex}`;
      const transpiledCircuitSha256 = transpiledDigestForRun
        ? transpiledDigestForRun(runIndex, circuitBinding.circuitSha256)
        : sha256Text(`stable-isa:${circuitBinding.circuitSha256}`);
      return {
        provider: "provider-alpha",
        backendDevice: "qpu-alpha-1",
        jobId,
        status: "SUCCEEDED",
        timestamps: {
          submittedAt: `2026-09-15T12:00:0${runIndex}Z`,
          startedAt: `2026-09-15T12:00:1${runIndex}Z`,
          completedAt: `2026-09-15T12:00:2${runIndex}Z`,
        },
        timing: { queueTimeMillis: 10_000, executionTimeMillis: 10_000, providerReportedTotalMillis: 20_000 },
        shotsRequested: shots,
        shotsCompleted: shots,
        problemBindingSha256: problemBinding.bindingSha256,
        optimizationProblemReportSha256: problemBinding.optimizationProblemReportSha256,
        optimizationModelSha256: problemBinding.optimizationModelSha256,
        circuitSha256: circuitBinding.circuitSha256,
        transpilationApplied: true,
        transpiledCircuitSha256,
        calibrationEvidence: {
          status: "CAPTURED",
          calibrationId: "qpu-alpha-calibration-1",
          capturedAt: "2026-09-15T11:59:00Z",
          providerReportedAt: "2026-09-15T11:59:00Z",
          metadataSha256: sha256Text("qpu-alpha-calibration"),
        },
        rawResultSha256: sha256Text(`raw:${jobId}`),
        measurementCounts: { "010": Math.floor(shots * 0.4), "110": shots - Math.floor(shots * 0.4) },
        hardwareIdentity: {
          manufacturer: "provider-alpha",
          deviceId: "qpu-alpha-1",
          deviceType: "QPU",
          topologySha256: sha256Text("qpu-alpha-topology"),
          capabilitiesSha256: sha256Text("qpu-alpha-capabilities"),
        },
        providerReceiptSha256: sha256Text(`receipt:${jobId}`),
        reproducibilityMetadata: {
          adapterId: "NEXUS_OPERATOR_PROVIDER_ALPHA_V1",
          adapterVersion: "1.0.0",
          providerSdk: "provider-alpha-sdk",
          providerSdkVersion: "1.0.0",
          compiler: "provider-alpha-seeded-compiler",
          compilerVersion: "1.0.0",
          seed,
        },
      };
    },
  });
}

function operatorInput(backend, executionAuthorization) {
  const problem = optimizationProblem();
  return {
    backend,
    optimizationProblemReport: problem,
    baselineProfile: baselineProfile(),
    ...bindings(problem),
    shots: 100,
    runCount: 2,
    executionAuthorization,
  };
}

test("prepare-only mode never calls the physical backend and remains blocked", async () => {
  let called = 0;
  const backend = {
    descriptor: Object.freeze({ adapterId: "NEXUS_PREPARE_ONLY_TEST_V1", adapterVersion: "1.0.0", backendFamily: "PHYSICAL_QPU", hardwareExecution: true }),
    execute: async () => { called += 1; throw new Error("prepare-only operator must not execute backend"); },
  };
  const result = await runPhysicalQpuExperiment(operatorInput(backend, PHYSICAL_QPU_RUN_PREPARE_ONLY));
  assert.equal(called, 0);
  assert.equal(result.operatorReport.verdict, "NOT_TESTED");
  assert.equal(result.operatorReport.attemptedRunCount, 0);
  assert.equal(result.operatorReport.quantumAdvantageClaimAllowed, false);
});

test("execution authorization with no provider executor attempts once then stops blocked", async () => {
  const backend = new PhysicalQPUBackend({
    provider: "EXTERNAL_QPU_PROVIDER_REQUIRED",
    adapterId: "NEXUS_EXTERNAL_QPU_ADAPTER_PENDING_V1",
    executor: null,
  });
  const result = await runPhysicalQpuExperiment(operatorInput(backend, PHYSICAL_QPU_RUN_EXECUTION_AUTHORIZATION));
  assert.equal(result.executions.length, 1);
  assert.equal(result.executions[0].verdict, "NOT_TESTED");
  assert.equal(result.operatorReport.verdict, "NOT_TESTED");
  assert.equal(result.operatorReport.attemptedRunCount, 1);
});

test("stable seeded repeated physical evidence can PASS the operator without advantage claims", async () => {
  const result = await runPhysicalQpuExperiment(operatorInput(backendWithEvidence(), PHYSICAL_QPU_RUN_EXECUTION_AUTHORIZATION));
  assert.equal(result.executions.length, 2);
  assert.equal(result.experimentReport.verdict, "PASS");
  assert.equal(result.operatorReport.verdict, "PASS");
  assert.equal(result.operatorReport.compilationControls.stableTranspiledCircuit, true);
  assert.equal(result.operatorReport.compilationControls.stableSeed, true);
  assert.equal(result.operatorReport.compilationControls.seed, "1337");
  assert.equal(result.operatorReport.quantumAdvantageClaimAllowed, false);
});

test("transpiled ISA circuit drift downgrades otherwise comparable repeated runs to INCONCLUSIVE", async () => {
  const backend = backendWithEvidence({
    transpiledDigestForRun: (runIndex, circuitSha256) => sha256Text(`isa:${runIndex}:${circuitSha256}`),
  });
  const result = await runPhysicalQpuExperiment(operatorInput(backend, PHYSICAL_QPU_RUN_EXECUTION_AUTHORIZATION));
  assert.equal(result.experimentReport.verdict, "PASS");
  assert.equal(result.operatorReport.verdict, "INCONCLUSIVE");
  assert.ok(result.operatorReport.reasons.includes("TRANSPILED_CIRCUIT_DRIFT_ACROSS_RUNS"));
  assert.equal(result.operatorReport.quantumAdvantageClaimAllowed, false);
});

test("missing transpiler seed blocks operator PASS even when provider receipts otherwise validate", async () => {
  const result = await runPhysicalQpuExperiment(operatorInput(backendWithEvidence({ seed: null }), PHYSICAL_QPU_RUN_EXECUTION_AUTHORIZATION));
  assert.equal(result.experimentReport.verdict, "PASS");
  assert.equal(result.operatorReport.verdict, "INCONCLUSIVE");
  assert.ok(result.operatorReport.reasons.includes("TRANSPILER_SEED_NOT_CAPTURED"));
});
