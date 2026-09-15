import { createHash } from "node:crypto";

const SCHEMA_VERSION = 1;
const ENGINE_ID = "WALLE_CLASSICAL_BASELINE_V1";
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_CANDIDATES = 128;
const MAX_NODE_BUDGET = 2_000_000;
const SEARCH_ORDER_POLICY = "DEPENDENCY_TOPOLOGICAL_OBJECTIVE_DESC_PRIORITY_ASC_ID";
const TIE_BREAK_POLICY = "LOWER_COST_THEN_RISK_THEN_EDITORIAL_THEN_ENGINEERING_THEN_FEWER_SELECTED_THEN_IDENTITY";
const RESOURCE_IDS = Object.freeze([
  "BUDGET_MICROS",
  "EDITORIAL_CAPACITY_UNITS",
  "ENGINEERING_CAPACITY_UNITS",
  "RISK_CAPACITY_UNITS",
  "MAXIMUM_SELECTED",
]);

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(typeof value === "string" ? value.normalize("NFC") : value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("classical baseline values must be safe integers");
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
  throw new TypeError("classical baseline values must be JSON-compatible");
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

function validateProfile(profile) {
  exactKeys(
    profile,
    ["maximum_candidates", "node_budget", "profile_id", "provenance", "schema_version", "search_order_policy", "tie_break_policy"],
    "classical baseline profile",
  );
  if (profile.schema_version !== SCHEMA_VERSION) throw new Error("unsupported classical baseline profile schema");
  const profileId = stringValue(profile.profile_id, "profile_id", { pattern: PROFILE_ID_RE, maxBytes: 128 });
  const provenance = stringValue(profile.provenance, "provenance", { maxBytes: 4_096 });
  const maximumCandidates = integerValue(profile.maximum_candidates, "maximum_candidates", 1, MAX_CANDIDATES);
  const nodeBudget = integerValue(profile.node_budget, "node_budget", 1, MAX_NODE_BUDGET);
  if (profile.search_order_policy !== SEARCH_ORDER_POLICY) throw new Error("unsupported search_order_policy");
  if (profile.tie_break_policy !== TIE_BREAK_POLICY) throw new Error("unsupported tie_break_policy");
  const normalized = {
    schema_version: SCHEMA_VERSION,
    profile_id: profileId,
    provenance,
    maximum_candidates: maximumCandidates,
    node_budget: nodeBudget,
    search_order_policy: SEARCH_ORDER_POLICY,
    tie_break_policy: TIE_BREAK_POLICY,
  };
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    profileId,
    provenance,
    maximumCandidates,
    nodeBudget,
    searchOrderPolicy: SEARCH_ORDER_POLICY,
    tieBreakPolicy: TIE_BREAK_POLICY,
    sha256: sha256Canonical(normalized),
  });
}

