import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildOptimizationProblemReport } from "../optimization-problem/problem-builder.mjs";
import {
  buildCircuitBinding,
  buildProblemBinding,
  buildQaoaExecutableCircuitIr,
  buildQuantumProblemContract,
  canonicalQuantumSha256,
} from "../quantum-runtime/contracts.mjs";
import { buildPhysicalQpuFirstRunPlan } from "../quantum-runtime/physical-first-run-plan.mjs";
import {
  buildPhysicalQpuLiveAuthorizationRecord,
  createIbmPhysicalQpuSmokeGateForContractTest,
} from "../quantum-runtime/providers/ibm/ibm-physical-smoke-gate.mjs";
import {
  buildRepeatedPhysicalSeriesAuthorizationRecord,
  createIbmRepeatedPhysicalSeriesGateForContractTest,
} from "../quantum-runtime/providers/ibm/ibm-repeated-series-gate.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function sha256Text(value) {
  return `sha256:${createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex")}`;
}

function gitIdentity() {
  return {
    sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim(),
    sourceTree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: REPO_ROOT, encoding: "utf8" }).trim(),
  };
}

function promoted(name, rank, value) {
  return {
    decisionId: sha256Text(`series-gate:${name}`), query: `${name} legal`, pageUrl: `/${name}`, priorityRank: rank,
    paretoLayer: 1, paretoFrontier: true,
    selectedTarget: { rankTarget: "TOP_3", feasibilityBand: "MEDIUM", gapMilli: 5_000 },
    economicObjective: { id: "INCREMENTAL_REVENUE_MICROS", scenarioValue: value },
    empiricalTransition: {
      horizonMs: 2_592_000_000,
      status: "EMPIRICAL_TRANSITION_FREQUENCY_READY",
      successCount: 3,
      sampleCount: 5,
      distinctOpportunityCount: 3,
      empiricalProbabilityPpm: 600_000,
    },
    exactGrowthProfileCalibrationReady: true,
    optimizationEligibility: "PROMOTE_TO_OPTIMIZATION",
    reasons: [],
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
      prioritizationReportSha256: sha256Text("series-gate-prioritization"),
      rankTransitionReportSha256: sha256Text("series-gate-transition"),
      outcomeCalibrationReportSha256: sha256Text("series-gate-calibration"),
      rankContextReportSha256: sha256Text("series-gate-rank-context"),
      growthAssumptionProfileSha256: sha256Text("series-gate-growth"),
    },
    calibrationContext: {
      exactProfileReady: true,
      scenarioId: "BASE",
      growthAssumptionProfileSha256: sha256Text("series-gate-growth"),
      matchedRecordCount: 4,
      minimumRecords: 3,
      empiricalErrorStats: {},
      decisionBoundary: "CALIBRATION_QUALIFIES_EVIDENCE_BUT_DOES_NOT_REWRITE_SCENARIO_VALUE",
    },
    summary: {
      prioritizedCandidateCount: 3,
      promotedToOptimizationCount: 3,
      heldForEvidenceCount: 0,
      heldTransitionCount: 0,
      heldCalibrationCount: 0,
    },
    decisions,
    decisionBoundary: "NO_HIDDEN_SCORE_NO_AUTONOMOUS_SITE_ACTION_OPTIMIZATION_BUILDER_MUST_ENFORCE_BUDGET_CAPACITY_DEPENDENCIES_RISK_AND_POLICY",
    warnings: ["NO_RANK_GUARANTEE"],
  };
  return { ...unsigned, reportSha256: canonicalQuantumSha256(unsigned) };
}

function optimizationProblem() {
  const source = decisionReport();
  const [alpha, beta, gamma] = source.decisions;
  return buildOptimizationProblemReport({
    decisionReport: source,
    planningProfile: {
      schema_version: 1,
      profile_id: "series-gate-planning",
      provenance: "controlled contract fixture for repeated physical series gate verification only",
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
    },
  });
}

