import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildOptimizationProblemReport } from "../optimization-problem/problem-builder.mjs";
import {
  buildQuantumHybridExperimentReport,
  QUANTUM_HYBRID_BACKEND_KIND,
  QUANTUM_HYBRID_PARAMETER_POLICY,
  QUANTUM_HYBRID_READOUT_POLICY,
} from "../quantum-hybrid/qaoa-experiment.mjs";

function compareStrings(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(typeof value === "string" ? value.normalize("NFC") : value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("test number must be safe integer");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(([k, v]) => [k.normalize("NFC"), v]).sort(([a], [b]) => compareStrings(a, b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new TypeError("invalid test JSON value");
}

function sha256Canonical(value) {
  return `sha256:${createHash("sha256").update(Buffer.from(canonicalJson(value), "utf8")).digest("hex")}`;
}

function sha256Text(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }

function promoted(name, rank, value) {
  return {
    decisionId: sha256Text(`qaoa:${name}`),
    query: `${name} legal`,
    pageUrl: `/${name}`,
    priorityRank: rank,
    paretoLayer: 1,
    paretoFrontier: true,
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
      prioritizationReportSha256: sha256Text("qaoa-prioritization"),
      rankTransitionReportSha256: sha256Text("qaoa-transition"),
      outcomeCalibrationReportSha256: sha256Text("qaoa-calibration"),
      rankContextReportSha256: sha256Text("qaoa-rank-context"),
      growthAssumptionProfileSha256: sha256Text("qaoa-growth"),
    },
    calibrationContext: {
      exactProfileReady: true,
      scenarioId: "BASE",
      growthAssumptionProfileSha256: sha256Text("qaoa-growth"),
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
  return { ...unsigned, reportSha256: sha256Canonical(unsigned) };
}

function planningProfile(report = decisionReport()) {
  const [alpha, beta, gamma] = report.decisions;
  return {
    schema_version: 1,
    profile_id: "qaoa-planning-test",
    provenance: "synthetic controlled portfolio used only for deterministic solver comparison tests",
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
}

function problem() {
  const source = decisionReport();
  return buildOptimizationProblemReport({ decisionReport: source, planningProfile: planningProfile(source) });
}

function baselineProfile(nodeBudget = 1_000) {
  return {
    schema_version: 1,
    profile_id: "qaoa-classical-reference",
    provenance: "deterministic branch-and-bound comparison policy",
    maximum_candidates: 16,
    node_budget: nodeBudget,
    search_order_policy: "DEPENDENCY_TOPOLOGICAL_OBJECTIVE_DESC_PRIORITY_ASC_ID",
    tie_break_policy: "LOWER_COST_THEN_RISK_THEN_EDITORIAL_THEN_ENGINEERING_THEN_FEWER_SELECTED_THEN_IDENTITY",
  };
}

function experimentProfile(maximumQubits = 8) {
  return {
    schema_version: 1,
    profile_id: "qaoa-statevector-test",
    provenance: "explicit deterministic statevector QAOA parameter grid; simulator only; no QPU claim",
    backend_kind: QUANTUM_HYBRID_BACKEND_KIND,
    maximum_qubits: maximumQubits,
    parameter_selection_policy: QUANTUM_HYBRID_PARAMETER_POLICY,
    candidate_readout_policy: QUANTUM_HYBRID_READOUT_POLICY,
    parameter_sets: [
      { parameter_set_id: "p1", gamma_microradians: [500_000], beta_microradians: [300_000] },
      { parameter_set_id: "p2", gamma_microradians: [1_000_000], beta_microradians: [600_000] },
      { parameter_set_id: "p3", gamma_microradians: [1_500_000], beta_microradians: [900_000] },
    ],
  };
}

function run({ optimizationProblemReport = problem(), classical = baselineProfile(), experiment = experimentProfile() } = {}) {
  return buildQuantumHybridExperimentReport({
    optimizationProblemReport,
    baselineProfile: classical,
    experimentProfile: experiment,
  });
}

test("controlled QAOA simulator competes against the exact same optimization problem and classical baseline", () => {
  const source = problem();
  const report = run({ optimizationProblemReport: source });
  assert.equal(report.status, "EXPERIMENT_COMPLETE");
  assert.equal(report.optimizationProblemReportSha256, source.reportSha256);
  assert.equal(report.optimizationModelSha256, source.summary.modelSha256);
  assert.equal(report.classicalReference.optimalityProven, true);
  assert.equal(report.classicalReference.objectiveValueDecimal, "15");
  assert.equal(report.quantumHybridCandidate.feasible, true);
  assert.equal(report.quantumHybridCandidate.hardwareExecution, false);
  assert.equal(report.quantumHybridCandidate.backendKind, "STATEVECTOR_QAOA_SIMULATOR");
});

test("simulator result never becomes a quantum advantage claim", () => {
  const report = run();
  assert.equal(report.comparison.quantumAdvantageClaimAllowed, false);
  assert.equal(report.comparison.quantumAdvantageVerdict, "NOT_DEMONSTRATED_SIMULATOR_ONLY");
  assert.ok(["OBJECTIVE_TIE", "CLASSICAL_OBJECTIVE_BETTER"].includes(report.comparison.objectiveComparison));
  assert.ok(BigInt(report.quantumHybridCandidate.objectiveValueDecimal) <= BigInt(report.classicalReference.objectiveValueDecimal));
  assert.match(report.interpretation, /NOT_QPU_HARDWARE_OR_QUANTUM_ADVANTAGE_PROOF/);
});

test("same problem profiles and parameter grid are byte deterministic", () => {
  const first = run();
  const second = run();
  assert.deepEqual(first, second);
  assert.equal(first.reportSha256, second.reportSha256);
});

test("QAOA readout remains feasible under budget capacity selection and dependency constraints", () => {
  const source = decisionReport();
  const [alpha, beta, gamma] = source.decisions;
  const report = buildQuantumHybridExperimentReport({
    optimizationProblemReport: buildOptimizationProblemReport({ decisionReport: source, planningProfile: planningProfile(source) }),
    baselineProfile: baselineProfile(),
    experimentProfile: experimentProfile(),
  });
  const selected = new Set(report.quantumHybridCandidate.selectedDecisionIds);
  if (selected.has(gamma.decisionId)) assert.equal(selected.has(beta.decisionId), true);
  assert.equal(selected.size <= 2, true);
  assert.equal(report.quantumHybridCandidate.resourceUsage.costMicros <= 9, true);
  assert.equal(selected.has(alpha.decisionId) && selected.has(beta.decisionId), false);
});

test("tampered optimization problem cannot enter the experiment through the classical validation boundary", () => {
  const source = problem();
  const tampered = structuredClone(source);
  tampered.model.variables[0].objectiveCoefficient += 1;
  assert.throws(() => run({ optimizationProblemReport: tampered }), /hash mismatch/);
});

test("statevector qubit limit is explicit and never silently truncates candidates", () => {
  assert.throws(() => run({ experiment: experimentProfile(2) }), /qubit limit/);
});

test("QPU hardware identity cannot be fabricated in simulator V1", () => {
  const profile = { ...experimentProfile(), backend_kind: "QPU" };
  assert.throws(() => run({ experiment: profile }), /simulator-only/);
});

test("parameter schedules require one common bounded QAOA depth", () => {
  const profile = experimentProfile();
  profile.parameter_sets = [
    profile.parameter_sets[0],
    { parameter_set_id: "bad-depth", gamma_microradians: [1, 2], beta_microradians: [1, 2] },
  ];
  assert.throws(() => run({ experiment: profile }), /same QAOA depth/);
  const malformed = experimentProfile();
  malformed.parameter_sets[0] = { ...malformed.parameter_sets[0], gamma_microradians: [6_283_186] };
  assert.throws(() => run({ experiment: malformed }), /integer in range/);
});

test("an unproven classical search makes the comparison inconclusive rather than granting candidate advantage", () => {
  const report = run({ classical: baselineProfile(1) });
  assert.equal(report.status, "INCONCLUSIVE_CLASSICAL_BASELINE_NOT_PROVEN");
  assert.equal(report.classicalReference.optimalityProven, false);
  assert.equal(report.comparison.quantumAdvantageClaimAllowed, false);
});

test("reported work units stay architecture-specific and no wall-clock speedup is claimed", () => {
  const report = run();
  assert.equal(report.quantumHybridCandidate.deterministicWorkUnit, "STATEVECTOR_BASIS_STATE_PARAMETER_LAYER");
  assert.equal(report.classicalReference.deterministicWorkUnit, "BRANCH_AND_BOUND_NODE");
  assert.ok(report.warnings.includes("NO_WALL_CLOCK_SPEEDUP_CLAIM"));
  assert.ok(report.warnings.includes("DETERMINISTIC_WORK_UNITS_ARE_NOT_CROSS_ARCHITECTURE_RUNTIME_EQUIVALENTS"));
});

test("production experiment boundary has no network QPU provider process publish or site mutation authority", async () => {
  const engine = await readFile(new URL("../quantum-hybrid/qaoa-experiment.mjs", import.meta.url), "utf8");
  const tenant = await readFile(new URL("../quantum-hybrid/tenant-experiment.mjs", import.meta.url), "utf8");
  const source = `${engine}\n${tenant}`;
  for (const forbidden of [
    "node:http", "node:https", "fetch(", "axios", "playwright", "puppeteer", "child_process", "spawn(", "exec(",
    "qiskit", "braket", "dwave", "ibm_quantum", "publish", "external-link", "writeFile(", "setTenantEnabled",
  ]) assert.equal(source.includes(forbidden), false, `forbidden production authority token: ${forbidden}`);
  assert.match(tenant, /buildTenantOptimizationProblem/);
  assert.match(tenant, /readTenantControl/);
  assert.match(tenant, /readTenantEvidenceSnapshot/);
});

test("experiment output explicitly distinguishes quantum algorithm simulation from quantum hardware", () => {
  const report = run();
  const serialized = JSON.stringify(report);
  assert.equal(report.quantumHybridCandidate.hardwareExecution, false);
  assert.ok(serialized.includes("STATEVECTOR_SIMULATION_IS_CLASSICAL_EXECUTION_OF_A_QUANTUM_ALGORITHM_NOT_QPU_HARDWARE"));
  for (const forbidden of ["quantumSpeedupProven", "quantumSupremacy", "qpuExecution:true", "rankGuarantee"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});
