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
    decisionId: sha256Text(`smoke-gate:${name}`), query: `${name} legal`, pageUrl: `/${name}`, priorityRank: rank,
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
      prioritizationReportSha256: sha256Text("smoke-gate-prioritization"),
      rankTransitionReportSha256: sha256Text("smoke-gate-transition"),
      outcomeCalibrationReportSha256: sha256Text("smoke-gate-calibration"),
      rankContextReportSha256: sha256Text("smoke-gate-rank-context"),
      growthAssumptionProfileSha256: sha256Text("smoke-gate-growth"),
    },
    calibrationContext: {
      exactProfileReady: true, scenarioId: "BASE", growthAssumptionProfileSha256: sha256Text("smoke-gate-growth"),
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

function optimizationProblem() {
  const source = decisionReport();
  const [alpha, beta, gamma] = source.decisions;
  return buildOptimizationProblemReport({
    decisionReport: source,
    planningProfile: {
      schema_version: 1,
      profile_id: "smoke-gate-planning",
      provenance: "controlled contract fixture for physical smoke gate verification only",
      budget_micros: 9, editorial_capacity_units: 4, engineering_capacity_units: 4, risk_capacity_units: 4, maximum_selected: 2,
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
    parameterSetId: "smoke-gate-p1",
    gammaMicroradians: [500_000],
    betaMicroradians: [300_000],
  });
  const circuitBinding = buildCircuitBinding({
    problemBinding,
    circuitId: "smoke-gate-qaoa-v1",
    circuitFormat: circuitPayload.irKind,
    logicalQubitCount: circuitPayload.logicalQubitCount,
    circuitSha256: circuitPayload.circuitSha256,
    parameterBindingSha256: circuitPayload.parameterBindingSha256,
    measurementBitOrder: circuitPayload.measurementBitOrder,
  });
  return { optimizationProblemReport: problem, problemBinding, problemContract, circuitBinding, circuitPayload, shots: 999 };
}

function planFor(identity = gitIdentity()) {
  return buildPhysicalQpuFirstRunPlan({
    sourceRevision: identity.sourceRevision,
    sourceTree: identity.sourceTree,
    backendName: "ibm_contract_qpu",
    transpilerSeed: 1337,
    evidenceRoot: "/tmp/nexus-quantum-one-contract-smoke",
    smokeShots: 64,
    repeatedShots: 128,
    repeatedRunCount: 5,
    bridgeTimeoutMillis: 5_000,
  });
}

function authorizationFor(plan, overrides = {}, request = physicalRequest()) {
  return buildPhysicalQpuLiveAuthorizationRecord({
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
    ...overrides,
  });
}

function capabilityArtifact(backendName) {
  return JSON.stringify({
    backend: backendName,
    numQubits: 127,
    physicalQubits: 127,
    operationNames: ["cz", "measure", "rz", "sx", "x"],
  });
}

function preflightResponseFor(request, { ready = true } = {}) {
  const logicalQasm3 = request.logicalCircuitArtifact.qasm3;
  const transpiledQasm3 = `${logicalQasm3}\n// shared seeded ISA contract fixture\n`;
  const topologyJson = JSON.stringify({ backend: request.backendName, edges: [[0, 1], [1, 2]] });
  const capabilitiesJson = capabilityArtifact(request.backendName);
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

function liveResponseFor(request, { capabilitiesDrift = false } = {}) {
  const logicalQasm3 = request.logicalCircuitArtifact.qasm3;
  const transpiledQasm3 = `${logicalQasm3}\n// shared seeded ISA contract fixture\n`;
  const jobId = "contract-job-smoke-1";
  const bitstring = "0".repeat(request.logicalQubitCount);
  const rawResultJson = JSON.stringify({ jobId, counts: { [bitstring]: request.shots } });
  const providerReceiptJson = JSON.stringify({ jobId, backend: request.backendName, status: "SUCCEEDED", transpilerSeed: String(request.transpilerSeed) });
  const metricsJson = JSON.stringify({ timestamps: { created: "2026-09-15T12:00:00Z", running: "2026-09-15T12:00:02Z", finished: "2026-09-15T12:00:03Z" } });
  const topologyJson = JSON.stringify({ backend: request.backendName, edges: [[0, 1], [1, 2]] });
  const capabilitiesJson = capabilitiesDrift
    ? JSON.stringify({ backend: request.backendName, numQubits: 127, physicalQubits: 127, operationNames: ["cz", "measure", "rz", "sx"] })
    : capabilityArtifact(request.backendName);
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
      timestamps: { submittedAt: "2026-09-15T12:00:00Z", startedAt: "2026-09-15T12:00:02Z", completedAt: "2026-09-15T12:00:03Z" },
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
        calibrationId: "ibm-properties-contract-smoke",
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

function gateFor(plan, { preflightReady = true, executionMode = "PASS" } = {}, counters = { preflight: 0, live: 0 }) {
  return createIbmPhysicalQpuSmokeGateForContractTest({
    plan,
    apiKey: "contract-secret-not-real",
    instanceCrn: "crn:v1:contract-only",
    preflightBridgeRunner: async ({ request }) => {
      counters.preflight += 1;
      return preflightResponseFor(request, { ready: preflightReady });
    },
    executionBridgeRunner: async ({ request }) => {
      counters.live += 1;
      if (executionMode === "TIMEOUT") throw new Error("IBM_QPU_BRIDGE_TIMEOUT");
      return liveResponseFor(request, { capabilitiesDrift: executionMode === "CAPABILITIES_DRIFT" });
    },
  });
}

test("PREPARE_ONLY resolves exact Git identity and performs zero provider bridge calls", async () => {
  const plan = planFor();
  const counters = { preflight: 0, live: 0 };
  const result = await gateFor(plan, {}, counters).run({ executionAuthorization: "PREPARE_ONLY" });
  assert.equal(result.preparationRecord.verdict, "NOT_TESTED");
  assert.equal(result.preparationRecord.hardwareInvocationCount, 0);
  assert.equal(result.gateReport.verdict, "NOT_TESTED");
  assert.equal(result.gateReport.liveExecutionAttempted, false);
  assert.equal(result.gateReport.repeatedSeriesAuthorized, false);
  assert.deepEqual(counters, { preflight: 0, live: 0 });
});

test("exact source drift blocks before preflight or physical submission", async () => {
  const plan = planFor({ sourceRevision: "a".repeat(40), sourceTree: "b".repeat(40) });
  const counters = { preflight: 0, live: 0 };
  await assert.rejects(
    gateFor(plan, {}, counters).run({ executionAuthorization: "PREPARE_ONLY" }),
    /EXACT_SOURCE_MISMATCH/,
  );
  assert.deepEqual(counters, { preflight: 0, live: 0 });
});

test("authorization builder refuses incomplete WALLE or unconfirmed provider entitlement", () => {
  const plan = planFor();
  assert.throws(
    () => authorizationFor(plan, { walleExecutedModuleCount: 2_499, walleNotTestedModuleCount: 1 }),
    /complete 2500-module execution claim/,
  );
  assert.throws(
    () => authorizationFor(plan, { providerCostOrEntitlementConfirmed: false }),
    /provider cost or entitlement must be externally confirmed/,
  );
});

test("authorization is bound to the exact smoke request before any provider bridge call", async () => {
  const plan = planFor();
  const counters = { preflight: 0, live: 0 };
  const authorizedRequest = physicalRequest();
  const mutatedRequest = {
    ...authorizedRequest,
    circuitPayload: {
      ...authorizedRequest.circuitPayload,
      circuitSha256: sha256Text("unauthorized-circuit-mutation"),
    },
  };
  await assert.rejects(
    gateFor(plan, {}, counters).run({
      physicalRequest: mutatedRequest,
      executionAuthorization: "EXECUTE_PHYSICAL_QPU",
      authorizationRecord: authorizationFor(plan, {}, authorizedRequest),
    }),
    /AUTHORIZED_REQUEST_MISMATCH/,
  );
  assert.deepEqual(counters, { preflight: 0, live: 0 });
});

test("NOT_READY preflight blocks the physical bridge and preserves physical NOT_TESTED boundary", async () => {
  const plan = planFor();
  const counters = { preflight: 0, live: 0 };
  const request = physicalRequest();
  const result = await gateFor(plan, { preflightReady: false }, counters).run({
    physicalRequest: request,
    executionAuthorization: "EXECUTE_PHYSICAL_QPU",
    authorizationRecord: authorizationFor(plan, {}, request),
  });
  assert.equal(result.gateReport.verdict, "INCONCLUSIVE");
  assert.equal(result.gateReport.status, "PHYSICAL_SMOKE_BLOCKED_BY_PREFLIGHT");
  assert.equal(result.gateReport.liveExecutionAttempted, false);
  assert.equal(result.gateReport.confirmedPhysicalJobCount, 0);
  assert.equal(result.gateReport.repeatedSeriesAuthorized, false);
  assert.deepEqual(counters, { preflight: 1, live: 0 });
});

test("verified smoke executes exactly one live bridge job with plan shots and authorizes but does not execute repeated series", async () => {
  const plan = planFor();
  const counters = { preflight: 0, live: 0 };
  let observedLiveShots = null;
  const request = physicalRequest();
  const gate = createIbmPhysicalQpuSmokeGateForContractTest({
    plan,
    apiKey: "contract-secret-not-real",
    instanceCrn: "crn:v1:contract-only",
    preflightBridgeRunner: async ({ request: bridgeRequest }) => {
      counters.preflight += 1;
      return preflightResponseFor(bridgeRequest);
    },
    executionBridgeRunner: async ({ request: bridgeRequest }) => {
      counters.live += 1;
      observedLiveShots = bridgeRequest.shots;
      return liveResponseFor(bridgeRequest);
    },
  });
  const result = await gate.run({
    physicalRequest: request,
    executionAuthorization: "EXECUTE_PHYSICAL_QPU",
    authorizationRecord: authorizationFor(plan, {}, request),
  });
  assert.equal(observedLiveShots, plan.smokeJob.shots);
  assert.deepEqual(counters, { preflight: 1, live: 1 });
  assert.equal(result.smokeExecution.verdict, "PASS");
  assert.equal(result.gateReport.verdict, "PASS");
  assert.equal(result.gateReport.confirmedPhysicalJobCount, 1);
  assert.equal(result.gateReport.repeatedSeriesExecutionCount, 0);
  assert.equal(result.gateReport.repeatedSeriesAuthorized, true);
  assert.equal(result.gateReport.quantumAdvantageClaimAllowed, false);
});

test("preflight-to-smoke capability drift blocks repeated-series authorization even when provider receipt is otherwise valid", async () => {
  const plan = planFor();
  const counters = { preflight: 0, live: 0 };
  const request = physicalRequest();
  const result = await gateFor(plan, { executionMode: "CAPABILITIES_DRIFT" }, counters).run({
    physicalRequest: request,
    executionAuthorization: "EXECUTE_PHYSICAL_QPU",
    authorizationRecord: authorizationFor(plan, {}, request),
  });
  assert.equal(result.smokeExecution.verdict, "PASS");
  assert.equal(result.gateReport.verdict, "FAIL");
  assert.equal(result.gateReport.repeatedSeriesAuthorized, false);
  assert.ok(result.gateReport.reasons.includes("SMOKE_CAPABILITIES_DRIFT_FROM_PREFLIGHT"));
  assert.deepEqual(counters, { preflight: 1, live: 1 });
});

test("ambiguous live bridge timeout requires provider reconciliation and never retries or starts the repeated series", async () => {
  const plan = planFor();
  const counters = { preflight: 0, live: 0 };
  const request = physicalRequest();
  const result = await gateFor(plan, { executionMode: "TIMEOUT" }, counters).run({
    physicalRequest: request,
    executionAuthorization: "EXECUTE_PHYSICAL_QPU",
    authorizationRecord: authorizationFor(plan, {}, request),
  });
  assert.equal(result.smokeExecution.verdict, "FAIL");
  assert.equal(result.gateReport.verdict, "FAIL");
  assert.equal(result.gateReport.providerReconciliationRequired, true);
  assert.equal(result.gateReport.repeatedSeriesAuthorized, false);
  assert.equal(result.gateReport.repeatedSeriesExecutionCount, 0);
  assert.ok(result.gateReport.reasons.includes("LOCAL_BRIDGE_TIMEOUT_REQUIRES_PROVIDER_JOB_RECONCILIATION_BEFORE_RETRY"));
  assert.deepEqual(counters, { preflight: 1, live: 1 });
});