function physicalRequest(problem = optimizationProblem()) {
  const problemBinding = buildProblemBinding(problem);
  const problemContract = buildQuantumProblemContract(problem);
  const circuitPayload = buildQaoaExecutableCircuitIr({
    optimizationProblemReport: problem,
    problemBinding,
    problemContract,
    parameterSetId: "series-gate-p1",
    gammaMicroradians: [500_000],
    betaMicroradians: [300_000],
  });
  const circuitBinding = buildCircuitBinding({
    problemBinding,
    circuitId: "series-gate-qaoa-v1",
    circuitFormat: circuitPayload.irKind,
    logicalQubitCount: circuitPayload.logicalQubitCount,
    circuitSha256: circuitPayload.circuitSha256,
    parameterBindingSha256: circuitPayload.parameterBindingSha256,
    measurementBitOrder: circuitPayload.measurementBitOrder,
  });
  return { optimizationProblemReport: problem, problemBinding, problemContract, circuitBinding, circuitPayload, shots: 999 };
}

function baselineProfile(nodeBudget = 1_000) {
  return {
    schema_version: 1,
    profile_id: "series-gate-classical-reference",
    provenance: "deterministic branch-and-bound comparison policy for contract verification",
    maximum_candidates: 16,
    node_budget: nodeBudget,
    search_order_policy: "DEPENDENCY_TOPOLOGICAL_OBJECTIVE_DESC_PRIORITY_ASC_ID",
    tie_break_policy: "LOWER_COST_THEN_RISK_THEN_EDITORIAL_THEN_ENGINEERING_THEN_FEWER_SELECTED_THEN_IDENTITY",
  };
}

function planFor(identity = gitIdentity()) {
  return buildPhysicalQpuFirstRunPlan({
    sourceRevision: identity.sourceRevision,
    sourceTree: identity.sourceTree,
    backendName: "ibm_contract_qpu",
    transpilerSeed: 1337,
    evidenceRoot: "/tmp/nexus-quantum-one-contract-series",
    smokeShots: 64,
    repeatedShots: 128,
    repeatedRunCount: 5,
    bridgeTimeoutMillis: 5_000,
  });
}

function capabilityArtifact(backendName, { drift = false } = {}) {
  return JSON.stringify({
    backend: backendName,
    numQubits: 127,
    physicalQubits: 127,
    operationNames: drift ? ["cz", "measure", "rz", "sx"] : ["cz", "measure", "rz", "sx", "x"],
  });
}

function preflightResponseFor(request, { ready = true, capabilityDrift = false } = {}) {
  const logicalQasm3 = request.logicalCircuitArtifact.qasm3;
  const transpiledQasm3 = `${logicalQasm3}\n// shared seeded ISA contract fixture\n`;
  const topologyJson = JSON.stringify({ backend: request.backendName, edges: [[0, 1], [1, 2]] });
  const capabilitiesJson = capabilityArtifact(request.backendName, { drift: capabilityDrift });
  return {
    schemaVersion: 1,
    bridgeId: "NEXUS_IBM_QUANTUM_QPU_PREFLIGHT_V1",
    preflight: {
      provider: "IBM_QUANTUM_COMPUTE",
      backendDevice: request.backendName,
      physicalQpu: true,
      operational: ready,
      statusMessage: ready ? "active" : "paused",
      pendingJobs: 2,
      logicalQubitCount: request.logicalQubitCount,
      backendQubitCount: 127,
      qubitCapacitySufficient: true,
      nativeOperationSetSatisfied: true,
      transpilerSeed: String(request.transpilerSeed),
      logicalQasm3Sha256: request.logicalCircuitArtifact.qasm3Sha256,
      transpiledCircuitSha256: sha256Text(transpiledQasm3),
      topologySha256: sha256Text(topologyJson),
      capabilitiesSha256: sha256Text(capabilitiesJson),
      resourceEstimate: { gateCount: 12, twoQubitGateCount: 2, depth: 8 },
      providerSdk: "qiskit-ibm-runtime",
      providerSdkVersion: "0.49.0",
      compiler: "qiskit.generate_preset_pass_manager",
      compilerVersion: "2.5.2",
      readiness: ready ? "READY" : "NOT_READY",
      reasons: ready ? [] : ["BACKEND_NOT_OPERATIONAL", "BACKEND_STATUS_NOT_ACTIVE"],
      submissionAttempted: false,
      physicalExecutionVerdict: "NOT_TESTED",
    },
    artifacts: {
      logicalQasm3,
      logicalQasm3Sha256: request.logicalCircuitArtifact.qasm3Sha256,
      transpiledQasm3,
      transpiledQasm3Sha256: sha256Text(transpiledQasm3),
      topologyJson,
      topologySha256: sha256Text(topologyJson),
      capabilitiesJson,
      capabilitiesSha256: sha256Text(capabilitiesJson),
    },
  };
}