function validateProblemReport(report) {
  exactKeys(
    report,
    [
      "decisionBoundary",
      "decisionReportSha256",
      "engineId",
      "interpretation",
      "model",
      "planningProfile",
      "reportSha256",
      "schemaVersion",
      "status",
      "summary",
      "warnings",
    ],
    "optimization problem report",
  );
  if (report.schemaVersion !== SCHEMA_VERSION) throw new Error("optimization problem report schema mismatch");
  if (report.engineId !== "WALLE_OPTIMIZATION_PROBLEM_BUILDER_V1") throw new Error("optimization problem engine mismatch");
  if (report.status !== "OPTIMIZATION_PROBLEM_READY") throw new Error("optimization problem report must be ready");
  if (report.interpretation !== "BINARY_PORTFOLIO_FORMULATION_NOT_SOLVER_RESULT_OR_OUTCOME_FORECAST") {
    throw new Error("optimization problem interpretation mismatch");
  }
  if (report.decisionBoundary !== "FORMULATION_ONLY_NO_SOLVER_RESULT_NO_AUTONOMOUS_SITE_ACTION") {
    throw new Error("optimization problem boundary mismatch");
  }
  const reportSha256 = sha256Value(report.reportSha256, "optimization problem report hash");
  const { reportSha256: ignored, ...unsigned } = report;
  void ignored;
  if (sha256Canonical(unsigned) !== reportSha256) throw new Error("optimization problem report hash mismatch");
  const decisionReportSha256 = sha256Value(report.decisionReportSha256, "decision report binding");
  if (!report.planningProfile || typeof report.planningProfile !== "object" || Array.isArray(report.planningProfile)) {
    throw new Error("planning profile binding missing");
  }
  sha256Value(report.planningProfile.sha256, "planning profile hash");

  exactKeys(report.model, ["constraints", "objective", "variables"], "optimization model");
  const modelSha256 = sha256Canonical(report.model);
  if (report.summary?.modelSha256 !== modelSha256) throw new Error("optimization model hash mismatch");

  const variablesRaw = report.model.variables;
  if (!Array.isArray(variablesRaw) || variablesRaw.length < 1 || variablesRaw.length > 2_000) {
    throw new Error("optimization variables must contain 1..2000 rows");
  }
  const variables = [];
  const variableById = new Map();
  for (const [index, row] of variablesRaw.entries()) {
    exactKeys(
      row,
      [
        "decisionId",
        "empiricalTransitionContext",
        "objectiveCoefficient",
        "pageUrl",
        "paretoFrontier",
        "paretoLayer",
        "priorityRank",
        "query",
        "resources",
        "selectedTarget",
        "variableType",
      ],
      `optimization variable ${index}`,
    );
    const decisionId = sha256Value(row.decisionId, `variable decisionId ${index}`);
    if (variableById.has(decisionId)) throw new Error(`duplicate optimization variable:${decisionId}`);
    if (row.variableType !== "BINARY") throw new Error(`unsupported variable type ${index}`);
    const priorityRank = integerValue(row.priorityRank, `priorityRank ${index}`, 1, 2_000);
    const objectiveCoefficient = integerValue(row.objectiveCoefficient, `objectiveCoefficient ${index}`, 0);
    exactKeys(row.resources, ["costMicros", "editorialUnits", "engineeringUnits", "estimateBasis", "riskUnits"], `resources ${index}`);
    const normalized = Object.freeze({
      decisionId,
      query: stringValue(row.query, `query ${index}`, { maxBytes: 4_096 }),
      pageUrl: stringValue(row.pageUrl, `pageUrl ${index}`),
      priorityRank,
      objectiveCoefficient,
      resources: Object.freeze({
        costMicros: integerValue(row.resources.costMicros, `costMicros ${index}`, 0),
        editorialUnits: integerValue(row.resources.editorialUnits, `editorialUnits ${index}`, 0),
        engineeringUnits: integerValue(row.resources.engineeringUnits, `engineeringUnits ${index}`, 0),
        riskUnits: integerValue(row.resources.riskUnits, `riskUnits ${index}`, 0),
      }),
    });
    variables.push(normalized);
    variableById.set(decisionId, normalized);
  }

  exactKeys(report.model.objective, ["coefficientSemantics", "coefficients", "id", "sense"], "optimization objective");
  if (report.model.objective.sense !== "MAXIMIZE") throw new Error("classical baseline supports MAXIMIZE only");
  if (!['INCREMENTAL_CLIENTS_MILLI', 'INCREMENTAL_REVENUE_MICROS'].includes(report.model.objective.id)) {
    throw new Error("unsupported optimization objective id");
  }
  if (report.model.objective.coefficientSemantics !== "BOUNDED_SCENARIO_VALUE_NOT_FORECAST_OR_PROBABILITY_ADJUSTED_VALUE") {
    throw new Error("optimization objective semantics mismatch");
  }
  if (!Array.isArray(report.model.objective.coefficients) || report.model.objective.coefficients.length !== variables.length) {
    throw new Error("objective coefficients must exactly cover variables");
  }
  const objectiveSeen = new Set();
  for (const [index, coefficient] of report.model.objective.coefficients.entries()) {
    exactKeys(coefficient, ["decisionId", "value"], `objective coefficient ${index}`);
    const decisionId = sha256Value(coefficient.decisionId, `objective decisionId ${index}`);
    if (objectiveSeen.has(decisionId) || !variableById.has(decisionId)) throw new Error(`objective coefficient identity mismatch ${index}`);
    objectiveSeen.add(decisionId);
    const value = integerValue(coefficient.value, `objective coefficient value ${index}`, 0);
    if (value !== variableById.get(decisionId).objectiveCoefficient) throw new Error(`objective coefficient mismatch ${index}`);
  }

  exactKeys(report.model.constraints, ["dependencyConstraints", "mutexConstraints", "resourceConstraints"], "optimization constraints");
  const resourceRaw = report.model.constraints.resourceConstraints;
  if (!Array.isArray(resourceRaw) || resourceRaw.length !== RESOURCE_IDS.length) {
    throw new Error("resource constraints must contain exactly five constraints");
  }
  const resourceMap = new Map();
  for (const [index, constraint] of resourceRaw.entries()) {
    exactKeys(constraint, ["coefficients", "constraintId", "limit", "relation"], `resource constraint ${index}`);
    if (!RESOURCE_IDS.includes(constraint.constraintId) || resourceMap.has(constraint.constraintId)) {
      throw new Error(`invalid or duplicate resource constraint ${index}`);
    }
    if (constraint.relation !== "LE") throw new Error(`resource constraint ${index} must be LE`);
    const limit = integerValue(constraint.limit, `resource limit ${index}`, 0);
    if (!Array.isArray(constraint.coefficients) || constraint.coefficients.length !== variables.length) {
      throw new Error(`resource coefficients ${index} must exactly cover variables`);
    }
    const seen = new Set();
    const coefficientMap = new Map();
    for (const [coefficientIndex, coefficient] of constraint.coefficients.entries()) {
      exactKeys(coefficient, ["decisionId", "value"], `resource coefficient ${index}:${coefficientIndex}`);
      const decisionId = sha256Value(coefficient.decisionId, `resource decisionId ${index}:${coefficientIndex}`);
      if (seen.has(decisionId) || !variableById.has(decisionId)) throw new Error(`resource coefficient identity mismatch ${index}:${coefficientIndex}`);
      seen.add(decisionId);
      const value = integerValue(coefficient.value, `resource coefficient value ${index}:${coefficientIndex}`, 0);
      coefficientMap.set(decisionId, value);
    }
    resourceMap.set(constraint.constraintId, Object.freeze({ limit, coefficientMap }));
  }

  const fieldByConstraint = Object.freeze({
    BUDGET_MICROS: "costMicros",
    EDITORIAL_CAPACITY_UNITS: "editorialUnits",
    ENGINEERING_CAPACITY_UNITS: "engineeringUnits",
    RISK_CAPACITY_UNITS: "riskUnits",
  });
  for (const [constraintId, field] of Object.entries(fieldByConstraint)) {
    const constraint = resourceMap.get(constraintId);
    for (const variable of variables) {
      if (constraint.coefficientMap.get(variable.decisionId) !== variable.resources[field]) {
        throw new Error(`${constraintId} coefficient mismatch:${variable.decisionId}`);
      }
    }
  }
  const selectedConstraint = resourceMap.get("MAXIMUM_SELECTED");
  for (const variable of variables) {
    if (selectedConstraint.coefficientMap.get(variable.decisionId) !== 1) {
      throw new Error(`MAXIMUM_SELECTED coefficient must equal one:${variable.decisionId}`);
    }
  }
  if (selectedConstraint.limit < 1 || selectedConstraint.limit > variables.length) {
    throw new Error("MAXIMUM_SELECTED limit must be within candidate count");
  }

  const dependencies = [];
  const dependencyKeys = new Set();
  const dependencyRaw = report.model.constraints.dependencyConstraints;
  if (!Array.isArray(dependencyRaw) || dependencyRaw.length > variables.length * 8) throw new Error("dependency constraints must be bounded array");
  for (const [index, constraint] of dependencyRaw.entries()) {
    exactKeys(constraint, ["constraintId", "decisionId", "relation", "requiresDecisionId"], `dependency constraint ${index}`);
    if (constraint.relation !== "X_LE_REQUIRES_X") throw new Error(`unsupported dependency relation ${index}`);
    const decisionId = sha256Value(constraint.decisionId, `dependency decisionId ${index}`);
    const requiresDecisionId = sha256Value(constraint.requiresDecisionId, `dependency requiresDecisionId ${index}`);
    if (!variableById.has(decisionId) || !variableById.has(requiresDecisionId) || decisionId === requiresDecisionId) {
      throw new Error(`invalid dependency identities ${index}`);
    }
    const expectedId = `DEPENDENCY:${decisionId}:${requiresDecisionId}`;
    if (constraint.constraintId !== expectedId || dependencyKeys.has(expectedId)) throw new Error(`dependency identity mismatch ${index}`);
    dependencyKeys.add(expectedId);
    dependencies.push(Object.freeze({ decisionId, requiresDecisionId }));
  }

  const mutexGroups = [];
  const mutexIds = new Set();
  const mutexRaw = report.model.constraints.mutexConstraints;
  if (!Array.isArray(mutexRaw) || mutexRaw.length > variables.length) throw new Error("mutex constraints must be bounded array");
  for (const [index, constraint] of mutexRaw.entries()) {
    exactKeys(constraint, ["constraintId", "decisionIds", "limit", "relation"], `mutex constraint ${index}`);
    if (constraint.relation !== "SUM_LE" || constraint.limit !== 1) throw new Error(`mutex semantics mismatch ${index}`);
    if (typeof constraint.constraintId !== "string" || !constraint.constraintId.startsWith("MUTEX:")) throw new Error(`mutex id mismatch ${index}`);
    if (mutexIds.has(constraint.constraintId)) throw new Error(`duplicate mutex constraint ${index}`);
    mutexIds.add(constraint.constraintId);
    if (!Array.isArray(constraint.decisionIds) || constraint.decisionIds.length < 2 || constraint.decisionIds.length > variables.length) {
      throw new Error(`mutex decisionIds invalid ${index}`);
    }
    const decisionIds = constraint.decisionIds.map((decisionId, memberIndex) => sha256Value(decisionId, `mutex decisionId ${index}:${memberIndex}`));
    if (new Set(decisionIds).size !== decisionIds.length || decisionIds.some((decisionId) => !variableById.has(decisionId))) {
      throw new Error(`mutex members invalid ${index}`);
    }
    mutexGroups.push(Object.freeze({ groupId: constraint.constraintId.slice("MUTEX:".length), decisionIds: Object.freeze([...decisionIds]) }));
  }

  return Object.freeze({
    reportSha256,
    decisionReportSha256,
    planningProfileSha256: report.planningProfile.sha256,
    modelSha256,
    objectiveId: report.model.objective.id,
    variables: Object.freeze(variables),
    variableById,
    capacities: Object.freeze({
      costMicros: resourceMap.get("BUDGET_MICROS").limit,
      editorialUnits: resourceMap.get("EDITORIAL_CAPACITY_UNITS").limit,
      engineeringUnits: resourceMap.get("ENGINEERING_CAPACITY_UNITS").limit,
      riskUnits: resourceMap.get("RISK_CAPACITY_UNITS").limit,
      maximumSelected: selectedConstraint.limit,
    }),
    dependencies: Object.freeze(dependencies),
    mutexGroups: Object.freeze(mutexGroups),
  });
}

