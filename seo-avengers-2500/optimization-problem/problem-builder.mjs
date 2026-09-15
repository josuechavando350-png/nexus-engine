import { createHash } from "node:crypto";

const SCHEMA_VERSION = 1;
const ENGINE_ID = "WALLE_OPTIMIZATION_PROBLEM_BUILDER_V1";
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ECONOMIC_OBJECTIVES = Object.freeze(["INCREMENTAL_CLIENTS_MILLI", "INCREMENTAL_REVENUE_MICROS"]);
const ESTIMATE_BASES = Object.freeze(["OBSERVED", "CONTRACTED", "ESTIMATED"]);
const MAX_CANDIDATES = 2_000;

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(typeof value === "string" ? value.normalize("NFC") : value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("optimization values must be safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, item]) => [key.normalize("NFC"), item])
      .sort(([left], [right]) => compareStrings(left, right));
    const seen = new Set();
    return `{${entries.map(([key, item]) => {
      if (seen.has(key)) throw new TypeError("normalized mapping key collision");
      seen.add(key);
      return `${JSON.stringify(key)}:${canonicalJson(item)}`;
    }).join(",")}}`;
  }
  throw new TypeError("optimization values must be JSON-compatible");
}

function sha256Canonical(value) {
  return `sha256:${createHash("sha256").update(Buffer.from(canonicalJson(value), "utf8")).digest("hex")}`;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`unexpected ${label} keys`);
  }
}

function stringValue(value, label, { pattern = null, maxBytes = 16_384 } = {}) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.normalize("NFC").trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  if (Buffer.byteLength(normalized, "utf8") > maxBytes) throw new Error(`${label} exceeds size limit`);
  if (pattern !== null && !pattern.test(normalized)) throw new Error(`${label} has invalid format`);
  return normalized;
}