function liveResponseFor(request, { jobId, capabilityDrift = false } = {}) {
  const logicalQasm3 = request.logicalCircuitArtifact.qasm3;
  const transpiledQasm3 = `${logicalQasm3}\n// shared seeded ISA contract fixture\n`;
  const bitstring = "110".slice(-request.logicalQubitCount).padStart(request.logicalQubitCount, "0");
  const rawResultJson = JSON.stringify({ jobId, counts: { [bitstring]: request.shots } });
  const providerReceiptJson = JSON.stringify({
    jobId,
    backend: request.backendName,
    status: "SUCCEEDED",
    transpilerSeed: String(request.transpilerSeed),
  });
  const metricsJson = JSON.stringify({
    timestamps: {
      created: "2026-09-15T12:00:00Z",
      running: "2026-09-15T12:00:02Z",
      finished: "2026-09-15T12:00:03Z",
    },
  });
  const topologyJson = JSON.stringify({ backend: request.backendName, edges: [[0, 1], [1, 2]] });
  const capabilitiesJson = capabilityArtifact(request.backendName, { drift: capabilityDrift });
  const calibrationJson = JSON.stringify({ backend: request.backendName, last_update_date: "2026-09-15T11:59:00Z" });
  const transpiledSha = sha256Text(transpiledQasm3);
  const rawSha = sha256Text(rawResultJson);
  const receiptSha = sha256Text(providerReceiptJson);
  const topologySha = sha256Text(topologyJson);
  const capabilitiesSha = sha256Text(capabilitiesJson);
  const calibrationSha = sha256Text(calibrationJson);
  return {
    schemaVersion: 1,
    bridgeId: "NEXUS_IBM_QUANTUM_QISKIT_BRIDGE_V1",
    evidence: {
      provider: "IBM_QUANTUM_COMPUTE",
      backendDevice: request.backendName,
      jobId,
      status: "SUCCEEDED",
      timestamps: {
        submittedAt: "2026-09-15T12:00:00Z",
        startedAt: "2026-09-15T12:00:02Z",
        completedAt: "2026-09-15T12:00:03Z",
      },
      timing: { queueTimeMillis: 2_000, executionTimeMillis: 1_000, providerReportedTotalMillis: 3_000 },
      shotsRequested: request.shots,
      shotsCompleted: request.shots,
      problemBindingSha256: request.problemBindingSha256,
      optimizationProblemReportSha256: request.optimizationProblemReportSha256,
      optimizationModelSha256: request.optimizationModelSha256,
      circuitSha256: request.circuitSha256,
      transpilationApplied: true,
      transpiledCircuitSha256: transpiledSha,
      calibrationEvidence: {
        status: "CAPTURED",
        calibrationId: "ibm-properties-contract-series",
        capturedAt: "2026-09-15T11:59:00Z",
        providerReportedAt: "2026-09-15T11:59:00Z",
        metadataSha256: calibrationSha,
      },
      rawResultSha256: rawSha,
      measurementCounts: { [bitstring]: request.shots },
      hardwareIdentity: {
        manufacturer: "IBM",
        deviceId: request.backendName,
        deviceType: "QPU",
        topologySha256: topologySha,
        capabilitiesSha256: capabilitiesSha,
      },
      providerReceiptSha256: receiptSha,
      reproducibilityMetadata: {
        adapterId: "NEXUS_IBM_QUANTUM_COMPUTE_QPU_ADAPTER_V1",
        adapterVersion: "1.0.0",
        providerSdk: "qiskit-ibm-runtime",
        providerSdkVersion: "0.49.0",
        compiler: "qiskit.generate_preset_pass_manager",
        compilerVersion: "2.5.2",
        seed: String(request.transpilerSeed),
      },
    },
    artifacts: {
      logicalQasm3,
      logicalQasm3Sha256: request.logicalCircuitArtifact.qasm3Sha256,
      transpiledQasm3,
      transpiledQasm3Sha256: transpiledSha,
      rawResultJson,
      rawResultSha256: rawSha,
      providerReceiptJson,
      providerReceiptSha256: receiptSha,
      metricsJson,
      topologyJson,
      topologySha256: topologySha,
      capabilitiesJson,
      capabilitiesSha256: capabilitiesSha,
      calibrationJson,
      calibrationSha256: calibrationSha,
    },
  };
}