function searchOrder(problem) {
  const indegree = new Map(problem.variables.map((variable) => [variable.decisionId, 0]));
  const children = new Map(problem.variables.map((variable) => [variable.decisionId, []]));
  for (const edge of problem.dependencies) {
    indegree.set(edge.decisionId, indegree.get(edge.decisionId) + 1);
    children.get(edge.requiresDecisionId).push(edge.decisionId);
  }
  const variableCompare = (leftId, rightId) => {
    const left = problem.variableById.get(leftId);
    const right = problem.variableById.get(rightId);
    if (left.objectiveCoefficient !== right.objectiveCoefficient) return left.objectiveCoefficient > right.objectiveCoefficient ? -1 : 1;
    if (left.priorityRank !== right.priorityRank) return left.priorityRank - right.priorityRank;
    return compareStrings(leftId, rightId);
  };
  const available = [...indegree.entries()].filter(([, count]) => count === 0).map(([id]) => id).sort(variableCompare);
  const ordered = [];
  while (available.length > 0) {
    const id = available.shift();
    ordered.push(problem.variableById.get(id));
    for (const child of children.get(id)) {
      indegree.set(child, indegree.get(child) - 1);
      if (indegree.get(child) === 0) available.push(child);
    }
    available.sort(variableCompare);
  }
  if (ordered.length !== problem.variables.length) throw new Error("optimization dependency graph contains a cycle");
  return Object.freeze(ordered);
}

