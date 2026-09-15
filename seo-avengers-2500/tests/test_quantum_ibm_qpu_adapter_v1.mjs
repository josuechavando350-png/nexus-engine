import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildOptimizationProblemReport } from "../optimization-problem/problem-builder.mjs";
import {
  buildCircuitBinding,
  buildProblemBinding,
  buildQaoaExecutableCircuitIr,
  buildQuantumProblemContract,
  canonicalQuantumSha256,
} from "../quantum-runtime/contracts.mjs";
import {
  IBM_QPU_MAX_TRANSPILER_SEED,
  IBM_QUANTUM_COMPUTE_ADAPTER_ID,
  IBM_QUANTUM_COMPUTE_PROVIDER,
  buildIbmBridgeRequestForContractTest,
  createIbmFilesystemEvidenceSink,
  createIbmQuantumComputeBackend,
  validateIbmBridgeResponse,
} from "../quantum-runtime/providers/ibm/ibm-qpu-adapter.mjs";
import { buildQuantumJudgeComparison } from "../quantum-runtime/quantum-judge-comparison.mjs";

function sha256Text(value) { return `sha256:${createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex")}`; }

function promoted(name, rank, value) {
  return {
    decisionId: sha256Text(`ibm-adapter:${name}`), query: `${name} legal`, pageUrl: `/${name}`, priorityRank: rank,
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
      prioritizationReportSha256: sha256Text("ibm-adapter-prioritization"),
      rankTransitionReportSha256: sha256Text("ibm-adapter-transition"),
      outcomeCalibrationReportSha256: sha256Text("ibm-adapter-calibration"),
      rankContextReportSha256: sha256Text("ibm-adapter-rank-context"),
      growthAssumptionProfileSha256: sha256Text("ibm-adapter-growth"),
    },
    calibrationContext: {
      exactProfileReady: true, scenarioId: "BASE", growthAssumptionProfileSha256: sha256Text("ibm-adapter-growth"),
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
      profile_id: "ibm-adapter-planning",
      provenance: "controlled synthetic optimization fixture for IBM adapter contract validation only",
      budget_micros: 9, editorial_capacity_units: 4, engineering_capacity_units: 4, risk_capacity_units: 4, maximum_selected: 2,
      planning_items: [
        { decision_id: alpha.decisionId, cost_micros: 6, editorial_units: 1, engineering_units: 1, risk_units: 1, estimate_basis: "ESTIMATED" },
        { decision_id: beta.decisionId, cost_micros: 5, editorial_units: 2, engineering_units: 1, risk_units: 1, estimate_basis: "ESTIMATED" },
        { decision_id: gamma.decisionId, cost_micros: 4, editorial_units: 1, engineering_units: 2, risk_units: 1, estimate_basis: "ESTIMATED" },
      ],
      dependency_edges: [{ decision_id: gamma.decisionId, requires_decision_id: beta.decisionId }], mutex_groups: [],
    },
  });
}

function baselineProfile() {
  return {
    schema_version: 1, profile_id: "ibm-adapter-classical-reference", provenance: "deterministic branch-and-bound comparison policy",
    maximum_candidates: 16, node_budget: 1_000,
    search_order_policy: "DEPENDENCY_TOPOLOGICAL_OBJECTIVE_DESC_PRIORITY_ASC_ID",
    tie_break_policy: "LOWER_COST_THEN_RISK_THEN_EDITORIAL_THEN_ENGINEERING_THEN_FEWER_SELECTED_THEN_IDENTITY",
  };
}

