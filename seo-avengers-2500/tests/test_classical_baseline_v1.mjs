import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildClassicalBaselineReport,
  CLASSICAL_BASELINE_SEARCH_ORDER_POLICY,
  CLASSICAL_BASELINE_TIE_BREAK_POLICY,
} from "../classical-baseline/baseline-solver.mjs";
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

function candidate(name, priorityRank, scenarioValue) {
  return {
    decisionId: sha256Text(`decision:${name}`),
    query: `${name} legal`,
    pageUrl: `/${name}`,
    priorityRank,
    paretoLayer: 1,
    paretoFrontier: true,
    selectedTarget: { rankTarget: "TOP_3", feasibilityBand: "MEDIUM", gapMilli: 8_000 },
    economicObjective: { id: "INCREMENTAL_REVENUE_MICROS", scenarioValue },
    empiricalTransition: {
      horizonMs: 2_592_000_000,
      status: "EMPIRICAL_TRANSITION_FREQUENCY_READY",
      successCount: 3,
      sampleCount: 5,
      distinctOpportunityCount: 4,
      empiricalProbabilityPpm: 600_000,
    },
    exactGrowthProfileCalibrationReady: true,
    optimizationEligibility: "PROMOTE_TO_OPTIMIZATION",
    reasons: [],
  };
}