function dependencyMap(problem) {
  const map = new Map(problem.variables.map((variable) => [variable.decisionId, []]));
  for (const edge of problem.dependencies) map.get(edge.decisionId).push(edge.requiresDecisionId);
  for (const values of map.values()) values.sort(compareStrings);
  return map;
}

function mutexMembership(problem) {
  const map = new Map(problem.variables.map((variable) => [variable.decisionId, []]));
  for (const group of problem.mutexGroups) {
    for (const decisionId of group.decisionIds) map.get(decisionId).push(group.groupId);
  }
  for (const values of map.values()) values.sort(compareStrings);
  return map;
}

function emptyState() {
  return {
    index: 0,
    objective: 0n,
    costMicros: 0,
    editorialUnits: 0,
    engineeringUnits: 0,
    riskUnits: 0,
    selected: new Set(),
    mutexUsed: new Set(),
  };
}

function selectedIdentity(state) {
  return [...state.selected].sort(compareStrings);
}

function isBetterSolution(candidate, incumbent) {
  if (candidate.objective !== incumbent.objective) return candidate.objective > incumbent.objective;
  for (const field of ["costMicros", "riskUnits", "editorialUnits", "engineeringUnits"]) {
    if (candidate[field] !== incumbent[field]) return candidate[field] < incumbent[field];
  }
  if (candidate.selected.size !== incumbent.selected.size) return candidate.selected.size < incumbent.selected.size;
  return compareStrings(canonicalJson(selectedIdentity(candidate)), canonicalJson(selectedIdentity(incumbent))) < 0;
}