function commonEvidenceAuthorizationInput(plan, request) {
  return {
    plan,
    physicalRequest: request,
    sourceRevision: plan.sourceRevision,
    sourceTree: plan.sourceTree,
    exactHeadCiStatus: "SUCCESS",
    walleArtifactSha256: sha256Text("contract-walle-artifact"),
    walleProofSha256: sha256Text("contract-walle-proof"),
    walleExecutedModuleCount: 2_500,
    walleFailedModuleCount: 0,
    walleBlockedModuleCount: 0,
    walleNotTestedModuleCount: 0,
    fullExecutionClaim: true,
    providerCostOrEntitlementConfirmed: true,
    providerCostOrEntitlementReference: "contract-entitlement-1",
  };
}

async function verifiedSmoke(plan, request = physicalRequest()) {
  const smokeCounters = { preflight: 0, live: 0 };
  const gate = createIbmPhysicalQpuSmokeGateForContractTest({
    plan,
    apiKey: "contract-secret-not-real",
    instanceCrn: "crn:v1:contract-only",
    preflightBridgeRunner: async ({ request: bridgeRequest }) => {
      smokeCounters.preflight += 1;
      return preflightResponseFor(bridgeRequest);
    },
    executionBridgeRunner: async ({ request: bridgeRequest }) => {
      smokeCounters.live += 1;
      return liveResponseFor(bridgeRequest, { jobId: "contract-smoke-job-1" });
    },
  });
  const authorizationRecord = buildPhysicalQpuLiveAuthorizationRecord(commonEvidenceAuthorizationInput(plan, request));
  const result = await gate.run({
    physicalRequest: request,
    executionAuthorization: "EXECUTE_PHYSICAL_QPU",
    authorizationRecord,
  });
  assert.equal(result.gateReport.verdict, "PASS");
  assert.equal(result.gateReport.repeatedSeriesAuthorized, true);
  assert.deepEqual(smokeCounters, { preflight: 1, live: 1 });
  return result;
}

function seriesAuthorization(plan, smokeGateResult, request, baseline = baselineProfile(), overrides = {}) {
  return buildRepeatedPhysicalSeriesAuthorizationRecord({
    ...commonEvidenceAuthorizationInput(plan, request),
    smokeGateResult,
    baselineProfile: baseline,
    ...overrides,
  });
}

function seriesGate(plan, {
  preflightMode = () => ({}),
  executionMode = () => ({}),
  jobIdForRun = (runIndex) => `contract-series-job-${runIndex + 1}`,
} = {}, counters = { preflight: 0, live: 0 }) {
  return createIbmRepeatedPhysicalSeriesGateForContractTest({
    plan,
    apiKey: "contract-secret-not-real",
    instanceCrn: "crn:v1:contract-only",
    preflightBridgeRunner: async ({ request }) => {
      const index = counters.preflight;
      counters.preflight += 1;
      return preflightResponseFor(request, preflightMode(index));
    },
    executionBridgeRunner: async ({ request }) => {
      const index = counters.live;
      counters.live += 1;
      const mode = executionMode(index);
      if (mode.timeout) throw new Error("IBM_QPU_BRIDGE_TIMEOUT");
      return liveResponseFor(request, {
        jobId: mode.jobId ?? jobIdForRun(index),
        capabilityDrift: mode.capabilityDrift ?? false,
      });
    },
  });
}

test("prepare mode preserves the verified smoke reference and performs zero repeated provider calls", async () => {
  const plan = planFor();
  const request = physicalRequest();
  const smoke = await verifiedSmoke(plan, request);
  const counters = { preflight: 0, live: 0 };
  const result = await seriesGate(plan, {}, counters).run({
    physicalRequest: request,
    smokeGateResult: smoke,
    executionAuthorization: "PREPARE_ONLY",
  });
  assert.equal(result.gateReport.verdict, "NOT_TESTED");
  assert.equal(result.gateReport.attemptedRepeatedRunCount, 0);
  assert.equal(result.gateReport.repeatedSeriesComplete, false);
  assert.equal(result.gateReport.automaticRetryAllowed, false);
  assert.deepEqual(counters, { preflight: 0, live: 0 });
});