function integerValue(value, label, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer in range`);
  }
  return value;
}

function sha256Value(value, label) {
  if (typeof value !== "string" || !SHA256_RE.test(value)) throw new Error(`${label} must be sha256:<64 lowercase hex>`);
  return value;
}

function enumValue(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`${label} has unsupported value`);
  return value;
}

function validateDecisionReport(report) {
  exactKeys(
    report,
    [
      "calibrationContext",
      "decisionBoundary",
      "decisionPolicyId",
      "decisions",
      "engineId",
      "inputs",
      "interpretation",
      "reportSha256",
      "schemaVersion",
      "status",
      "summary",
      "warnings",
    ],
    "decision report",
  );
  if (report.schemaVersion !== SCHEMA_VERSION) throw new Error("decision report schema mismatch");
  if (report.engineId !== "WALLE_DECISION_ENGINE_V1") throw new Error("decision report engine mismatch");
  if (report.status !== "DECISION_READY") throw new Error("decision report must be DECISION_READY");
  if (report.interpretation !== "EVIDENCE_GATED_OPTIMIZATION_ELIGIBILITY_NOT_AUTONOMOUS_ACTION_OR_OUTCOME_FORECAST") {
    throw new Error("decision report interpretation mismatch");
  }
  if (report.decisionBoundary !== "NO_HIDDEN_SCORE_NO_AUTONOMOUS_SITE_ACTION_OPTIMIZATION_BUILDER_MUST_ENFORCE_BUDGET_CAPACITY_DEPENDENCIES_RISK_AND_POLICY") {
    throw new Error("decision report boundary mismatch");
  }
  const reportSha256 = sha256Value(report.reportSha256, "decision report hash");
  const { reportSha256: ignored, ...unsigned } = report;
  void ignored;
  if (sha256Canonical(unsigned) !== reportSha256) throw new Error("decision report hash mismatch");
  if (!Array.isArray(report.decisions) || report.decisions.length < 1 || report.decisions.length > MAX_CANDIDATES) {
    throw new Error("decision report decisions must contain 1..2000 rows");
  }

  const seenDecisionIds = new Set();
  const promoted = [];
  let economicObjective = null;
  for (const [index, row] of report.decisions.entries()) {
    exactKeys(
      row,
      [
        "decisionId",
        "economicObjective",
        "empiricalTransition",
        "exactGrowthProfileCalibrationReady",
        "optimizationEligibility",
        "pageUrl",
        "paretoFrontier",
        "paretoLayer",
        "priorityRank",
        "query",
        "reasons",
        "selectedTarget",
      ],
      `decision ${index}`,
    );
    const decisionId = sha256Value(row.decisionId, `decisionId ${index}`);
    if (seenDecisionIds.has(decisionId)) throw new Error(`duplicate decisionId:${decisionId}`);
    seenDecisionIds.add(decisionId);
    const query = stringValue(row.query, `decision query ${index}`, { maxBytes: 4_096 });
    const pageUrl = stringValue(row.pageUrl, `decision pageUrl ${index}`);
    const priorityRank = integerValue(row.priorityRank, `decision priorityRank ${index}`, 1, MAX_CANDIDATES);
    const paretoLayer = integerValue(row.paretoLayer, `decision paretoLayer ${index}`, 1, MAX_CANDIDATES);
    if (typeof row.paretoFrontier !== "boolean" || row.paretoFrontier !== (paretoLayer === 1)) {
      throw new Error(`decision pareto semantics mismatch ${index}`);
    }
    exactKeys(row.selectedTarget, ["feasibilityBand", "gapMilli", "rankTarget"], `decision selectedTarget ${index}`);
    const rankTarget = enumValue(row.selectedTarget.rankTarget, ["TOP_10", "TOP_3", "TOP_1"], `rankTarget ${index}`);
    const feasibilityBand = enumValue(row.selectedTarget.feasibilityBand, ["LOW", "MEDIUM", "HIGH"], `feasibilityBand ${index}`);
    const gapMilli = integerValue(row.selectedTarget.gapMilli, `gapMilli ${index}`, 1, 1_000_000_000);
    exactKeys(row.economicObjective, ["id", "scenarioValue"], `decision economicObjective ${index}`);
    const objectiveId = enumValue(row.economicObjective.id, ECONOMIC_OBJECTIVES, `economic objective ${index}`);
    const scenarioValue = integerValue(row.economicObjective.scenarioValue, `scenario value ${index}`, 0);
    if (economicObjective === null) economicObjective = objectiveId;
    if (objectiveId !== economicObjective) throw new Error("decision report mixes economic objectives");
    if (typeof row.exactGrowthProfileCalibrationReady !== "boolean") {
      throw new Error(`decision calibration readiness ${index} must be boolean`);
    }
    const eligibility = enumValue(
      row.optimizationEligibility,
      ["PROMOTE_TO_OPTIMIZATION", "HOLD_FOR_EVIDENCE"],
      `optimization eligibility ${index}`,
    );
    if (!Array.isArray(row.reasons) || row.reasons.some((reason) => typeof reason !== "string")) {
      throw new Error(`decision reasons ${index} must be an array of strings`);
    }
    if (eligibility === "PROMOTE_TO_OPTIMIZATION") {
      if (!row.exactGrowthProfileCalibrationReady || row.reasons.length !== 0) {
        throw new Error(`promoted decision has inconsistent evidence gates ${index}`);
      }
      if (!row.empiricalTransition || typeof row.empiricalTransition !== "object" || Array.isArray(row.empiricalTransition)) {
        throw new Error(`promoted decision requires empirical transition ${index}`);
      }
      exactKeys(
        row.empiricalTransition,
        ["distinctOpportunityCount", "empiricalProbabilityPpm", "horizonMs", "sampleCount", "status", "successCount"],
        `empirical transition ${index}`,
      );
      if (row.empiricalTransition.status !== "EMPIRICAL_TRANSITION_FREQUENCY_READY") {
        throw new Error(`promoted decision transition is not ready ${index}`);
      }
      integerValue(row.empiricalTransition.horizonMs, `transition horizon ${index}`, 1);
      const sampleCount = integerValue(row.empiricalTransition.sampleCount, `transition sample count ${index}`, 1, 100_000);
      integerValue(row.empiricalTransition.distinctOpportunityCount, `transition distinct count ${index}`, 1, 100_000);
      integerValue(row.empiricalTransition.successCount, `transition success count ${index}`, 0, sampleCount);
      integerValue(row.empiricalTransition.empiricalProbabilityPpm, `transition frequency ${index}`, 0, 1_000_000);
      promoted.push(Object.freeze({
        decisionId,
        query,
        pageUrl,
        priorityRank,
        paretoLayer,
        paretoFrontier: row.paretoFrontier,
        rankTarget,
        feasibilityBand,
        gapMilli,
        objectiveId,
        scenarioValue,
        empiricalTransition: Object.freeze({
          horizonMs: row.empiricalTransition.horizonMs,
          sampleCount: row.empiricalTransition.sampleCount,
          distinctOpportunityCount: row.empiricalTransition.distinctOpportunityCount,
          successCount: row.empiricalTransition.successCount,
          empiricalProbabilityPpm: row.empiricalTransition.empiricalProbabilityPpm,
        }),
      }));
    }
  }
  if (promoted.length < 1) throw new Error("decision report contains no promoted optimization candidates");
  return Object.freeze({ reportSha256, economicObjective, promoted: Object.freeze(promoted) });
}

function validatePlanningProfile(profile, promoted) {
  exactKeys(
    profile,
    [
      "budget_micros",
      "dependency_edges",
      "editorial_capacity_units",
      "engineering_capacity_units",
      "maximum_selected",
      "mutex_groups",
      "planning_items",
      "profile_id",
      "provenance",
      "risk_capacity_units",
      "schema_version",
    ],
    "planning profile",
  );
  if (profile.schema_version !== SCHEMA_VERSION) throw new Error("unsupported planning profile schema");
  const profileId = stringValue(profile.profile_id, "planning profile_id", { pattern: PROFILE_ID_RE, maxBytes: 128 });
  const provenance = stringValue(profile.provenance, "planning provenance", { maxBytes: 4_096 });
  const budgetMicros = integerValue(profile.budget_micros, "budget_micros", 0);
  const editorialCapacityUnits = integerValue(profile.editorial_capacity_units, "editorial_capacity_units", 0);
  const engineeringCapacityUnits = integerValue(profile.engineering_capacity_units, "engineering_capacity_units", 0);
  const riskCapacityUnits = integerValue(profile.risk_capacity_units, "risk_capacity_units", 0);
  const maximumSelected = integerValue(profile.maximum_selected, "maximum_selected", 1, promoted.length);

  if (!Array.isArray(profile.planning_items) || profile.planning_items.length !== promoted.length) {
    throw new Error("planning_items must exactly cover all promoted decisions");
  }
  const promotedIds = new Set(promoted.map((row) => row.decisionId));
  const planningById = new Map();
  for (const [index, item] of profile.planning_items.entries()) {
    exactKeys(
      item,
      ["cost_micros", "decision_id", "editorial_units", "engineering_units", "estimate_basis", "risk_units"],
      `planning item ${index}`,
    );
    const decisionId = sha256Value(item.decision_id, `planning decision_id ${index}`);
    if (!promotedIds.has(decisionId)) throw new Error(`planning item references non-promoted decision:${decisionId}`);
    if (planningById.has(decisionId)) throw new Error(`duplicate planning item:${decisionId}`);
    planningById.set(decisionId, Object.freeze({
      decisionId,
      costMicros: integerValue(item.cost_micros, `cost_micros ${index}`, 0),
      editorialUnits: integerValue(item.editorial_units, `editorial_units ${index}`, 0),
      engineeringUnits: integerValue(item.engineering_units, `engineering_units ${index}`, 0),
      riskUnits: integerValue(item.risk_units, `risk_units ${index}`, 0),
      estimateBasis: enumValue(item.estimate_basis, ESTIMATE_BASES, `estimate_basis ${index}`),
    }));
  }
  for (const decisionId of promotedIds) {
    if (!planningById.has(decisionId)) throw new Error(`missing planning item:${decisionId}`);
  }

  if (!Array.isArray(profile.dependency_edges) || profile.dependency_edges.length > MAX_CANDIDATES * 8) {
    throw new Error("dependency_edges must be a bounded array");
  }
  const edgeKeys = new Set();
  const dependencies = [];
  const graph = new Map([...promotedIds].map((id) => [id, []]));
  for (const [index, edge] of profile.dependency_edges.entries()) {
    exactKeys(edge, ["decision_id", "requires_decision_id"], `dependency edge ${index}`);
    const decisionId = sha256Value(edge.decision_id, `dependency decision_id ${index}`);
    const requiresDecisionId = sha256Value(edge.requires_decision_id, `dependency requires_decision_id ${index}`);
    if (!promotedIds.has(decisionId) || !promotedIds.has(requiresDecisionId)) {
      throw new Error(`dependency edge references non-promoted decision ${index}`);
    }
    if (decisionId === requiresDecisionId) throw new Error(`self dependency is forbidden:${decisionId}`);
    const key = `${decisionId}->${requiresDecisionId}`;
    if (edgeKeys.has(key)) throw new Error(`duplicate dependency edge:${key}`);
    edgeKeys.add(key);
    graph.get(decisionId).push(requiresDecisionId);
    dependencies.push(Object.freeze({ decisionId, requiresDecisionId }));
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error("dependency cycle is forbidden in V1");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of graph.get(id)) visit(next);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of graph.keys()) visit(id);

  if (!Array.isArray(profile.mutex_groups) || profile.mutex_groups.length > MAX_CANDIDATES) {
    throw new Error("mutex_groups must be a bounded array");
  }
  const groupIds = new Set();
  const mutexGroups = [];
  for (const [index, group] of profile.mutex_groups.entries()) {
    exactKeys(group, ["decision_ids", "group_id"], `mutex group ${index}`);
    const groupId = stringValue(group.group_id, `mutex group_id ${index}`, { pattern: TOKEN_RE, maxBytes: 256 });
    if (groupIds.has(groupId)) throw new Error(`duplicate mutex group_id:${groupId}`);
    groupIds.add(groupId);
    if (!Array.isArray(group.decision_ids) || group.decision_ids.length < 2 || group.decision_ids.length > promoted.length) {
      throw new Error(`mutex group ${index} must contain 2..candidateCount decision_ids`);
    }
    const ids = group.decision_ids.map((id, memberIndex) => sha256Value(id, `mutex decision_id ${index}:${memberIndex}`));
    if (new Set(ids).size !== ids.length) throw new Error(`mutex group ${index} contains duplicate decision_ids`);
    if (ids.some((id) => !promotedIds.has(id))) throw new Error(`mutex group ${index} references non-promoted decision`);
    mutexGroups.push(Object.freeze({ groupId, decisionIds: Object.freeze([...ids].sort(compareStrings)) }));
  }

  const canonicalProfile = {
    schema_version: SCHEMA_VERSION,
    profile_id: profileId,
    provenance,
    budget_micros: budgetMicros,
    editorial_capacity_units: editorialCapacityUnits,
    engineering_capacity_units: engineeringCapacityUnits,
    risk_capacity_units: riskCapacityUnits,
    maximum_selected: maximumSelected,
    planning_items: [...planningById.values()].sort((left, right) => compareStrings(left.decisionId, right.decisionId)).map((item) => ({
      decision_id: item.decisionId,
      cost_micros: item.costMicros,
      editorial_units: item.editorialUnits,
      engineering_units: item.engineeringUnits,
      risk_units: item.riskUnits,
      estimate_basis: item.estimateBasis,
    })),
    dependency_edges: dependencies
      .sort((left, right) => compareStrings(left.decisionId, right.decisionId) || compareStrings(left.requiresDecisionId, right.requiresDecisionId))
      .map((edge) => ({ decision_id: edge.decisionId, requires_decision_id: edge.requiresDecisionId })),
    mutex_groups: mutexGroups
      .sort((left, right) => compareStrings(left.groupId, right.groupId))
      .map((group) => ({ group_id: group.groupId, decision_ids: group.decisionIds })),
  };

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    profileId,
    provenance,
    budgetMicros,
    editorialCapacityUnits,
    engineeringCapacityUnits,
    riskCapacityUnits,
    maximumSelected,
    planningById,
    dependencies: Object.freeze(dependencies),
    mutexGroups: Object.freeze(mutexGroups),
    sha256: sha256Canonical(canonicalProfile),
  });
}

function resourceCoefficients(variables, field) {
  return Object.freeze(variables.map((variable) => Object.freeze({ decisionId: variable.decisionId, value: variable.resources[field] })));
}

export function buildOptimizationProblemReport({ decisionReport, planningProfile }) {
  const decision = validateDecisionReport(decisionReport);
  const profile = validatePlanningProfile(planningProfile, decision.promoted);

  const variables = Object.freeze(decision.promoted
    .map((candidate) => {
      const planning = profile.planningById.get(candidate.decisionId);
      return Object.freeze({
        decisionId: candidate.decisionId,
        variableType: "BINARY",
        query: candidate.query,
        pageUrl: candidate.pageUrl,
        priorityRank: candidate.priorityRank,
        paretoLayer: candidate.paretoLayer,
        paretoFrontier: candidate.paretoFrontier,
        selectedTarget: Object.freeze({
          rankTarget: candidate.rankTarget,
          feasibilityBand: candidate.feasibilityBand,
          gapMilli: candidate.gapMilli,
        }),
        objectiveCoefficient: candidate.scenarioValue,
        resources: Object.freeze({
          costMicros: planning.costMicros,
          editorialUnits: planning.editorialUnits,
          engineeringUnits: planning.engineeringUnits,
          riskUnits: planning.riskUnits,
          estimateBasis: planning.estimateBasis,
        }),
        empiricalTransitionContext: candidate.empiricalTransition,
      });
    })
    .sort((left, right) => left.priorityRank - right.priorityRank || compareStrings(left.decisionId, right.decisionId)));

  const resourceConstraints = Object.freeze([
    Object.freeze({ constraintId: "BUDGET_MICROS", relation: "LE", limit: profile.budgetMicros, coefficients: resourceCoefficients(variables, "costMicros") }),
    Object.freeze({ constraintId: "EDITORIAL_CAPACITY_UNITS", relation: "LE", limit: profile.editorialCapacityUnits, coefficients: resourceCoefficients(variables, "editorialUnits") }),
    Object.freeze({ constraintId: "ENGINEERING_CAPACITY_UNITS", relation: "LE", limit: profile.engineeringCapacityUnits, coefficients: resourceCoefficients(variables, "engineeringUnits") }),
    Object.freeze({ constraintId: "RISK_CAPACITY_UNITS", relation: "LE", limit: profile.riskCapacityUnits, coefficients: resourceCoefficients(variables, "riskUnits") }),
    Object.freeze({ constraintId: "MAXIMUM_SELECTED", relation: "LE", limit: profile.maximumSelected, coefficients: Object.freeze(variables.map((variable) => Object.freeze({ decisionId: variable.decisionId, value: 1 }))) }),
  ]);
  const dependencyConstraints = Object.freeze(profile.dependencies
    .map((edge) => Object.freeze({
      constraintId: `DEPENDENCY:${edge.decisionId}:${edge.requiresDecisionId}`,
      relation: "X_LE_REQUIRES_X",
      decisionId: edge.decisionId,
      requiresDecisionId: edge.requiresDecisionId,
    }))
    .sort((left, right) => compareStrings(left.constraintId, right.constraintId)));
  const mutexConstraints = Object.freeze(profile.mutexGroups
    .map((group) => Object.freeze({
      constraintId: `MUTEX:${group.groupId}`,
      relation: "SUM_LE",
      limit: 1,
      decisionIds: group.decisionIds,
    }))
    .sort((left, right) => compareStrings(left.constraintId, right.constraintId)));

  const objective = Object.freeze({
    sense: "MAXIMIZE",
    id: decision.economicObjective,
    coefficientSemantics: "BOUNDED_SCENARIO_VALUE_NOT_FORECAST_OR_PROBABILITY_ADJUSTED_VALUE",
    coefficients: Object.freeze(variables.map((variable) => Object.freeze({
      decisionId: variable.decisionId,
      value: variable.objectiveCoefficient,
    }))),
  });
  const constraints = Object.freeze({ resourceConstraints, dependencyConstraints, mutexConstraints });
  const model = Object.freeze({ objective, variables, constraints });
  const modelSha256 = sha256Canonical(model);
  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    engineId: ENGINE_ID,
    status: "OPTIMIZATION_PROBLEM_READY",
    interpretation: "BINARY_PORTFOLIO_FORMULATION_NOT_SOLVER_RESULT_OR_OUTCOME_FORECAST",
    decisionReportSha256: decision.reportSha256,
    planningProfile: Object.freeze({
      schemaVersion: profile.schemaVersion,
      profileId: profile.profileId,
      provenance: profile.provenance,
      budgetMicros: profile.budgetMicros,
      editorialCapacityUnits: profile.editorialCapacityUnits,
      engineeringCapacityUnits: profile.engineeringCapacityUnits,
      riskCapacityUnits: profile.riskCapacityUnits,
      maximumSelected: profile.maximumSelected,
      sha256: profile.sha256,
    }),
    model,
    summary: Object.freeze({
      candidateCount: variables.length,
      dependencyConstraintCount: dependencyConstraints.length,
      mutexConstraintCount: mutexConstraints.length,
      resourceConstraintCount: resourceConstraints.length,
      modelSha256,
    }),
    decisionBoundary: "FORMULATION_ONLY_NO_SOLVER_RESULT_NO_AUTONOMOUS_SITE_ACTION",
    warnings: Object.freeze([
      "NO_RANK_GUARANTEE",
      "NO_CAUSAL_SEO_LIFT_CLAIM",
      "NO_TRAFFIC_LEAD_CLIENT_OR_REVENUE_GUARANTEE",
      "OBJECTIVE_COEFFICIENTS_ARE_BOUNDED_SCENARIO_VALUES_NOT_FORECASTS",
      "EMPIRICAL_TRANSITION_FREQUENCY_IS_CONTEXT_ONLY_AND_NOT_MULTIPLIED_INTO_OBJECTIVE",
      "RISK_UNITS_ARE_EXPLICIT_POLICY_CAPACITY_POINTS_NOT_PROBABILITY",
      "RESOURCE_ESTIMATES_PRESERVE_EXPLICIT_INPUT_BASIS",
      "PROBLEM_BUILDER_DOES_NOT_SOLVE_OR_EXECUTE_SITE_CHANGES",
    ]),
  };
  return Object.freeze({ ...unsigned, reportSha256: sha256Canonical(unsigned) });
}

export function canonicalOptimizationValueSha256(value) {
  return sha256Canonical(value);
}
