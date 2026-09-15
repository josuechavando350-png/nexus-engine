import { createHash } from "node:crypto";

import { buildClassicalBaselineReport } from "../classical-baseline/baseline-solver.mjs";

const SCHEMA_VERSION = 1;
const ENGINE_ID = "WALLE_QUANTUM_HYBRID_EXPERIMENT_V1";
const BACKEND_KIND = "STATEVECTOR_QAOA_SIMULATOR";
const PARAMETER_POLICY = "MAX_EXPECTED_HAMILTONIAN_THEN_FEASIBLE_MASS_THEN_ID";
const READOUT_POLICY = "MOST_PROBABLE_FEASIBLE_STATE_THEN_LOWEST_BASIS_INDEX";
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_QUBITS = 14;
const MAX_DEPTH = 3;
const MAX_PARAMETER_SETS = 64;
const TWO_PI_MICRORADIANS = 6_283_185;

function compareStrings(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(typeof value === "string" ? value.normalize("NFC") : value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("report numbers must be safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(([k, v]) => [k.normalize("NFC"), v]).sort(([a], [b]) => compareStrings(a, b));
    const seen = new Set();
    return `{${entries.map(([k, v]) => {
      if (seen.has(k)) throw new TypeError("normalized key collision");
      seen.add(k);
      return `${JSON.stringify(k)}:${canonicalJson(v)}`;
    }).join(",")}}`;
  }
  throw new TypeError("report values must be JSON-compatible");
}

function sha256Canonical(value) {
  return `sha256:${createHash("sha256").update(Buffer.from(canonicalJson(value), "utf8")).digest("hex")}`;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be object`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) throw new Error(`unexpected ${label} keys`);
}

function text(value, label, pattern = null) {
  if (typeof value !== "string") throw new Error(`${label} must be string`);
  const normalized = value.normalize("NFC").trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > 4_096) throw new Error(`${label} invalid length`);
  if (pattern && !pattern.test(normalized)) throw new Error(`${label} invalid format`);
  return normalized;
}

function integer(value, label, min, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be integer in range`);
  return value;
}

function sha(value, label) {
  if (typeof value !== "string" || !SHA256_RE.test(value)) throw new Error(`${label} must be sha256:<64 lowercase hex>`);
  return value;
}