test("series authorization refuses incomplete WALLE evidence and unconfirmed provider entitlement", async () => {
  const plan = planFor();
  const request = physicalRequest();
  const smoke = await verifiedSmoke(plan, request);
  assert.throws(
    () => seriesAuthorization(plan, smoke, request, baselineProfile(), { walleExecutedModuleCount: 2_499, walleNotTestedModuleCount: 1 }),
    /complete 2500-module execution claim/,
  );
  assert.throws(
    () => seriesAuthorization(plan, smoke, request, baselineProfile(), { providerCostOrEntitlementConfirmed: false }),
    /provider cost or entitlement must be externally confirmed/,
  );
});

test("series authorization binds the exact repeated request and classical baseline before provider calls", async () => {
  const plan = planFor();
  const request = physicalRequest();
  const smoke = await verifiedSmoke(plan, request);
  const authorizationRecord = seriesAuthorization(plan, smoke, request);
  const counters = { preflight: 0, live: 0 };
  const mutatedRequest = {
    ...request,
    circuitPayload: {
      ...request.circuitPayload,
      circuitSha256: sha256Text("series-unauthorized-circuit-mutation"),
    },
  };
  await assert.rejects(
    seriesGate(plan, {}, counters).run({
      physicalRequest: mutatedRequest,
      baselineProfile: baselineProfile(),
      smokeGateResult: smoke,
      executionAuthorization: "EXECUTE_PHYSICAL_QPU",
      authorizationRecord,
    }),
    /AUTHORIZED_REQUEST_MISMATCH/,
  );
  await assert.rejects(
    seriesGate(plan, {}, counters).run({
      physicalRequest: request,
      baselineProfile: baselineProfile(999),
      smokeGateResult: smoke,
      executionAuthorization: "EXECUTE_PHYSICAL_QPU",
      authorizationRecord,
    }),
    /AUTHORIZED_BASELINE_MISMATCH/,
  );
  assert.deepEqual(counters, { preflight: 0, live: 0 });
});

test("controlled repeated series performs one preflight per run and certifies classical comparability only", async () => {
  const plan = planFor();
  const request = physicalRequest();
  const baseline = baselineProfile();
  const smoke = await verifiedSmoke(plan, request);
  const counters = { preflight: 0, live: 0 };
  const result = await seriesGate(plan, {}, counters).run({
    physicalRequest: request,
    baselineProfile: baseline,
    smokeGateResult: smoke,
    executionAuthorization: "EXECUTE_PHYSICAL_QPU",
    authorizationRecord: seriesAuthorization(plan, smoke, request, baseline),
  });
  assert.deepEqual(counters, { preflight: 5, live: 5 });
  assert.equal(result.gateReport.verdict, "PASS");
  assert.equal(result.gateReport.attemptedRepeatedRunCount, 5);
  assert.equal(result.gateReport.confirmedRepeatedPhysicalJobCount, 5);
  assert.equal(result.gateReport.totalConfirmedPhysicalJobCountIncludingSmoke, 6);
  assert.equal(result.gateReport.repeatedSeriesComplete, true);
  assert.equal(result.gateReport.providerReconciliationRequired, false);
  assert.equal(result.gateReport.automaticRetryAllowed, false);
  assert.equal(result.gateReport.quantumAdvantageClaimAllowed, false);
  assert.equal(result.physicalExperimentReport.verdict, "PASS");
  assert.equal(result.physicalExperimentReport.successfulReceiptCount, 5);
  assert.equal(new Set(result.gateReport.repeatedProviderJobIds).size, 5);
});

