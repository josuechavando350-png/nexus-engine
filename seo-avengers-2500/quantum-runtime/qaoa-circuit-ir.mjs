import {
  QUANTUM_CONTRACT_SCHEMA_VERSION as SCHEMA_VERSION,
  TOKEN_RE,
  canonicalQuantumSha256,
  compareStrings,
  exactKeys,
  freeze,
  integer,
  sha,
  text,
} from "./common.mjs";
import { buildProblemBinding, buildQuantumProblemContract, validateProblemBinding, validateQuantumProblemContract } from "./problem-contract.mjs";

const MAX_QUBITS = 14;
const MAX_DEPTH = 3;
const TWO_PI_MICRORADIANS = 6_283_185;
const SCORE_SCALE_PPM = 1_000_000;
const INFEASIBLE_SCORE_PPM = -1_000_000;

function signedInteger(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be integer in range`);
  return value;
}

function validateReportBindings(report, problemBinding, problemContract) {
  const expected = buildProblemBinding(report);
  const expectedContract = buildQuantumProblemContract(report);
  const binding = validateProblemBinding(problemBinding);
  const contract = validateQuantumProblemContract(problemContract);
  if (binding.bindingSha256 !== expected.bindingSha256) throw new Error("QAOA IR problem binding does not match optimization report");
  if (contract.contractSha256 !== expectedContract.contractSha256) throw new Error("QAOA IR problem contract does not match optimization report");
  if (contract.problemBindingSha256 !== binding.bindingSha256
    || contract.optimizationProblemReportSha256 !== binding.optimizationProblemReportSha256
    || contract.optimizationModelSha256 !== binding.optimizationModelSha256) {
    throw new Error("QAOA IR problem contract/binding mismatch");
  }
  return { binding, contract };
}

function problemView(report, contract) {
  const variables = report.model.variables;
  if (variables.length !== contract.decisionVariableCount || variables.length > MAX_QUBITS) {
    throw new Error("QAOA executable IR requires 1..14 decision variables");
  }
  const ids = variables.map((row, index) => sha(row.decisionId, `QAOA IR decisionId ${index}`));
  if (JSON.stringify(ids) !== JSON.stringify(contract.decisionVariableIds)) throw new Error("QAOA IR decision variable order mismatch");
  const indexById = new Map(ids.map((id, index) => [id, index]));
  const objective = variables.map((row, index) => BigInt(integer(row.objectiveCoefficient, `QAOA IR objective ${index}`, 0)));
  const resources = variables.map((row, index) => freeze({
    costMicros: integer(row.resources.costMicros, `QAOA IR cost ${index}`, 0),
    editorialUnits: integer(row.resources.editorialUnits, `QAOA IR editorial ${index}`, 0),
    engineeringUnits: integer(row.resources.engineeringUnits, `QAOA IR engineering ${index}`, 0),
    riskUnits: integer(row.resources.riskUnits, `QAOA IR risk ${index}`, 0),
  }));
  const resourceMap = new Map();
  for (const constraint of report.model.constraints.resourceConstraints) {
    if (constraint.relation !== "LE") throw new Error("QAOA IR supports LE resource constraints only");
    if (resourceMap.has(constraint.constraintId)) throw new Error("duplicate QAOA IR resource constraint");
    resourceMap.set(constraint.constraintId, integer(constraint.limit, `QAOA IR limit ${constraint.constraintId}`, 0));
  }
  const required = ["BUDGET_MICROS", "EDITORIAL_CAPACITY_UNITS", "ENGINEERING_CAPACITY_UNITS", "RISK_CAPACITY_UNITS", "MAXIMUM_SELECTED"];
  for (const id of required) if (!resourceMap.has(id)) throw new Error(`QAOA IR missing ${id}`);

  const dependencies = report.model.constraints.dependencyConstraints.map((edge, index) => {
    if (edge.relation !== "X_LE_REQUIRES_X") throw new Error("unsupported QAOA IR dependency relation");
    const child = sha(edge.decisionId, `QAOA IR dependency ${index}`);
    const parent = sha(edge.requiresDecisionId, `QAOA IR dependency requirement ${index}`);
    if (!indexById.has(child) || !indexById.has(parent)) throw new Error("QAOA IR dependency identity mismatch");
    return freeze([indexById.get(child), indexById.get(parent)]);
  });
  const mutexGroups = report.model.constraints.mutexConstraints.map((group, index) => {
    if (group.relation !== "SUM_LE" || group.limit !== 1) throw new Error("unsupported QAOA IR mutex relation");
    return freeze(group.decisionIds.map((id) => {
      const normalized = sha(id, `QAOA IR mutex ${index}`);
      if (!indexById.has(normalized)) throw new Error("QAOA IR mutex identity mismatch");
      return indexById.get(normalized);
    }));
  });
  return freeze({
    ids: freeze(ids),
    objective: freeze(objective),
    resources: freeze(resources),
    limits: freeze({
      costMicros: resourceMap.get("BUDGET_MICROS"),
      editorialUnits: resourceMap.get("EDITORIAL_CAPACITY_UNITS"),
      engineeringUnits: resourceMap.get("ENGINEERING_CAPACITY_UNITS"),
      riskUnits: resourceMap.get("RISK_CAPACITY_UNITS"),
      maximumSelected: resourceMap.get("MAXIMUM_SELECTED"),
    }),
    dependencies: freeze(dependencies),
    mutexGroups: freeze(mutexGroups),
  });
}

function evaluateMask(mask, problem) {
  let objective = 0n;
  let costMicros = 0;
  let editorialUnits = 0;
  let engineeringUnits = 0;
  let riskUnits = 0;
  let selectedCount = 0;
  for (let index = 0; index < problem.ids.length; index += 1) {
    if ((mask & (1 << index)) === 0) continue;
    objective += problem.objective[index];
    costMicros += problem.resources[index].costMicros;
    editorialUnits += problem.resources[index].editorialUnits;
    engineeringUnits += problem.resources[index].engineeringUnits;
    riskUnits += problem.resources[index].riskUnits;
    selectedCount += 1;
  }
  let feasible = costMicros <= problem.limits.costMicros
    && editorialUnits <= problem.limits.editorialUnits
    && engineeringUnits <= problem.limits.engineeringUnits
    && riskUnits <= problem.limits.riskUnits
    && selectedCount <= problem.limits.maximumSelected;
  if (feasible) {
    for (const [child, parent] of problem.dependencies) {
      if ((mask & (1 << child)) !== 0 && (mask & (1 << parent)) === 0) { feasible = false; break; }
    }
  }
  if (feasible) {
    for (const group of problem.mutexGroups) {
      let count = 0;
      for (const index of group) if ((mask & (1 << index)) !== 0) count += 1;
      if (count > 1) { feasible = false; break; }
    }
  }
  return freeze({ feasible, objective });
}

function buildBasisScores(problem) {
  const evaluations = Array.from({ length: 1 << problem.ids.length }, (_, mask) => evaluateMask(mask, problem));
  let maximumFeasibleObjective = 0n;
  for (const row of evaluations) if (row.feasible && row.objective > maximumFeasibleObjective) maximumFeasibleObjective = row.objective;
  return freeze(evaluations.map((row) => {
    if (!row.feasible) return INFEASIBLE_SCORE_PPM;
    if (maximumFeasibleObjective === 0n) return 0;
    return Number((row.objective * BigInt(SCORE_SCALE_PPM)) / maximumFeasibleObjective);
  }));
}

function normalizeParameters({ parameterSetId, gammaMicroradians, betaMicroradians }) {
  const id = text(parameterSetId, "QAOA IR parameterSetId", { pattern: TOKEN_RE });
  if (!Array.isArray(gammaMicroradians) || !Array.isArray(betaMicroradians)
    || gammaMicroradians.length < 1 || gammaMicroradians.length > MAX_DEPTH
    || betaMicroradians.length !== gammaMicroradians.length) {
    throw new Error("QAOA IR parameters require one common depth in range 1..3");
  }
  const gamma = gammaMicroradians.map((value, index) => integer(value, `QAOA IR gamma ${index}`, 0, TWO_PI_MICRORADIANS));
  const beta = betaMicroradians.map((value, index) => integer(value, `QAOA IR beta ${index}`, 0, TWO_PI_MICRORADIANS));
  const parameterBindingSha256 = canonicalQuantumSha256({ parameterSetId: id, gammaMicroradians: gamma, betaMicroradians: beta });
  return freeze({ parameterSetId: id, gammaMicroradians: freeze(gamma), betaMicroradians: freeze(beta), parameterBindingSha256 });
}

function buildOperations(parameters, scoreTableSha256) {
  const operations = [freeze({ operation: "HADAMARD_ALL" })];
  for (let layer = 0; layer < parameters.gammaMicroradians.length; layer += 1) {
    operations.push(freeze({
      operation: "DIAGONAL_COST_PHASE",
      gammaMicroradians: parameters.gammaMicroradians[layer],
      scoreTableSha256,
      phaseConvention: "EXP_NEG_I_GAMMA_TIMES_SCORE",
    }));
    operations.push(freeze({
      operation: "X_MIXER_ALL",
      betaMicroradians: parameters.betaMicroradians[layer],
      mixerConvention: "EXP_NEG_I_BETA_X",
    }));
  }
  operations.push(freeze({ operation: "MEASURE_ALL", measurementBitOrder: "QUBIT_0_RIGHTMOST" }));
  return freeze(operations);
}

export function buildQaoaExecutableCircuitIr({ optimizationProblemReport, problemBinding, problemContract, parameterSetId, gammaMicroradians, betaMicroradians }) {
  const { binding, contract } = validateReportBindings(optimizationProblemReport, problemBinding, problemContract);
  const problem = problemView(optimizationProblemReport, contract);
  const parameters = normalizeParameters({ parameterSetId, gammaMicroradians, betaMicroradians });
  const basisScoresPpm = buildBasisScores(problem);
  const scoreTableSha256 = canonicalQuantumSha256(basisScoresPpm);
  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    irKind: "NEXUS_QAOA_EXECUTABLE_IR_V1",
    problemBindingSha256: binding.bindingSha256,
    optimizationProblemReportSha256: binding.optimizationProblemReportSha256,
    optimizationModelSha256: binding.optimizationModelSha256,
    variableEncoding: "ONE_BINARY_DECISION_VARIABLE_PER_QUBIT",
    decisionVariableIds: problem.ids,
    logicalQubitCount: problem.ids.length,
    stateIndexEncoding: "LITTLE_ENDIAN_QUBIT_INDEX_TO_INTEGER_BIT",
    measurementBitOrder: "QUBIT_0_RIGHTMOST",
    parameterSetId: parameters.parameterSetId,
    gammaMicroradians: parameters.gammaMicroradians,
    betaMicroradians: parameters.betaMicroradians,
    parameterBindingSha256: parameters.parameterBindingSha256,
    scoreScalePpm: SCORE_SCALE_PPM,
    infeasibleScorePpm: INFEASIBLE_SCORE_PPM,
    basisScoresPpm,
    scoreTableSha256,
    operations: buildOperations(parameters, scoreTableSha256),
  };
  return freeze({ ...unsigned, circuitSha256: canonicalQuantumSha256(unsigned) });
}

export function validateQaoaExecutableCircuitIr(ir) {
  exactKeys(ir, [
    "basisScoresPpm", "betaMicroradians", "circuitSha256", "decisionVariableIds", "gammaMicroradians", "infeasibleScorePpm",
    "irKind", "logicalQubitCount", "measurementBitOrder", "operations", "optimizationModelSha256", "optimizationProblemReportSha256",
    "parameterBindingSha256", "parameterSetId", "problemBindingSha256", "schemaVersion", "scoreScalePpm", "scoreTableSha256",
    "stateIndexEncoding", "variableEncoding",
  ], "QAOA executable IR");
  if (ir.schemaVersion !== SCHEMA_VERSION || ir.irKind !== "NEXUS_QAOA_EXECUTABLE_IR_V1") throw new Error("unsupported QAOA executable IR schema");
  if (ir.variableEncoding !== "ONE_BINARY_DECISION_VARIABLE_PER_QUBIT"
    || ir.stateIndexEncoding !== "LITTLE_ENDIAN_QUBIT_INDEX_TO_INTEGER_BIT"
    || ir.measurementBitOrder !== "QUBIT_0_RIGHTMOST") throw new Error("unsupported QAOA executable IR encoding");
  const logicalQubitCount = integer(ir.logicalQubitCount, "QAOA IR logicalQubitCount", 1, MAX_QUBITS);
  if (!Array.isArray(ir.decisionVariableIds) || ir.decisionVariableIds.length !== logicalQubitCount) throw new Error("QAOA IR decision variable count mismatch");
  const decisionVariableIds = ir.decisionVariableIds.map((id, index) => sha(id, `QAOA IR decision variable ${index}`));
  if (new Set(decisionVariableIds).size !== decisionVariableIds.length) throw new Error("QAOA IR duplicate decision variable identity");
  const parameters = normalizeParameters({
    parameterSetId: ir.parameterSetId,
    gammaMicroradians: ir.gammaMicroradians,
    betaMicroradians: ir.betaMicroradians,
  });
  if (sha(ir.parameterBindingSha256, "QAOA IR parameter binding hash") !== parameters.parameterBindingSha256) throw new Error("QAOA IR parameter binding hash mismatch");
  if (ir.scoreScalePpm !== SCORE_SCALE_PPM || ir.infeasibleScorePpm !== INFEASIBLE_SCORE_PPM) throw new Error("QAOA IR score convention mismatch");
  if (!Array.isArray(ir.basisScoresPpm) || ir.basisScoresPpm.length !== 1 << logicalQubitCount) throw new Error("QAOA IR basis score table size mismatch");
  const basisScoresPpm = ir.basisScoresPpm.map((value, index) => signedInteger(value, `QAOA IR basis score ${index}`, INFEASIBLE_SCORE_PPM, SCORE_SCALE_PPM));
  if (basisScoresPpm[0] < 0) throw new Error("QAOA IR zero basis state must remain feasible");
  const scoreTableSha256 = canonicalQuantumSha256(basisScoresPpm);
  if (sha(ir.scoreTableSha256, "QAOA IR score table hash") !== scoreTableSha256) throw new Error("QAOA IR score table hash mismatch");
  const operations = buildOperations(parameters, scoreTableSha256);
  if (!Array.isArray(ir.operations) || canonicalQuantumSha256(ir.operations) !== canonicalQuantumSha256(operations)) throw new Error("QAOA IR operation sequence mismatch");
  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    irKind: ir.irKind,
    problemBindingSha256: sha(ir.problemBindingSha256, "QAOA IR problem binding hash"),
    optimizationProblemReportSha256: sha(ir.optimizationProblemReportSha256, "QAOA IR optimization report hash"),
    optimizationModelSha256: sha(ir.optimizationModelSha256, "QAOA IR optimization model hash"),
    variableEncoding: ir.variableEncoding,
    decisionVariableIds,
    logicalQubitCount,
    stateIndexEncoding: ir.stateIndexEncoding,
    measurementBitOrder: ir.measurementBitOrder,
    parameterSetId: parameters.parameterSetId,
    gammaMicroradians: parameters.gammaMicroradians,
    betaMicroradians: parameters.betaMicroradians,
    parameterBindingSha256: parameters.parameterBindingSha256,
    scoreScalePpm: SCORE_SCALE_PPM,
    infeasibleScorePpm: INFEASIBLE_SCORE_PPM,
    basisScoresPpm: freeze(basisScoresPpm),
    scoreTableSha256,
    operations,
  };
  const circuitSha256 = sha(ir.circuitSha256, "QAOA IR circuit hash");
  if (canonicalQuantumSha256(unsigned) !== circuitSha256) throw new Error("QAOA IR circuit hash mismatch");
  return freeze({ ...unsigned, circuitSha256 });
}

export function validateQaoaExecutableCircuitIrAgainstProblem({ ir, optimizationProblemReport, problemBinding, problemContract }) {
  const validated = validateQaoaExecutableCircuitIr(ir);
  const { binding, contract } = validateReportBindings(optimizationProblemReport, problemBinding, problemContract);
  if (validated.problemBindingSha256 !== binding.bindingSha256
    || validated.optimizationProblemReportSha256 !== binding.optimizationProblemReportSha256
    || validated.optimizationModelSha256 !== binding.optimizationModelSha256
    || validated.logicalQubitCount !== contract.decisionVariableCount
    || JSON.stringify(validated.decisionVariableIds) !== JSON.stringify(contract.decisionVariableIds)) {
    throw new Error("QAOA IR does not bind to the supplied optimization problem");
  }
  const rebuilt = buildQaoaExecutableCircuitIr({
    optimizationProblemReport,
    problemBinding: binding,
    problemContract: contract,
    parameterSetId: validated.parameterSetId,
    gammaMicroradians: validated.gammaMicroradians,
    betaMicroradians: validated.betaMicroradians,
  });
  if (rebuilt.circuitSha256 !== validated.circuitSha256) throw new Error("QAOA IR semantic reconstruction mismatch");
  return validated;
}

export const QaoaExecutableCircuitIr = Object.freeze({
  build: buildQaoaExecutableCircuitIr,
  validate: validateQaoaExecutableCircuitIr,
  validateAgainstProblem: validateQaoaExecutableCircuitIrAgainstProblem,
});

export const QAOA_EXECUTABLE_IR_MAX_QUBITS = MAX_QUBITS;
