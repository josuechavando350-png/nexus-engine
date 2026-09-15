import {
  QUANTUM_CONTRACT_SCHEMA_VERSION as SCHEMA_VERSION,
  TOKEN_RE,
  canonicalQuantumSha256,
  exactKeys,
  freeze,
  integer,
  sha,
  text,
} from "./common.mjs";

function validateOptimizationReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("optimizationProblemReport must be object");
  if (report.engineId !== "WALLE_OPTIMIZATION_PROBLEM_BUILDER_V1") throw new Error("unexpected optimization problem engine");
  if (report.status !== "OPTIMIZATION_PROBLEM_READY") throw new Error("optimization problem is not ready");
  const reportSha256 = sha(report.reportSha256, "optimization report hash");
  const unsigned = { ...report };
  delete unsigned.reportSha256;
  if (canonicalQuantumSha256(unsigned) !== reportSha256) throw new Error("optimization report hash mismatch");
  if (!report.model || !report.summary) throw new Error("optimization problem missing model or summary");
  const modelSha256 = sha(report.summary.modelSha256, "optimization model hash");
  if (canonicalQuantumSha256(report.model) !== modelSha256) throw new Error("optimization model hash mismatch");
  if (!Array.isArray(report.model.variables) || report.model.variables.length < 1) throw new Error("optimization model requires variables");
  const constraints = report.model.constraints;
  if (!constraints || !Array.isArray(constraints.resourceConstraints)
    || !Array.isArray(constraints.dependencyConstraints) || !Array.isArray(constraints.mutexConstraints)) {
    throw new Error("optimization model constraints malformed");
  }
  return { reportSha256, modelSha256 };
}

export function buildProblemBinding(report) {
  const { reportSha256, modelSha256 } = validateOptimizationReport(report);
  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    bindingKind: "NEXUS_OPTIMIZATION_PROBLEM_BINDING_V1",
    optimizationProblemReportSha256: reportSha256,
    optimizationModelSha256: modelSha256,
  };
  return freeze({ ...unsigned, bindingSha256: canonicalQuantumSha256(unsigned) });
}

export function validateProblemBinding(binding) {
  exactKeys(binding, ["bindingKind", "bindingSha256", "optimizationModelSha256", "optimizationProblemReportSha256", "schemaVersion"], "ProblemBinding");
  if (binding.schemaVersion !== SCHEMA_VERSION || binding.bindingKind !== "NEXUS_OPTIMIZATION_PROBLEM_BINDING_V1") throw new Error("unsupported ProblemBinding schema");
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    bindingKind: binding.bindingKind,
    optimizationProblemReportSha256: sha(binding.optimizationProblemReportSha256, "ProblemBinding report hash"),
    optimizationModelSha256: sha(binding.optimizationModelSha256, "ProblemBinding model hash"),
  };
  const bindingSha256 = sha(binding.bindingSha256, "ProblemBinding hash");
  if (canonicalQuantumSha256(normalized) !== bindingSha256) throw new Error("ProblemBinding hash mismatch");
  return freeze({ ...normalized, bindingSha256 });
}

export function buildQuantumProblemContract(report) {
  const problemBinding = buildProblemBinding(report);
  const decisionVariableIds = report.model.variables.map((row, index) => sha(row.decisionId, `decision variable ${index}`));
  if (new Set(decisionVariableIds).size !== decisionVariableIds.length) throw new Error("duplicate decision variable identity");
  const objective = report.model.objective;
  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    contractKind: "NEXUS_QUANTUM_PROBLEM_CONTRACT_V1",
    sourceEngineId: report.engineId,
    problemBindingSha256: problemBinding.bindingSha256,
    optimizationProblemReportSha256: problemBinding.optimizationProblemReportSha256,
    optimizationModelSha256: problemBinding.optimizationModelSha256,
    objectiveSense: text(objective.sense, "objective sense", { pattern: TOKEN_RE }),
    objectiveId: text(objective.id, "objective id", { pattern: TOKEN_RE }),
    variableEncoding: "ONE_BINARY_DECISION_VARIABLE_PER_QUBIT",
    decisionVariableIds,
    decisionVariableCount: decisionVariableIds.length,
    constraintCounts: {
      resource: report.model.constraints.resourceConstraints.length,
      dependency: report.model.constraints.dependencyConstraints.length,
      mutex: report.model.constraints.mutexConstraints.length,
    },
  };
  return freeze({ ...unsigned, contractSha256: canonicalQuantumSha256(unsigned) });
}

export function validateQuantumProblemContract(contract) {
  exactKeys(contract, [
    "constraintCounts", "contractKind", "contractSha256", "decisionVariableCount", "decisionVariableIds", "objectiveId",
    "objectiveSense", "optimizationModelSha256", "optimizationProblemReportSha256", "problemBindingSha256", "schemaVersion",
    "sourceEngineId", "variableEncoding",
  ], "QuantumProblemContract");
  if (contract.schemaVersion !== SCHEMA_VERSION || contract.contractKind !== "NEXUS_QUANTUM_PROBLEM_CONTRACT_V1") throw new Error("unsupported QuantumProblemContract schema");
  if (contract.sourceEngineId !== "WALLE_OPTIMIZATION_PROBLEM_BUILDER_V1" || contract.variableEncoding !== "ONE_BINARY_DECISION_VARIABLE_PER_QUBIT") throw new Error("unexpected QuantumProblemContract identity");
  if (!Array.isArray(contract.decisionVariableIds) || contract.decisionVariableIds.length < 1) throw new Error("QuantumProblemContract requires decision variables");
  const decisionVariableIds = contract.decisionVariableIds.map((id, index) => sha(id, `contract decision variable ${index}`));
  if (new Set(decisionVariableIds).size !== decisionVariableIds.length) throw new Error("duplicate contract decision variable identity");
  const decisionVariableCount = integer(contract.decisionVariableCount, "decisionVariableCount", 1);
  if (decisionVariableCount !== decisionVariableIds.length) throw new Error("decisionVariableCount mismatch");
  exactKeys(contract.constraintCounts, ["dependency", "mutex", "resource"], "constraintCounts");
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    contractKind: contract.contractKind,
    sourceEngineId: contract.sourceEngineId,
    problemBindingSha256: sha(contract.problemBindingSha256, "problemBindingSha256"),
    optimizationProblemReportSha256: sha(contract.optimizationProblemReportSha256, "optimization report hash"),
    optimizationModelSha256: sha(contract.optimizationModelSha256, "optimization model hash"),
    objectiveSense: text(contract.objectiveSense, "objectiveSense", { pattern: TOKEN_RE }),
    objectiveId: text(contract.objectiveId, "objectiveId", { pattern: TOKEN_RE }),
    variableEncoding: contract.variableEncoding,
    decisionVariableIds,
    decisionVariableCount,
    constraintCounts: {
      resource: integer(contract.constraintCounts.resource, "resource constraint count"),
      dependency: integer(contract.constraintCounts.dependency, "dependency constraint count"),
      mutex: integer(contract.constraintCounts.mutex, "mutex constraint count"),
    },
  };
  const contractSha256 = sha(contract.contractSha256, "QuantumProblemContract hash");
  if (canonicalQuantumSha256(normalized) !== contractSha256) throw new Error("QuantumProblemContract hash mismatch");
  return freeze({ ...normalized, contractSha256 });
}

export const ProblemBinding = Object.freeze({ build: buildProblemBinding, validate: validateProblemBinding });
export const QuantumProblemContract = Object.freeze({ build: buildQuantumProblemContract, validate: validateQuantumProblemContract });