function includeState(state, variable, problem, requiresById, mutexById) {
  for (const requiredId of requiresById.get(variable.decisionId)) {
    if (!state.selected.has(requiredId)) return null;
  }
  if (state.selected.size + 1 > problem.capacities.maximumSelected) return null;
  const costMicros = state.costMicros + variable.resources.costMicros;
  const editorialUnits = state.editorialUnits + variable.resources.editorialUnits;
  const engineeringUnits = state.engineeringUnits + variable.resources.engineeringUnits;
  const riskUnits = state.riskUnits + variable.resources.riskUnits;
  if (
    !Number.isSafeInteger(costMicros)
    || !Number.isSafeInteger(editorialUnits)
    || !Number.isSafeInteger(engineeringUnits)
    || !Number.isSafeInteger(riskUnits)
  ) throw new Error("resource usage exceeds safe integer range");
  if (
    costMicros > problem.capacities.costMicros
    || editorialUnits > problem.capacities.editorialUnits
    || engineeringUnits > problem.capacities.engineeringUnits
    || riskUnits > problem.capacities.riskUnits
  ) return null;
  for (const groupId of mutexById.get(variable.decisionId)) {
    if (state.mutexUsed.has(groupId)) return null;
  }
  const selected = new Set(state.selected);
  selected.add(variable.decisionId);
  const mutexUsed = new Set(state.mutexUsed);
  for (const groupId of mutexById.get(variable.decisionId)) mutexUsed.add(groupId);
  return {
    index: state.index + 1,
    objective: state.objective + BigInt(variable.objectiveCoefficient),
    costMicros,
    editorialUnits,
    engineeringUnits,
    riskUnits,
    selected,
    mutexUsed,
  };
}

function excludeState(state) {
  return {
    index: state.index + 1,
    objective: state.objective,
    costMicros: state.costMicros,
    editorialUnits: state.editorialUnits,
    engineeringUnits: state.engineeringUnits,
    riskUnits: state.riskUnits,
    selected: state.selected,
    mutexUsed: state.mutexUsed,
  };
}

function greedyIncumbent(order, problem, requiresById, mutexById) {
  let state = emptyState();
  for (const variable of order) {
    if (variable.objectiveCoefficient === 0) {
      state = excludeState(state);
      continue;
    }
    const included = includeState(state, variable, problem, requiresById, mutexById);
    state = included ?? excludeState(state);
  }
  return state;
}