function physicalRequest(problem = optimizationProblem()) {
  const problemBinding = buildProblemBinding(problem);
  const problemContract = buildQuantumProblemContract(problem);
  const circuitPayload = buildQaoaExecutableCircuitIr({
    optimizationProblemReport: problem,
    problemBinding,
    problemContract,
    parameterSetId: "ibm-adapter-p1",
    gammaMicroradians: [500_000],
    betaMicroradians: [300_000],
  });
  const circuitBinding = buildCircuitBinding({
    problemBinding,
    circuitId: "ibm-adapter-qaoa-v1",
    circuitFormat: circuitPayload.irKind,
    logicalQubitCount: circuitPayload.logicalQubitCount,
    circuitSha256: circuitPayload.circuitSha256,
    parameterBindingSha256: circuitPayload.parameterBindingSha256,
    measurementBitOrder: circuitPayload.measurementBitOrder,
  });
  return { optimizationProblemReport: problem, problemBinding, problemContract, circuitBinding, circuitPayload, shots: 100 };
}

function bridgeResponseFor(request, logicalCompilation, { jobId = "contract-job-alpha-1", tamperTranspiled = false } = {}) {
  const transpiledQasm3 = `${logicalCompilation.qasm3}\n// provider ISA contract fixture\n`;
  const logicalQasm3 = logicalCompilation.qasm3;
  const seed = request.transpilerSeed === null ? null : String(request.transpilerSeed);
  const rawResultJson = JSON.stringify({ jobId, counts: { "010": 40, "110": 60 } });
  const providerReceiptJson = JSON.stringify({ jobId, backend: request.backendName, status: "SUCCEEDED", transpilerSeed: seed });
  const metricsJson = JSON.stringify({ timestamps: { created: "2026-09-15T12:00:00Z", running: "2026-09-15T12:00:02Z", finished: "2026-09-15T12:00:03Z" } });
  const topologyJson = JSON.stringify({ backend: request.backendName, edges: [[0, 1], [1, 2]] });
  const capabilitiesJson = JSON.stringify({ backend: request.backendName, operationNames: ["cz", "measure", "rz", "sx", "x"] });
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
      provider: IBM_QUANTUM_COMPUTE_PROVIDER,
      backendDevice: request.backendName,
      jobId,
      status: "SUCCEEDED",
      timestamps: { submittedAt: "2026-09-15T12:00:00Z", startedAt: "2026-09-15T12:00:02Z", completedAt: "2026-09-15T12:00:03Z" },
      timing: { queueTimeMillis: 2_000, executionTimeMillis: 1_000, providerReportedTotalMillis: 3_000 },
      shotsRequested: 100, shotsCompleted: 100,
      problemBindingSha256: request.problemBindingSha256,
      optimizationProblemReportSha256: request.optimizationProblemReportSha256,
      optimizationModelSha256: request.optimizationModelSha256,
      circuitSha256: request.circuitSha256,
      transpilationApplied: true,
      transpiledCircuitSha256: tamperTranspiled ? sha256Text("tampered") : transpiledSha,
      calibrationEvidence: {
        status: "CAPTURED", calibrationId: "ibm-properties-contract-alpha", capturedAt: "2026-09-15T11:59:00Z",
        providerReportedAt: "2026-09-15T11:59:00Z", metadataSha256: calibrationSha,
      },
      rawResultSha256: rawSha,
      measurementCounts: { "010": 40, "110": 60 },
      hardwareIdentity: {
        manufacturer: "IBM", deviceId: request.backendName, deviceType: "QPU",
        topologySha256: topologySha, capabilitiesSha256: capabilitiesSha,
      },
      providerReceiptSha256: receiptSha,
      reproducibilityMetadata: {
        adapterId: IBM_QUANTUM_COMPUTE_ADAPTER_ID, adapterVersion: "1.0.0",
        providerSdk: "qiskit-ibm-runtime", providerSdkVersion: "0.49.0",
        compiler: "qiskit.generate_preset_pass_manager", compilerVersion: "2.5.2", seed,
      },
    },
    artifacts: {
      logicalQasm3,
      logicalQasm3Sha256: sha256Text(logicalQasm3),
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

test("unconfigured IBM provider remains blocked without invoking a bridge", async () => {
  const request = physicalRequest();
  let bridgeCalls = 0;
  const backend = createIbmQuantumComputeBackend({ bridgeRunner: async () => { bridgeCalls += 1; throw new Error("must not run"); } });
  const execution = await backend.execute(request);
  assert.equal(execution.verdict, "NOT_TESTED");
  assert.equal(execution.executionReceipt, null);
  assert.equal(bridgeCalls, 0);
});

test("partial IBM provider configuration fails closed instead of silently degrading", () => {
  assert.throws(
    () => createIbmQuantumComputeBackend({ apiKey: "secret", instanceCrn: "crn:v1", backendName: "ibm_contract_qpu_alpha" }),
    /requires apiKey, instanceCrn, backendName, and evidenceSink together/,
  );
});

test("configured IBM adapter sends hash-bound logical QASM through bridge and preserves evidence", async () => {
  const physical = physicalRequest();
  let observedRequest = null;
  let preserved = null;
  const backend = createIbmQuantumComputeBackend({
    apiKey: "contract-secret-not-a-real-credential",
    instanceCrn: "crn:v1:contract-only",
    backendName: "ibm_contract_qpu_alpha",
    evidenceSink: async (bundle) => { preserved = bundle; },
    bridgeRunner: async ({ request, apiKey, instanceCrn }) => {
      observedRequest = request;
      assert.equal(apiKey, "contract-secret-not-a-real-credential");
      assert.equal(instanceCrn, "crn:v1:contract-only");
      assert.equal(JSON.stringify(request).includes(apiKey), false);
      assert.equal(JSON.stringify(request).includes(instanceCrn), false);
      const { logicalCompilation } = buildIbmBridgeRequestForContractTest({ physicalRequest: physical, backendName: request.backendName });
      return bridgeResponseFor(request, logicalCompilation);
    },
  });
  const execution = await backend.execute(physical);
  assert.equal(execution.verdict, "PASS");
  assert.equal(execution.backendFamily, "PHYSICAL_QPU");
  assert.equal(execution.executionReceipt.provider, IBM_QUANTUM_COMPUTE_PROVIDER);
  assert.equal(execution.executionReceipt.backendDevice, "ibm_contract_qpu_alpha");
  assert.equal(execution.executionReceipt.shotsCompleted, 100);
  assert.equal(execution.executionReceipt.measurementCounts["110"], 60);
  assert.equal(execution.executionReceipt.reproducibilityMetadata.seed, null);
  assert.equal(observedRequest.transpilerSeed, null);
  assert.equal(observedRequest.logicalCircuitArtifact.format, "OPENQASM_3");
  assert.equal(observedRequest.logicalCircuitArtifact.sourceCircuitSha256, physical.circuitPayload.circuitSha256);
  assert.match(observedRequest.logicalCircuitArtifact.qasm3, /^OPENQASM 3\.0;/);
  assert.equal(preserved.evidence.jobId, "contract-job-alpha-1");
  assert.equal(preserved.artifacts.transpiledQasm3Sha256, execution.executionReceipt.transpiledCircuitSha256);

  const judged = buildQuantumJudgeComparison({
    optimizationProblemReport: physical.optimizationProblemReport,
    baselineProfile: baselineProfile(),
    quantumExecution: execution,
  });
  assert.equal(judged.verdict, "PASS");
  assert.equal(judged.quantumAdvantageClaimAllowed, false);
  assert.equal(judged.candidate.candidateSource, "PHYSICAL_QPU_MEASUREMENT_COUNTS");
});

test("configured IBM adapter binds an explicit transpiler seed into request receipt and evidence", async () => {
  const physical = physicalRequest();
  let preserved = null;
  const backend = createIbmQuantumComputeBackend({
    apiKey: "contract-secret-not-a-real-credential",
    instanceCrn: "crn:v1:contract-only",
    backendName: "ibm_contract_qpu_alpha",
    transpilerSeed: 1337,
    evidenceSink: async (bundle) => { preserved = bundle; },
    bridgeRunner: async ({ request }) => {
      assert.equal(request.transpilerSeed, 1337);
      const { logicalCompilation } = buildIbmBridgeRequestForContractTest({
        physicalRequest: physical,
        backendName: request.backendName,
        transpilerSeed: 1337,
      });
      return bridgeResponseFor(request, logicalCompilation);
    },
  });
  const execution = await backend.execute(physical);
  assert.equal(execution.verdict, "PASS");
  assert.equal(execution.executionReceipt.reproducibilityMetadata.seed, "1337");
  assert.equal(preserved.bridgeRequest.transpilerSeed, 1337);
  assert.equal(preserved.evidence.reproducibilityMetadata.seed, "1337");
});

test("IBM adapter rejects transpiler seed drift and invalid seed ranges", () => {
  const physical = physicalRequest();
  const { request, logicalCompilation } = buildIbmBridgeRequestForContractTest({
    physicalRequest: physical,
    backendName: "ibm_contract_qpu_alpha",
    transpilerSeed: 42,
  });
  const response = bridgeResponseFor(request, logicalCompilation);
  response.evidence.reproducibilityMetadata.seed = "43";
  assert.throws(
    () => validateIbmBridgeResponse(response, {
      logicalCompilation,
      backendName: request.backendName,
      transpilerSeed: 42,
    }),
    /transpiler seed binding mismatch/,
  );
  assert.throws(
    () => buildIbmBridgeRequestForContractTest({ physicalRequest: physical, backendName: request.backendName, transpilerSeed: -1 }),
    /transpilerSeed must be integer/,
  );
  assert.throws(
    () => buildIbmBridgeRequestForContractTest({
      physicalRequest: physical,
      backendName: request.backendName,
      transpilerSeed: IBM_QPU_MAX_TRANSPILER_SEED + 1,
    }),
    /transpilerSeed must be integer/,
  );
});

test("IBM bridge artifact digest drift is rejected before provider evidence is accepted", () => {
  const physical = physicalRequest();
  const { request, logicalCompilation } = buildIbmBridgeRequestForContractTest({ physicalRequest: physical, backendName: "ibm_contract_qpu_alpha" });
  const response = bridgeResponseFor(request, logicalCompilation, { tamperTranspiled: true });
  assert.throws(
    () => validateIbmBridgeResponse(response, { logicalCompilation, backendName: request.backendName }),
    /transpiled circuit digest drift/,
  );
});

test("filesystem evidence sink writes immutable content-addressed job bundle without credentials", async () => {
  const physical = physicalRequest();
  const { request, logicalCompilation } = buildIbmBridgeRequestForContractTest({ physicalRequest: physical, backendName: "ibm_contract_qpu_alpha" });
  const checked = validateIbmBridgeResponse(bridgeResponseFor(request, logicalCompilation), { logicalCompilation, backendName: request.backendName });
  const root = await mkdtemp(join(tmpdir(), "nexus-ibm-qpu-evidence-"));
  try {
    const sink = createIbmFilesystemEvidenceSink({ rootDir: root });
    const first = await sink(checked);
    const second = await sink(checked);
    assert.equal(first.jobDir, second.jobDir);
    assert.equal(first.manifestSha256, second.manifestSha256);
    const manifest = JSON.parse(await readFile(join(first.jobDir, "manifest.json"), "utf8"));
    assert.equal(manifest.provider, IBM_QUANTUM_COMPUTE_PROVIDER);
    assert.equal(manifest.jobId, "contract-job-alpha-1");
    assert.equal(manifest.transpiledCircuitSha256, checked.evidence.transpiledCircuitSha256);
    assert.equal(manifest.transpilerSeed, null);
    const transpiled = await readFile(join(first.jobDir, "transpiled.openqasm3"), "utf8");
    assert.equal(sha256Text(transpiled), checked.evidence.transpiledCircuitSha256);
    const manifestText = await readFile(join(first.jobDir, "manifest.json"), "utf8");
    assert.equal(manifestText.includes("contract-secret"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