function decimal(value, label) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must be non-negative decimal integer string`);
  return BigInt(value);
}

function validateExperimentProfile(profile) {
  exactKeys(profile, [
    "backend_kind", "candidate_readout_policy", "maximum_qubits", "parameter_selection_policy",
    "parameter_sets", "profile_id", "provenance", "schema_version",
  ], "experiment profile");
  if (profile.schema_version !== SCHEMA_VERSION) throw new Error("unsupported experiment profile schema");
  if (profile.backend_kind !== BACKEND_KIND) throw new Error("V1 is simulator-only and must not imply QPU hardware");
  if (profile.parameter_selection_policy !== PARAMETER_POLICY) throw new Error("unsupported parameter_selection_policy");
  if (profile.candidate_readout_policy !== READOUT_POLICY) throw new Error("unsupported candidate_readout_policy");
  const profileId = text(profile.profile_id, "profile_id", TOKEN_RE);
  const provenance = text(profile.provenance, "provenance");
  const maximumQubits = integer(profile.maximum_qubits, "maximum_qubits", 1, MAX_QUBITS);
  if (!Array.isArray(profile.parameter_sets) || profile.parameter_sets.length < 1 || profile.parameter_sets.length > MAX_PARAMETER_SETS) {
    throw new Error("parameter_sets must contain 1..64 schedules");
  }
  let depth = null;
  const parameterSets = profile.parameter_sets.map((row, index) => {
    exactKeys(row, ["beta_microradians", "gamma_microradians", "parameter_set_id"], `parameter set ${index}`);
    const parameterSetId = text(row.parameter_set_id, `parameter_set_id ${index}`, TOKEN_RE);
    if (!Array.isArray(row.gamma_microradians) || !Array.isArray(row.beta_microradians)) throw new Error(`parameter set ${index} angles must be arrays`);
    if (row.gamma_microradians.length < 1 || row.gamma_microradians.length > MAX_DEPTH || row.beta_microradians.length !== row.gamma_microradians.length) {
      throw new Error(`parameter set ${index} depth invalid`);
    }
    if (depth === null) depth = row.gamma_microradians.length;
    if (row.gamma_microradians.length !== depth) throw new Error("all parameter sets must use the same QAOA depth");
    return Object.freeze({
      parameterSetId,
      gammaMicroradians: Object.freeze(row.gamma_microradians.map((v, i) => integer(v, `gamma ${index}:${i}`, 0, TWO_PI_MICRORADIANS))),
      betaMicroradians: Object.freeze(row.beta_microradians.map((v, i) => integer(v, `beta ${index}:${i}`, 0, TWO_PI_MICRORADIANS))),
    });
  });
  if (new Set(parameterSets.map((row) => row.parameterSetId)).size !== parameterSets.length) throw new Error("parameter_set_id values must be unique");
  const canonical = {
    schema_version: SCHEMA_VERSION,
    profile_id: profileId,
    provenance,
    backend_kind: BACKEND_KIND,
    maximum_qubits: maximumQubits,
    parameter_selection_policy: PARAMETER_POLICY,
    candidate_readout_policy: READOUT_POLICY,
    parameter_sets: parameterSets.map((row) => ({
      parameter_set_id: row.parameterSetId,
      gamma_microradians: row.gammaMicroradians,
      beta_microradians: row.betaMicroradians,
    })),
  };
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION, profileId, provenance, backendKind: BACKEND_KIND, maximumQubits,
    parameterSelectionPolicy: PARAMETER_POLICY, candidateReadoutPolicy: READOUT_POLICY, qaoaDepth: depth,
    parameterSets: Object.freeze(parameterSets), sha256: sha256Canonical(canonical),
  });
}

function problemView(report) {
  const variables = report.model.variables;
  const ids = variables.map((row, i) => sha(row.decisionId, `decisionId ${i}`));
  const indexById = new Map(ids.map((id, i) => [id, i]));
  const objective = variables.map((row, i) => BigInt(integer(row.objectiveCoefficient, `objective ${i}`, 0)));
  const resources = variables.map((row, i) => Object.freeze({
    costMicros: integer(row.resources.costMicros, `cost ${i}`, 0),
    editorialUnits: integer(row.resources.editorialUnits, `editorial ${i}`, 0),
    engineeringUnits: integer(row.resources.engineeringUnits, `engineering ${i}`, 0),
    riskUnits: integer(row.resources.riskUnits, `risk ${i}`, 0),
  }));
  const resourceMap = new Map(report.model.constraints.resourceConstraints.map((row) => [row.constraintId, row.limit]));
  const required = ["BUDGET_MICROS", "EDITORIAL_CAPACITY_UNITS", "ENGINEERING_CAPACITY_UNITS", "RISK_CAPACITY_UNITS", "MAXIMUM_SELECTED"];
  for (const id of required) if (!resourceMap.has(id)) throw new Error(`missing ${id}`);
  const dependencies = report.model.constraints.dependencyConstraints.map((edge, i) => {
    const decisionId = sha(edge.decisionId, `dependency ${i}`);
    const requiresId = sha(edge.requiresDecisionId, `dependency requirement ${i}`);
    if (!indexById.has(decisionId) || !indexById.has(requiresId)) throw new Error("dependency identity mismatch");
    return Object.freeze([indexById.get(decisionId), indexById.get(requiresId)]);
  });
  const mutexGroups = report.model.constraints.mutexConstraints.map((group, i) => Object.freeze(group.decisionIds.map((id) => {
    const normalized = sha(id, `mutex ${i}`);
    if (!indexById.has(normalized)) throw new Error("mutex identity mismatch");
    return indexById.get(normalized);
  })));
  return Object.freeze({
    reportSha256: sha(report.reportSha256, "optimization report hash"),
    modelSha256: sha(report.summary.modelSha256, "optimization model hash"),
    ids: Object.freeze(ids), objective: Object.freeze(objective), resources: Object.freeze(resources),
    limits: Object.freeze({
      costMicros: integer(resourceMap.get("BUDGET_MICROS"), "budget limit", 0),
      editorialUnits: integer(resourceMap.get("EDITORIAL_CAPACITY_UNITS"), "editorial limit", 0),
      engineeringUnits: integer(resourceMap.get("ENGINEERING_CAPACITY_UNITS"), "engineering limit", 0),
      riskUnits: integer(resourceMap.get("RISK_CAPACITY_UNITS"), "risk limit", 0),
      maximumSelected: integer(resourceMap.get("MAXIMUM_SELECTED"), "selection limit", 0),
    }),
    dependencies: Object.freeze(dependencies), mutexGroups: Object.freeze(mutexGroups),
  });
}

function evaluateState(mask, problem) {
  let objective = 0n, costMicros = 0, editorialUnits = 0, engineeringUnits = 0, riskUnits = 0, selectedCount = 0;
  const selected = [];
  for (let i = 0; i < problem.ids.length; i += 1) {
    if ((mask & (1 << i)) === 0) continue;
    objective += problem.objective[i];
    costMicros += problem.resources[i].costMicros;
    editorialUnits += problem.resources[i].editorialUnits;
    engineeringUnits += problem.resources[i].engineeringUnits;
    riskUnits += problem.resources[i].riskUnits;
    selectedCount += 1;
    selected.push(problem.ids[i]);
  }
  let feasible = costMicros <= problem.limits.costMicros && editorialUnits <= problem.limits.editorialUnits
    && engineeringUnits <= problem.limits.engineeringUnits && riskUnits <= problem.limits.riskUnits
    && selectedCount <= problem.limits.maximumSelected;
  if (feasible) for (const [child, parent] of problem.dependencies) if ((mask & (1 << child)) !== 0 && (mask & (1 << parent)) === 0) feasible = false;
  if (feasible) for (const group of problem.mutexGroups) {
    let count = 0;
    for (const i of group) if ((mask & (1 << i)) !== 0) count += 1;
    if (count > 1) feasible = false;
  }
  return Object.freeze({
    feasible, objective, selectedDecisionIds: Object.freeze(selected.sort(compareStrings)),
    resourceUsage: Object.freeze({ costMicros, editorialUnits, engineeringUnits, riskUnits }),
  });
}

function hamiltonianScores(evaluations) {
  let max = 0n;
  for (const row of evaluations) if (row.feasible && row.objective > max) max = row.objective;
  return evaluations.map((row) => {
    if (!row.feasible) return -1;
    if (max === 0n) return 0;
    return Number((row.objective * 1_000_000n) / max) / 1_000_000;
  });
}

function applyMixer(real, imag, beta, qubitCount) {
  const cos = Math.cos(beta), sin = Math.sin(beta);
  for (let q = 0; q < qubitCount; q += 1) {
    const bit = 1 << q;
    for (let base = 0; base < real.length; base += 1) {
      if ((base & bit) !== 0) continue;
      const other = base | bit;
      const r0 = real[base], i0 = imag[base], r1 = real[other], i1 = imag[other];
      real[base] = cos * r0 + sin * i1;
      imag[base] = cos * i0 - sin * r1;
      real[other] = cos * r1 + sin * i0;
      imag[other] = cos * i1 - sin * r0;
    }
  }
}

function simulate(problem, evaluations, scores, parameters) {
  const amplitude = 1 / Math.sqrt(evaluations.length);
  const real = new Float64Array(evaluations.length), imag = new Float64Array(evaluations.length);
  real.fill(amplitude);
  for (let layer = 0; layer < parameters.gammaMicroradians.length; layer += 1) {
    const gamma = parameters.gammaMicroradians[layer] / 1_000_000;
    const beta = parameters.betaMicroradians[layer] / 1_000_000;
    for (let state = 0; state < real.length; state += 1) {
      const angle = -gamma * scores[state], c = Math.cos(angle), s = Math.sin(angle), r = real[state], i = imag[state];
      real[state] = r * c - i * s;
      imag[state] = r * s + i * c;
    }
    applyMixer(real, imag, beta, problem.ids.length);
  }
  let expected = 0, feasibleMass = 0, selectedMask = null, selectedProbability = -1;
  for (let state = 0; state < real.length; state += 1) {
    const p = real[state] * real[state] + imag[state] * imag[state];
    expected += p * scores[state];
    if (!evaluations[state].feasible) continue;
    feasibleMass += p;
    if (p > selectedProbability + Number.EPSILON || (Math.abs(p - selectedProbability) <= Number.EPSILON && (selectedMask === null || state < selectedMask))) {
      selectedMask = state;
      selectedProbability = p;
    }
  }
  if (selectedMask === null) throw new Error("simulator produced no feasible readout candidate");
  return Object.freeze({
    parameterSetId: parameters.parameterSetId,
    expectedHamiltonianScorePpm: Math.max(-1_000_000, Math.min(1_000_000, Math.round(expected * 1_000_000))),
    feasibleProbabilityMassPpm: Math.max(0, Math.min(1_000_000, Math.round(feasibleMass * 1_000_000))),
    selectedProbabilityPpm: Math.max(0, Math.min(1_000_000, Math.round(selectedProbability * 1_000_000))),
    selectedMask,
  });
}

function betterParameterResult(left, right) {
  if (right === null) return true;
  if (left.expectedHamiltonianScorePpm !== right.expectedHamiltonianScorePpm) return left.expectedHamiltonianScorePpm > right.expectedHamiltonianScorePpm;
  if (left.feasibleProbabilityMassPpm !== right.feasibleProbabilityMassPpm) return left.feasibleProbabilityMassPpm > right.feasibleProbabilityMassPpm;
  return compareStrings(left.parameterSetId, right.parameterSetId) < 0;
}

function runSimulator(problem, profile) {
  const qubitCount = problem.ids.length;
  if (qubitCount > profile.maximumQubits || qubitCount > MAX_QUBITS) throw new Error("candidate count exceeds explicit statevector qubit limit; no silent truncation allowed");
  const stateCount = 1 << qubitCount;
  const evaluations = Array.from({ length: stateCount }, (_, mask) => evaluateState(mask, problem));
  const scores = hamiltonianScores(evaluations);
  let best = null;
  const parameterReceipts = [];
  for (const parameters of profile.parameterSets) {
    const result = simulate(problem, evaluations, scores, parameters);
    parameterReceipts.push(Object.freeze({
      parameterSetId: result.parameterSetId,
      expectedHamiltonianScorePpm: result.expectedHamiltonianScorePpm,
      feasibleProbabilityMassPpm: result.feasibleProbabilityMassPpm,
      selectedProbabilityPpm: result.selectedProbabilityPpm,
    }));
    if (betterParameterResult(result, best)) best = result;
  }
  const selected = evaluations[best.selectedMask];
  return Object.freeze({
    backendKind: BACKEND_KIND, hardwareExecution: false, qubitCount, stateCount, qaoaDepth: profile.qaoaDepth,
    parameterSetCount: profile.parameterSets.length, selectedParameterSetId: best.parameterSetId,
    expectedHamiltonianScorePpm: best.expectedHamiltonianScorePpm,
    feasibleProbabilityMassPpm: best.feasibleProbabilityMassPpm,
    selectedProbabilityPpm: best.selectedProbabilityPpm,
    objectiveValueDecimal: selected.objective.toString(), selectedDecisionIds: selected.selectedDecisionIds,
    selectedSetSha256: sha256Canonical(selected.selectedDecisionIds), resourceUsage: selected.resourceUsage,
    feasible: selected.feasible, deterministicWorkUnits: stateCount * profile.parameterSets.length * profile.qaoaDepth,
    deterministicWorkUnit: "STATEVECTOR_BASIS_STATE_PARAMETER_LAYER",
    parameterReceipts: Object.freeze(parameterReceipts),
  });
}

function comparison(candidate, classical) {
  const classicalObjective = decimal(classical.solution.objectiveValueDecimal, "classical objective");
  const candidateObjective = decimal(candidate.objectiveValueDecimal, "candidate objective");
  if (classical.solution.optimalityProven && candidateObjective > classicalObjective) throw new Error("candidate exceeds proven classical optimum; evidence inconsistent");
  const objectiveComparison = candidateObjective === classicalObjective ? "OBJECTIVE_TIE"
    : candidateObjective < classicalObjective ? "CLASSICAL_OBJECTIVE_BETTER" : "CANDIDATE_OBJECTIVE_BETTER_BASELINE_NOT_PROVEN";
  const ratio = classicalObjective === 0n ? (candidateObjective === 0n ? 1_000_000n : 0n) : (candidateObjective * 1_000_000n) / classicalObjective;
  return Object.freeze({
    objectiveComparison,
    candidateToClassicalObjectiveRatioPpm: Number(ratio > 2_000_000n ? 2_000_000n : ratio),
    classicalOptimalityProven: classical.solution.optimalityProven,
    classicalObjectiveValueDecimal: classicalObjective.toString(), candidateObjectiveValueDecimal: candidateObjective.toString(),
    selectedSetEqual: candidate.selectedSetSha256 === classical.solution.selectedSetSha256,
    quantumAdvantageClaimAllowed: false,
    quantumAdvantageVerdict: "NOT_DEMONSTRATED_SIMULATOR_ONLY",
  });
}

export function buildQuantumHybridExperimentReport({ optimizationProblemReport, baselineProfile, experimentProfile }) {
  const profile = validateExperimentProfile(experimentProfile);
  const classical = buildClassicalBaselineReport({ optimizationProblemReport, baselineProfile });
  const problem = problemView(optimizationProblemReport);
  if (classical.optimizationProblemReportSha256 !== problem.reportSha256 || classical.optimizationModelSha256 !== problem.modelSha256) {
    throw new Error("classical baseline and QAOA simulator are not bound to the same problem");
  }
  const candidate = runSimulator(problem, profile);
  const compared = comparison(candidate, classical);
  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    engineId: ENGINE_ID,
    status: classical.solution.optimalityProven ? "EXPERIMENT_COMPLETE" : "INCONCLUSIVE_CLASSICAL_BASELINE_NOT_PROVEN",
    interpretation: "CONTROLLED_QAOA_STATEVECTOR_SIMULATION_VS_CLASSICAL_BASELINE_NOT_QPU_HARDWARE_OR_QUANTUM_ADVANTAGE_PROOF",
    optimizationProblemReportSha256: problem.reportSha256,
    optimizationModelSha256: problem.modelSha256,
    classicalBaselineReportSha256: classical.reportSha256,
    experimentProfile: profile,
    classicalReference: Object.freeze({
      status: classical.status, optimalityProven: classical.solution.optimalityProven,
      objectiveValueDecimal: classical.solution.objectiveValueDecimal,
      selectedSetSha256: classical.solution.selectedSetSha256,
      exploredNodes: classical.solution.search.exploredNodes,
      deterministicWorkUnit: "BRANCH_AND_BOUND_NODE",
    }),
    quantumHybridCandidate: candidate,
    comparison: compared,
    decisionBoundary: "EXPERIMENT_ONLY_NO_QPU_HARDWARE_CLAIM_NO_QUANTUM_ADVANTAGE_CLAIM_NO_AUTONOMOUS_SITE_ACTION",
    warnings: Object.freeze([
      "STATEVECTOR_SIMULATION_IS_CLASSICAL_EXECUTION_OF_A_QUANTUM_ALGORITHM_NOT_QPU_HARDWARE",
      "NO_QUANTUM_ADVANTAGE_CLAIM_FROM_SIMULATOR_ONLY_EXPERIMENT",
      "NO_WALL_CLOCK_SPEEDUP_CLAIM",
      "DETERMINISTIC_WORK_UNITS_ARE_NOT_CROSS_ARCHITECTURE_RUNTIME_EQUIVALENTS",
      "OBJECTIVE_COEFFICIENTS_REMAIN_BOUNDED_SCENARIO_VALUES_NOT_OUTCOME_FORECASTS",
      "NO_RANK_GUARANTEE_OR_CAUSAL_SEO_LIFT_CLAIM",
      "EXPERIMENT_DOES_NOT_EXECUTE_SITE_CHANGES",
    ]),
  };
  return Object.freeze({ ...unsigned, reportSha256: sha256Canonical(unsigned) });
}

export const QUANTUM_HYBRID_BACKEND_KIND = BACKEND_KIND;
export const QUANTUM_HYBRID_PARAMETER_POLICY = PARAMETER_POLICY;
export const QUANTUM_HYBRID_READOUT_POLICY = READOUT_POLICY;