function solve(problem, profile) {
  if (problem.variables.length > profile.maximumCandidates) {
    throw new Error("candidate count exceeds explicit maximum_candidates; no silent truncation allowed");
  }
  const order = searchOrder(problem);
  const requiresById = dependencyMap(problem);
  const mutexById = mutexMembership(problem);
  const suffix = new Array(order.length + 1).fill(0n);
  for (let index = order.length - 1; index >= 0; index -= 1) {
    suffix[index] = suffix[index + 1] + BigInt(order[index].objectiveCoefficient);
  }

  let best = greedyIncumbent(order, problem, requiresById, mutexById);
  let exploredNodes = 0;
  let prunedByUpperBound = 0;
  let prunedInfeasibleInclude = 0;
  let incumbentUpdates = best.selected.size > 0 ? 1 : 0;
  const stack = [emptyState()];

  while (stack.length > 0 && exploredNodes < profile.nodeBudget) {
    const state = stack.pop();
    exploredNodes += 1;
    const upperBound = state.objective + suffix[state.index];
    if (upperBound < best.objective) {
      prunedByUpperBound += 1;
      continue;
    }
    if (state.index === order.length) {
      if (isBetterSolution(state, best)) {
        best = state;
        incumbentUpdates += 1;
      }
      continue;
    }
    const variable = order[state.index];
    stack.push(excludeState(state));
    const included = includeState(state, variable, problem, requiresById, mutexById);
    if (included === null) {
      prunedInfeasibleInclude += 1;
    } else {
      stack.push(included);
    }
  }

  let globalUpperBound = best.objective;
  for (const state of stack) {
    const bound = state.objective + suffix[state.index];
    if (bound > globalUpperBound) globalUpperBound = bound;
  }
  const optimalityProven = stack.length === 0;
  const selectedDecisionIds = Object.freeze(selectedIdentity(best));
  return Object.freeze({
    status: optimalityProven ? "OPTIMAL" : "FEASIBLE_NOT_PROVEN_OPTIMAL",
    optimalityProven,
    objectiveValueDecimal: best.objective.toString(),
    globalUpperBoundDecimal: globalUpperBound.toString(),
    optimalityGapAbsoluteDecimal: (globalUpperBound - best.objective).toString(),
    selectedDecisionIds,
    selectedCount: selectedDecisionIds.length,
    resourceUsage: Object.freeze({
      costMicros: best.costMicros,
      editorialUnits: best.editorialUnits,
      engineeringUnits: best.engineeringUnits,
      riskUnits: best.riskUnits,
    }),
    search: Object.freeze({
      candidateCount: order.length,
      nodeBudget: profile.nodeBudget,
      exploredNodes,
      frontierNodeCount: stack.length,
      prunedByUpperBound,
      prunedInfeasibleInclude,
      incumbentUpdates,
      searchOrderDecisionIds: Object.freeze(order.map((variable) => variable.decisionId)),
    }),
  });
}

export function buildClassicalBaselineReport({ optimizationProblemReport, baselineProfile }) {
  const problem = validateProblemReport(optimizationProblemReport);
  const profile = validateProfile(baselineProfile);
  const solution = solve(problem, profile);
  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    engineId: ENGINE_ID,
    status: solution.status,
    interpretation: "DETERMINISTIC_CLASSICAL_BRANCH_AND_BOUND_BASELINE_NOT_OUTCOME_FORECAST_OR_QUANTUM_ADVANTAGE_CLAIM",
    optimizationProblemReportSha256: problem.reportSha256,
    optimizationModelSha256: problem.modelSha256,
    decisionReportSha256: problem.decisionReportSha256,
    planningProfileSha256: problem.planningProfileSha256,
    objective: Object.freeze({
      sense: "MAXIMIZE",
      id: problem.objectiveId,
      semantics: "BOUNDED_SCENARIO_VALUE_NOT_FORECAST_OR_PROBABILITY_ADJUSTED_VALUE",
    }),
    baselineProfile: profile,
    solution: Object.freeze({
      ...solution,
      selectedSetSha256: sha256Canonical(solution.selectedDecisionIds),
    }),
    decisionBoundary: "CLASSICAL_BASELINE_ONLY_NO_QUANTUM_ADVANTAGE_CLAIM_NO_AUTONOMOUS_SITE_ACTION",
    warnings: Object.freeze([
      "NO_RANK_GUARANTEE",
      "NO_CAUSAL_SEO_LIFT_CLAIM",
      "NO_TRAFFIC_LEAD_CLIENT_OR_REVENUE_GUARANTEE",
      "OBJECTIVE_USES_BOUNDED_SCENARIO_VALUES_NOT_FORECASTS",
      "NO_WALL_CLOCK_PERFORMANCE_CLAIM_IN_DETERMINISTIC_REPORT",
      "QUANTUM_ADVANTAGE_CANNOT_BE_CLAIMED_FROM_THIS REPORT ALONE".replace(" REPORT", "_REPORT"),
      "NODE_BUDGET_EXHAUSTION_MUST_NOT_BE_RELABELED_AS_OPTIMAL",
      "BASELINE_SOLVER_DOES_NOT_EXECUTE_SITE_CHANGES",
    ]),
  };
  return Object.freeze({ ...unsigned, reportSha256: sha256Canonical(unsigned) });
}

export const CLASSICAL_BASELINE_SEARCH_ORDER_POLICY = SEARCH_ORDER_POLICY;
export const CLASSICAL_BASELINE_TIE_BREAK_POLICY = TIE_BREAK_POLICY;