test("preflight drift after one repeated receipt stops before the next physical submission", async () => {
  const plan = planFor();
  const request = physicalRequest();
  const baseline = baselineProfile();
  const smoke = await verifiedSmoke(plan, request);
  const counters = { preflight: 0, live: 0 };
  const result = await seriesGate(plan, {
    preflightMode: (index) => ({ capabilityDrift: index === 1 }),
  }, counters).run({
    physicalRequest: request,
    baselineProfile: baseline,
    smokeGateResult: smoke,
    executionAuthorization: "EXECUTE_PHYSICAL_QPU",
    authorizationRecord: seriesAuthorization(plan, smoke, request, baseline),
  });
  assert.deepEqual(counters, { preflight: 2, live: 1 });
  assert.equal(result.gateReport.verdict, "FAIL");
  assert.equal(result.gateReport.attemptedRepeatedRunCount, 1);
  assert.equal(result.gateReport.repeatedSeriesComplete, false);
  assert.ok(result.gateReport.reasons.includes("SERIES_PREFLIGHT_CAPABILITIES_DRIFT_FROM_SMOKE"));
});

test("receipt capability drift aborts immediately and never starts a third repeated job", async () => {
  const plan = planFor();
  const request = physicalRequest();
  const baseline = baselineProfile();
  const smoke = await verifiedSmoke(plan, request);
  const counters = { preflight: 0, live: 0 };
  const result = await seriesGate(plan, {
    executionMode: (index) => ({ capabilityDrift: index === 1 }),
  }, counters).run({
    physicalRequest: request,
    baselineProfile: baseline,
    smokeGateResult: smoke,
    executionAuthorization: "EXECUTE_PHYSICAL_QPU",
    authorizationRecord: seriesAuthorization(plan, smoke, request, baseline),
  });
  assert.deepEqual(counters, { preflight: 2, live: 2 });
  assert.equal(result.gateReport.verdict, "FAIL");
  assert.equal(result.gateReport.attemptedRepeatedRunCount, 2);
  assert.equal(result.gateReport.repeatedSeriesComplete, false);
  assert.ok(result.gateReport.reasons.includes("SERIES_EXECUTION_NOT_PASS")
    || result.gateReport.reasons.includes("SERIES_CAPABILITIES_DRIFT"));
});

test("duplicate provider job identity stops the series before another submission", async () => {
  const plan = planFor();
  const request = physicalRequest();
  const baseline = baselineProfile();
  const smoke = await verifiedSmoke(plan, request);
  const counters = { preflight: 0, live: 0 };
  const result = await seriesGate(plan, {
    jobIdForRun: (index) => index < 2 ? "contract-series-job-duplicate" : `contract-series-job-${index + 1}`,
  }, counters).run({
    physicalRequest: request,
    baselineProfile: baseline,
    smokeGateResult: smoke,
    executionAuthorization: "EXECUTE_PHYSICAL_QPU",
    authorizationRecord: seriesAuthorization(plan, smoke, request, baseline),
  });
  assert.deepEqual(counters, { preflight: 2, live: 2 });
  assert.equal(result.gateReport.verdict, "FAIL");
  assert.ok(result.gateReport.reasons.includes("SERIES_DUPLICATE_PROVIDER_JOB_ID"));
  assert.equal(result.gateReport.repeatedSeriesComplete, false);
});

test("ambiguous bridge timeout requires external reconciliation and is never retried automatically", async () => {
  const plan = planFor();
  const request = physicalRequest();
  const baseline = baselineProfile();
  const smoke = await verifiedSmoke(plan, request);
  const counters = { preflight: 0, live: 0 };
  const result = await seriesGate(plan, {
    executionMode: (index) => ({ timeout: index === 1 }),
  }, counters).run({
    physicalRequest: request,
    baselineProfile: baseline,
    smokeGateResult: smoke,
    executionAuthorization: "EXECUTE_PHYSICAL_QPU",
    authorizationRecord: seriesAuthorization(plan, smoke, request, baseline),
  });
  assert.deepEqual(counters, { preflight: 2, live: 2 });
  assert.equal(result.gateReport.verdict, "FAIL");
  assert.equal(result.gateReport.providerReconciliationRequired, true);
  assert.equal(result.gateReport.automaticRetryAllowed, false);
  assert.equal(result.gateReport.repeatedSeriesComplete, false);
  assert.ok(result.gateReport.reasons.includes("LOCAL_BRIDGE_TIMEOUT_REQUIRES_PROVIDER_JOB_RECONCILIATION_BEFORE_RETRY"));
});
