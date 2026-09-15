import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildOptimizationProblemReport } from "../optimization-problem/problem-builder.mjs";

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(typeof value === "string" ? value.normalize("NFC") : value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("test values must be safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, item]) => [key.normalize("NFC"), item])
      .sort(([left], [right]) => compareStrings(left, right));
    const seen = new Set();
    return `{${entries.map(([key, item]) => {
      if (seen.has(key)) throw new Error("normalized key collision");
      seen.add(key);
      return `${JSON.stringify(key)}:${canonicalJson(item)}`;
    }).join(",")}}`;
  }
  throw new TypeError("test values must be JSON-compatible");
}

function sha256Canonical(value) {
  return `sha256:${createHash("sha256").update(Buffer.from(canonicalJson(value), "utf8")).digest("hex")}`;
}

function sha256Text(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function promotedDecision(name, priorityRank, scenarioValue, probabilityPpm) {
  return {
    decisionId: sha256Text(`decision:${name}`),
    query: `${name} legal`,
    pageUrl: `/${name}`,
    priorityRank,
    paretoLayer: 1,
    paretoFrontier: true,
    selectedTarget: { rankTarget: "TOP_3", feasibilityBand: "MEDIUM", gapMilli: 9_000 },
    economicObjective: { id: "INCREMENTAL_REVENUE_MICROS", scenarioValue },
    empiricalTransition: {
      horizonMs: 2_592_000_000,
      status: "EMPIRICAL_TRANSITION_FREQUENCY_READY",
      successCount: probabilityPpm === 250_000 ? 1 : 3,
      sampleCount: probabilityPpm === 250_000 ? 4 : 5,
      distinctOpportunityCount: 3,
      empiricalProbabilityPpm: probabilityPpm,
    },
    exactGrowthProfileCalibrationReady: true,
    optimizationEligibility: "PROMOTE_TO_OPTIMIZATION",
    reasons: [],
  };
}

function heldDecision() {
  return {
    decisionId: sha256Text("decision:held"),
    query: "held legal",
    pageUrl: "/held",
    priorityRank: 3,
    paretoLayer: 2,
    paretoFrontier: false,
    selectedTarget: { rankTarget: "TOP_10", feasibilityBand: "MEDIUM", gapMilli: 3_000 },
    economicObjective: { id: "INCREMENTAL_REVENUE_MICROS", scenarioValue: 900_000_000 },
    empiricalTransition: null,
    exactGrowthProfileCalibrationReady: false,
    optimizationEligibility: "HOLD_FOR_EVIDENCE",
    reasons: ["EMPIRICAL_TRANSITION_NOT_READY", "EXACT_GROWTH_PROFILE_CALIBRATION_NOT_READY"],
  };
}

function decisionReport() {
  const decisions = [
    promotedDecision("alpha", 1, 2_000_000_000, 600_000),
    promotedDecision("beta", 2, 1_500_000_000, 250_000),
    heldDecision(),
  ];
  const unsigned = {
    schemaVersion: 1,
    engineId: "WALLE_DECISION_ENGINE_V1",
    status: "DECISION_READY",
    interpretation: "EVIDENCE_GATED_OPTIMIZATION_ELIGIBILITY_NOT_AUTONOMOUS_ACTION_OR_OUTCOME_FORECAST",
    decisionPolicyId: "PROMOTE_ONLY_WITH_PRIORITIZATION_EMPIRICAL_TRANSITION_AND_EXACT_PROFILE_CALIBRATION",
    inputs: {
      prioritizationReportSha256: sha256Text("prioritization"),
      rankTransitionReportSha256: sha256Text("transition"),
      outcomeCalibrationReportSha256: sha256Text("calibration"),
      rankContextReportSha256: sha256Text("rank-context"),
      growthAssumptionProfileSha256: sha256Text("growth-profile"),
    },
    calibrationContext: {
      exactProfileReady: true,
      scenarioId: "BASE",
      growthAssumptionProfileSha256: sha256Text("growth-profile"),
      matchedRecordCount: 4,
      minimumRecords: 3,
      empiricalErrorStats: {},
      decisionBoundary: "CALIBRATION_QUALIFIES_EVIDENCE_BUT_DOES_NOT_REWRITE_SCENARIO_VALUE",
    },
    summary: {
      prioritizedCandidateCount: 3,
      promotedToOptimizationCount: 2,
      heldForEvidenceCount: 1,
      heldTransitionCount: 1,
      heldCalibrationCount: 1,
    },
    decisions,
    decisionBoundary: "NO_HIDDEN_SCORE_NO_AUTONOMOUS_SITE_ACTION_OPTIMIZATION_BUILDER_MUST_ENFORCE_BUDGET_CAPACITY_DEPENDENCIES_RISK_AND_POLICY",
    warnings: ["NO_RANK_GUARANTEE"],
  };
  return { ...unsigned, reportSha256: sha256Canonical(unsigned) };
}

function planningProfile(report = decisionReport()) {
  const [alpha, beta] = report.decisions.filter((row) => row.optimizationEligibility === "PROMOTE_TO_OPTIMIZATION");
  return {
    schema_version: 1,
    profile_id: "optimization-builder-test",
    provenance: "synthetic explicit resource estimates for deterministic formulation tests",
    budget_micros: 4_000_000_000,
    editorial_capacity_units: 7,
    engineering_capacity_units: 5,
    risk_capacity_units: 6,
    maximum_selected: 2,
    planning_items: [
      { decision_id: alpha.decisionId, cost_micros: 2_500_000_000, editorial_units: 4, engineering_units: 1, risk_units: 2, estimate_basis: "CONTRACTED" },
      { decision_id: beta.decisionId, cost_micros: 1_800_000_000, editorial_units: 2, engineering_units: 3, risk_units: 3, estimate_basis: "ESTIMATED" },
    ],
    dependency_edges: [{ decision_id: beta.decisionId, requires_decision_id: alpha.decisionId }],
    mutex_groups: [{ group_id: "landing-choice", decision_ids: [alpha.decisionId, beta.decisionId] }],
  };
}

function run(report = decisionReport(), profile = planningProfile(report)) {
  return buildOptimizationProblemReport({ decisionReport: report, planningProfile: profile });
}

test("builder emits only promoted decisions and preserves bounded scenario coefficients", () => {
  const source = decisionReport();
  const result = run(source);
  assert.equal(result.status, "OPTIMIZATION_PROBLEM_READY");
  assert.equal(result.summary.candidateCount, 2);
  assert.deepEqual(result.model.variables.map((row) => row.decisionId), source.decisions.slice(0, 2).map((row) => row.decisionId));
  assert.deepEqual(result.model.objective.coefficients.map((row) => row.value), [2_000_000_000, 1_500_000_000]);
  assert.equal(result.model.variables.some((row) => row.query === "held legal"), false);
});

test("empirical transition frequency remains context and is never probability-adjusted into objective", () => {
  const result = run();
  assert.equal(result.model.variables[0].empiricalTransitionContext.empiricalProbabilityPpm, 600_000);
  assert.equal(result.model.variables[0].objectiveCoefficient, 2_000_000_000);
  assert.equal(result.model.variables[1].empiricalTransitionContext.empiricalProbabilityPpm, 250_000);
  assert.equal(result.model.variables[1].objectiveCoefficient, 1_500_000_000);
  const serialized = JSON.stringify(result);
  for (const forbidden of ["expectedValue", "probabilityAdjusted", "decisionScore", "priorityScorePpm"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.ok(result.warnings.includes("EMPIRICAL_TRANSITION_FREQUENCY_IS_CONTEXT_ONLY_AND_NOT_MULTIPLIED_INTO_OBJECTIVE"));
});

test("budget capacity risk and maximum-selected constraints are encoded exactly", () => {
  const result = run();
  const constraints = Object.fromEntries(result.model.constraints.resourceConstraints.map((row) => [row.constraintId, row]));
  assert.equal(constraints.BUDGET_MICROS.limit, 4_000_000_000);
  assert.deepEqual(constraints.BUDGET_MICROS.coefficients.map((row) => row.value), [2_500_000_000, 1_800_000_000]);
  assert.equal(constraints.EDITORIAL_CAPACITY_UNITS.limit, 7);
  assert.deepEqual(constraints.EDITORIAL_CAPACITY_UNITS.coefficients.map((row) => row.value), [4, 2]);
  assert.equal(constraints.ENGINEERING_CAPACITY_UNITS.limit, 5);
  assert.deepEqual(constraints.ENGINEERING_CAPACITY_UNITS.coefficients.map((row) => row.value), [1, 3]);
  assert.equal(constraints.RISK_CAPACITY_UNITS.limit, 6);
  assert.deepEqual(constraints.RISK_CAPACITY_UNITS.coefficients.map((row) => row.value), [2, 3]);
  assert.equal(constraints.MAXIMUM_SELECTED.limit, 2);
});

test("dependency and mutual-exclusion constraints are explicit and hash-bound", () => {
  const report = decisionReport();
  const result = run(report);
  const [alpha, beta] = report.decisions;
  assert.deepEqual(result.model.constraints.dependencyConstraints, [{
    constraintId: `DEPENDENCY:${beta.decisionId}:${alpha.decisionId}`,
    relation: "X_LE_REQUIRES_X",
    decisionId: beta.decisionId,
    requiresDecisionId: alpha.decisionId,
  }]);
  assert.equal(result.model.constraints.mutexConstraints[0].relation, "SUM_LE");
  assert.equal(result.model.constraints.mutexConstraints[0].limit, 1);
  assert.deepEqual(result.model.constraints.mutexConstraints[0].decisionIds, [alpha.decisionId, beta.decisionId].sort());
  assert.match(result.summary.modelSha256, /^sha256:[0-9a-f]{64}$/);
});

test("planning input order is canonicalized without changing model or report identity", () => {
  const report = decisionReport();
  const profile = planningProfile(report);
  const first = run(report, profile);
  const second = run(report, {
    ...profile,
    planning_items: [...profile.planning_items].reverse(),
    mutex_groups: profile.mutex_groups.map((group) => ({ ...group, decision_ids: [...group.decision_ids].reverse() })),
  });
  assert.deepEqual(first.model, second.model);
  assert.equal(first.planningProfile.sha256, second.planningProfile.sha256);
  assert.equal(first.reportSha256, second.reportSha256);
});

test("planning items must exactly cover promoted decisions and reject held or unknown IDs", () => {
  const report = decisionReport();
  const profile = planningProfile(report);
  assert.throws(() => run(report, { ...profile, planning_items: profile.planning_items.slice(0, 1) }), /exactly cover/);
  const held = report.decisions[2];
  const replaced = [{ ...profile.planning_items[0], decision_id: held.decisionId }, profile.planning_items[1]];
  assert.throws(() => run(report, { ...profile, planning_items: replaced }), /non-promoted decision/);
});

test("self dependencies dependency cycles and unknown references fail closed", () => {
  const report = decisionReport();
  const profile = planningProfile(report);
  const [alpha, beta] = report.decisions;
  assert.throws(() => run(report, { ...profile, dependency_edges: [{ decision_id: alpha.decisionId, requires_decision_id: alpha.decisionId }] }), /self dependency/);
  assert.throws(() => run(report, { ...profile, dependency_edges: [
    { decision_id: alpha.decisionId, requires_decision_id: beta.decisionId },
    { decision_id: beta.decisionId, requires_decision_id: alpha.decisionId },
  ] }), /dependency cycle/);
  assert.throws(() => run(report, { ...profile, dependency_edges: [{ decision_id: alpha.decisionId, requires_decision_id: sha256Text("unknown") }] }), /non-promoted decision/);
});

test("malformed floats extra keys and impossible maximum-selected policy fail closed", () => {
  const report = decisionReport();
  const profile = planningProfile(report);
  const floating = structuredClone(profile);
  floating.planning_items[0].editorial_units = 1.5;
  assert.throws(() => run(report, floating), /integer in range/);
  assert.throws(() => run(report, { ...profile, hidden_weight: 999 }), /unexpected planning profile keys/);
  assert.throws(() => run(report, { ...profile, maximum_selected: 3 }), /integer in range/);
});

test("tampered Decision Engine report fails closed before formulation", () => {
  const report = decisionReport();
  const profile = planningProfile(report);
  report.decisions[0].economicObjective.scenarioValue += 1;
  assert.throws(() => run(report, profile), /decision report hash mismatch/);
});

test("resource-policy changes alter planning and report hashes without rewriting upstream evidence", () => {
  const report = decisionReport();
  const profile = planningProfile(report);
  const first = run(report, profile);
  const changed = run(report, { ...profile, budget_micros: profile.budget_micros + 1 });
  assert.notEqual(first.planningProfile.sha256, changed.planningProfile.sha256);
  assert.notEqual(first.summary.modelSha256, changed.summary.modelSha256);
  assert.notEqual(first.reportSha256, changed.reportSha256);
  assert.equal(first.decisionReportSha256, changed.decisionReportSha256);
});

test("problem output explicitly remains formulation-only and non-forecasting", () => {
  const result = run();
  assert.equal(result.interpretation, "BINARY_PORTFOLIO_FORMULATION_NOT_SOLVER_RESULT_OR_OUTCOME_FORECAST");
  assert.equal(result.decisionBoundary, "FORMULATION_ONLY_NO_SOLVER_RESULT_NO_AUTONOMOUS_SITE_ACTION");
  assert.ok(result.warnings.includes("OBJECTIVE_COEFFICIENTS_ARE_BOUNDED_SCENARIO_VALUES_NOT_FORECASTS"));
  assert.ok(result.warnings.includes("RISK_UNITS_ARE_EXPLICIT_POLICY_CAPACITY_POINTS_NOT_PROBABILITY"));
  assert.ok(result.warnings.includes("PROBLEM_BUILDER_DOES_NOT_SOLVE_OR_EXECUTE_SITE_CHANGES"));
});

test("production problem layer has no network solver process publish site mutation or control mutation authority", async () => {
  const engine = await readFile(new URL("../optimization-problem/problem-builder.mjs", import.meta.url), "utf8");
  const tenant = await readFile(new URL("../optimization-problem/tenant-problem.mjs", import.meta.url), "utf8");
  const source = `${engine}\n${tenant}`;
  for (const forbidden of [
    "node:http",
    "node:https",
    "node:net",
    "node:tls",
    "child_process",
    "fetch(",
    "publishAuthorizedProviderSnapshot",
    "setTenantEnabled",
    "appendTenantControl",
    "site_mutation",
    "external_link_creation",
    "solve(",
    "solver.solve",
  ]) {
    assert.ok(!source.includes(forbidden), `forbidden production capability: ${forbidden}`);
  }
  assert.ok(source.includes("buildTenantDecisionReport"));
  assert.ok(source.includes("readTenantEvidenceSnapshot"));
  assert.ok(source.includes("readTenantControl"));
});