function decisionReport(specs) {
  const decisions = specs.map((spec, index) => candidate(spec.name, index + 1, spec.value));
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
      prioritizedCandidateCount: decisions.length,
      promotedToOptimizationCount: decisions.length,
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

function planningProfile(report, specs, options = {}) {
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const byNameDecision = new Map(report.decisions.map((row) => [row.query.split(" ")[0], row.decisionId]));
  const sum = (field) => specs.reduce((total, spec) => total + (spec[field] ?? 0), 0);
  return {
    schema_version: 1,
    profile_id: options.profileId ?? "classical-baseline-problem",
    provenance: "synthetic explicit planning resources for deterministic baseline tests",
    budget_micros: options.budget ?? sum("cost"),
    editorial_capacity_units: options.editorial ?? sum("editorial"),
    engineering_capacity_units: options.engineering ?? sum("engineering"),
    risk_capacity_units: options.risk ?? sum("risk"),
    maximum_selected: options.maximumSelected ?? specs.length,
    planning_items: report.decisions.map((row) => {
      const name = row.query.split(" ")[0];
      const spec = byName.get(name);
      return {
        decision_id: row.decisionId,
        cost_micros: spec.cost ?? 0,
        editorial_units: spec.editorial ?? 0,
        engineering_units: spec.engineering ?? 0,
        risk_units: spec.risk ?? 0,
        estimate_basis: "ESTIMATED",
      };
    }),
    dependency_edges: (options.dependencies ?? []).map(([dependent, required]) => ({
      decision_id: byNameDecision.get(dependent),
      requires_decision_id: byNameDecision.get(required),
    })),
    mutex_groups: (options.mutexGroups ?? []).map(([groupId, names]) => ({
      group_id: groupId,
      decision_ids: names.map((name) => byNameDecision.get(name)),
    })),
  };
}

function problemFrom(specs, options = {}) {
  const decisions = decisionReport(specs);
  return buildOptimizationProblemReport({
    decisionReport: decisions,
    planningProfile: planningProfile(decisions, specs, options),
  });
}

function baselineProfile(overrides = {}) {
  return {
    schema_version: 1,
    profile_id: "classical-baseline-test",
    provenance: "deterministic branch-and-bound test policy",
    maximum_candidates: 128,
    node_budget: 100_000,
    search_order_policy: CLASSICAL_BASELINE_SEARCH_ORDER_POLICY,
    tie_break_policy: CLASSICAL_BASELINE_TIE_BREAK_POLICY,
    ...overrides,
  };
}

function solve(specs, options = {}, profile = baselineProfile()) {
  const problem = problemFrom(specs, options);
  return { problem, report: buildClassicalBaselineReport({ optimizationProblemReport: problem, baselineProfile: profile }) };
}

function rehashProblem(problem) {
  problem.summary.modelSha256 = sha256Canonical(problem.model);
  const { reportSha256: ignored, ...unsigned } = problem;
  void ignored;
  problem.reportSha256 = sha256Canonical(unsigned);
  return problem;
}

test("branch-and-bound improves a deliberately suboptimal greedy incumbent and proves the optimum", () => {
  const specs = [
    { name: "alpha", value: 10, cost: 10 },
    { name: "beta", value: 9, cost: 5 },
    { name: "gamma", value: 9, cost: 5 },
  ];
  const { problem, report } = solve(specs, { budget: 10, maximumSelected: 2 });
  const ids = Object.fromEntries(problem.model.variables.map((row) => [row.query.split(" ")[0], row.decisionId]));
  assert.equal(report.status, "OPTIMAL");
  assert.equal(report.solution.optimalityProven, true);
  assert.equal(report.solution.objectiveValueDecimal, "18");
  assert.deepEqual(report.solution.selectedDecisionIds, [ids.beta, ids.gamma].sort());
  assert.ok(report.solution.search.incumbentUpdates >= 2);
  assert.equal(report.solution.optimalityGapAbsoluteDecimal, "0");
});

test("all resource capacities and maximum-selected are enforced by the same exact model", () => {
  const specs = [
    { name: "alpha", value: 12, cost: 5, editorial: 4, engineering: 1, risk: 1 },
    { name: "beta", value: 11, cost: 4, editorial: 1, engineering: 4, risk: 1 },
    { name: "gamma", value: 10, cost: 4, editorial: 1, engineering: 1, risk: 4 },
  ];
  const { report } = solve(specs, { budget: 8, editorial: 4, engineering: 4, risk: 4, maximumSelected: 2 });
  assert.equal(report.status, "OPTIMAL");
  assert.ok(report.solution.resourceUsage.costMicros <= 8);
  assert.ok(report.solution.resourceUsage.editorialUnits <= 4);
  assert.ok(report.solution.resourceUsage.engineeringUnits <= 4);
  assert.ok(report.solution.resourceUsage.riskUnits <= 4);
  assert.ok(report.solution.selectedCount <= 2);
});

test("dependency implication is enforced and prerequisite precedes dependent in deterministic search order", () => {
  const specs = [
    { name: "base", value: 1, cost: 4 },
    { name: "dependent", value: 20, cost: 4 },
    { name: "alternative", value: 15, cost: 4 },
  ];
  const { problem, report } = solve(specs, { budget: 4, maximumSelected: 1, dependencies: [["dependent", "base"]] });
  const ids = Object.fromEntries(problem.model.variables.map((row) => [row.query.split(" ")[0], row.decisionId]));
  assert.equal(report.solution.objectiveValueDecimal, "15");
  assert.deepEqual(report.solution.selectedDecisionIds, [ids.alternative]);
  assert.ok(report.solution.search.searchOrderDecisionIds.indexOf(ids.base) < report.solution.search.searchOrderDecisionIds.indexOf(ids.dependent));
});

test("mutual-exclusion groups prevent incompatible choices", () => {
  const specs = [
    { name: "alpha", value: 10, cost: 1 },
    { name: "beta", value: 9, cost: 1 },
    { name: "gamma", value: 8, cost: 1 },
  ];
  const { problem, report } = solve(specs, { budget: 3, maximumSelected: 3, mutexGroups: [["choice", ["alpha", "beta"]]] });
  const ids = Object.fromEntries(problem.model.variables.map((row) => [row.query.split(" ")[0], row.decisionId]));
  assert.equal(report.solution.objectiveValueDecimal, "18");
  assert.deepEqual(report.solution.selectedDecisionIds, [ids.alpha, ids.gamma].sort());
});

test("equal objective solutions use explicit lower-resource deterministic tie-breaks", () => {
  const specs = [
    { name: "expensive", value: 10, cost: 5, risk: 2 },
    { name: "cheap", value: 10, cost: 3, risk: 2 },
  ];
  const { problem, report } = solve(specs, { budget: 5, risk: 2, maximumSelected: 1 });
  const cheapId = problem.model.variables.find((row) => row.query.startsWith("cheap ")).decisionId;
  assert.deepEqual(report.solution.selectedDecisionIds, [cheapId]);
  assert.equal(report.solution.resourceUsage.costMicros, 3);
});

test("aggregate objective safely exceeds Number.MAX_SAFE_INTEGER using decimal-string proof values", () => {
  const value = 8_000_000_000_000_000;
  const specs = [
    { name: "alpha", value, cost: 1 },
    { name: "beta", value, cost: 1 },
  ];
  const { report } = solve(specs, { budget: 2, maximumSelected: 2 });
  assert.equal(report.status, "OPTIMAL");
  assert.equal(report.solution.objectiveValueDecimal, "16000000000000000");
  assert.equal(report.solution.globalUpperBoundDecimal, "16000000000000000");
});

test("node-budget exhaustion is explicit and can never be relabeled optimal", () => {
  const specs = [
    { name: "alpha", value: 10, cost: 10 },
    { name: "beta", value: 9, cost: 5 },
    { name: "gamma", value: 9, cost: 5 },
  ];
  const { report } = solve(specs, { budget: 10, maximumSelected: 2 }, baselineProfile({ node_budget: 1 }));
  assert.equal(report.status, "FEASIBLE_NOT_PROVEN_OPTIMAL");
  assert.equal(report.solution.optimalityProven, false);
  assert.equal(report.solution.search.exploredNodes, 1);
  assert.ok(report.solution.search.frontierNodeCount > 0);
  assert.ok(BigInt(report.solution.globalUpperBoundDecimal) >= BigInt(report.solution.objectiveValueDecimal));
});

test("candidate limit is explicit and never silently truncates the optimization model", () => {
  const specs = [
    { name: "alpha", value: 10, cost: 1 },
    { name: "beta", value: 9, cost: 1 },
    { name: "gamma", value: 8, cost: 1 },
  ];
  const problem = problemFrom(specs, { budget: 3, maximumSelected: 3 });
  assert.throws(
    () => buildClassicalBaselineReport({ optimizationProblemReport: problem, baselineProfile: baselineProfile({ maximum_candidates: 2 }) }),
    /no silent truncation/,
  );
});

test("unsupported search or tie-break policies fail closed", () => {
  const problem = problemFrom([{ name: "alpha", value: 10, cost: 1 }], { budget: 1, maximumSelected: 1 });
  assert.throws(
    () => buildClassicalBaselineReport({ optimizationProblemReport: problem, baselineProfile: baselineProfile({ search_order_policy: "MAGIC" }) }),
    /search_order_policy/,
  );
  assert.throws(
    () => buildClassicalBaselineReport({ optimizationProblemReport: problem, baselineProfile: baselineProfile({ tie_break_policy: "MAGIC" }) }),
    /tie_break_policy/,
  );
});

test("tampered problem report and internally inconsistent resource coefficients fail closed", () => {
  const problem = problemFrom([
    { name: "alpha", value: 10, cost: 5 },
    { name: "beta", value: 9, cost: 4 },
  ], { budget: 9, maximumSelected: 2 });
  const tamperedHash = structuredClone(problem);
  tamperedHash.model.variables[0].objectiveCoefficient += 1;
  assert.throws(
    () => buildClassicalBaselineReport({ optimizationProblemReport: tamperedHash, baselineProfile: baselineProfile() }),
    /optimization problem report hash mismatch/,
  );

  const inconsistent = structuredClone(problem);
  inconsistent.model.variables[0].resources.costMicros += 1;
  rehashProblem(inconsistent);
  assert.throws(
    () => buildClassicalBaselineReport({ optimizationProblemReport: inconsistent, baselineProfile: baselineProfile() }),
    /BUDGET_MICROS coefficient mismatch/,
  );
});

test("same exact model and policy produce byte-deterministic result identity", () => {
  const specs = [
    { name: "alpha", value: 10, cost: 10 },
    { name: "beta", value: 9, cost: 5 },
    { name: "gamma", value: 9, cost: 5 },
  ];
  const problem = problemFrom(specs, { budget: 10, maximumSelected: 2 });
  const profile = baselineProfile();
  const first = buildClassicalBaselineReport({ optimizationProblemReport: problem, baselineProfile: profile });
  const second = buildClassicalBaselineReport({ optimizationProblemReport: structuredClone(problem), baselineProfile: structuredClone(profile) });
  assert.deepEqual(first, second);
  assert.match(first.solution.selectedSetSha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.reportSha256, second.reportSha256);
});

test("profile changes are hash-bound and never rewrite optimization-problem identity", () => {
  const problem = problemFrom([
    { name: "alpha", value: 10, cost: 1 },
    { name: "beta", value: 9, cost: 1 },
  ], { budget: 2, maximumSelected: 2 });
  const first = buildClassicalBaselineReport({ optimizationProblemReport: problem, baselineProfile: baselineProfile({ node_budget: 100 }) });
  const second = buildClassicalBaselineReport({ optimizationProblemReport: problem, baselineProfile: baselineProfile({ node_budget: 101 }) });
  assert.notEqual(first.baselineProfile.sha256, second.baselineProfile.sha256);
  assert.notEqual(first.reportSha256, second.reportSha256);
  assert.equal(first.optimizationProblemReportSha256, second.optimizationProblemReportSha256);
  assert.equal(first.optimizationModelSha256, second.optimizationModelSha256);
});

test("baseline output explicitly refuses outcome forecasts and quantum-advantage claims", () => {
  const { report } = solve([{ name: "alpha", value: 10, cost: 1 }], { budget: 1, maximumSelected: 1 });
  assert.equal(report.interpretation, "DETERMINISTIC_CLASSICAL_BRANCH_AND_BOUND_BASELINE_NOT_OUTCOME_FORECAST_OR_QUANTUM_ADVANTAGE_CLAIM");
  assert.equal(report.decisionBoundary, "CLASSICAL_BASELINE_ONLY_NO_QUANTUM_ADVANTAGE_CLAIM_NO_AUTONOMOUS_SITE_ACTION");
  assert.ok(report.warnings.includes("NO_WALL_CLOCK_PERFORMANCE_CLAIM_IN_DETERMINISTIC_REPORT"));
  assert.ok(report.warnings.some((warning) => warning.startsWith("QUANTUM_ADVANTAGE_CANNOT_BE_CLAIMED_FROM_THIS")));
  assert.ok(report.warnings.includes("NODE_BUDGET_EXHAUSTION_MUST_NOT_BE_RELABELED_AS_OPTIMAL"));
});

test("production baseline layer has no network browser process remote solver publish site or control mutation authority", async () => {
  const engine = await readFile(new URL("../classical-baseline/baseline-solver.mjs", import.meta.url), "utf8");
  const tenant = await readFile(new URL("../classical-baseline/tenant-baseline.mjs", import.meta.url), "utf8");
  const source = `${engine}\n${tenant}`;
  for (const forbidden of [
    "node:http",
    "node:https",
    "node:net",
    "node:tls",
    "child_process",
    "fetch(",
    "playwright",
    "selenium",
    "publishAuthorizedProviderSnapshot",
    "setTenantEnabled",
    "appendTenantControl",
    "site_mutation",
    "external_link_creation",
    "remoteSolver",
  ]) {
    assert.ok(!source.includes(forbidden), `forbidden production capability: ${forbidden}`);
  }
  assert.ok(source.includes("buildTenantOptimizationProblem"));
  assert.ok(source.includes("readTenantEvidenceSnapshot"));
  assert.ok(source.includes("readTenantControl"));
});
