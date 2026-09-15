import {
  QUANTUM_CONTRACT_SCHEMA_VERSION,
  TOKEN_RE,
  canonicalQuantumSha256,
  exactKeys,
  freeze,
} from "./common.mjs";
import {
  ProblemBinding,
  QuantumProblemContract,
  buildProblemBinding,
  buildQuantumProblemContract,
  validateProblemBinding,
  validateQuantumProblemContract,
} from "./problem-contract.mjs";
import { CircuitBinding, buildCircuitBinding, validateCircuitBinding } from "./circuit-binding.mjs";
import {
  QaoaExecutableCircuitIr,
  buildQaoaExecutableCircuitIr,
  validateQaoaExecutableCircuitIr,
  validateQaoaExecutableCircuitIrAgainstProblem,
} from "./qaoa-circuit-ir.mjs";
import {
  QaoaOpenQasm3Compiler,
  buildQaoaGateSequence,
  buildWalshScoreTerms,
  compileQaoaExecutableCircuitToOpenQasm3,
  validateCompiledOpenQasm3,
} from "./qaoa-openqasm3-compiler.mjs";
import {
  CalibrationEvidence,
  ExecutionReceipt,
  ResultDigest,
  buildExecutionReceipt,
  buildResultDigest,
  normalizeMeasurementCounts,
  validateCalibrationEvidence,
  validateExecutionReceipt,
} from "./execution-evidence.mjs";

const EXECUTION_VERDICTS = new Set(["PASS", "FAIL", "INCONCLUSIVE", "NOT_TESTED"]);

function validateCircuitPayloadBinding(circuitPayload, circuitBinding, problemBinding) {
  const payload = validateQaoaExecutableCircuitIr(circuitPayload);
  if (payload.problemBindingSha256 !== problemBinding.bindingSha256
    || payload.circuitSha256 !== circuitBinding.circuitSha256
    || payload.irKind !== circuitBinding.circuitFormat
    || payload.logicalQubitCount !== circuitBinding.logicalQubitCount
    || payload.parameterBindingSha256 !== circuitBinding.parameterBindingSha256
    || payload.measurementBitOrder !== circuitBinding.measurementBitOrder) {
    throw new Error("circuit payload/binding mismatch");
  }
  return payload;
}

export function validateBackendExecution(execution, descriptor) {
  exactKeys(execution, [
    "backendAdapterId", "backendFamily", "candidate", "circuitBinding", "circuitPayload", "executionReceipt", "problemBinding",
    "problemContract", "reasonCodes", "schemaVersion", "verdict",
  ], "backend execution");
  if (execution.schemaVersion !== QUANTUM_CONTRACT_SCHEMA_VERSION) throw new Error("unsupported backend execution schema");
  if (!EXECUTION_VERDICTS.has(execution.verdict)) throw new Error("unsupported backend execution verdict");
  if (execution.backendAdapterId !== descriptor.adapterId || execution.backendFamily !== descriptor.backendFamily) throw new Error("backend execution descriptor mismatch");
  const problemBinding = validateProblemBinding(execution.problemBinding);
  const problemContract = validateQuantumProblemContract(execution.problemContract);
  if (problemContract.problemBindingSha256 !== problemBinding.bindingSha256
    || problemContract.optimizationProblemReportSha256 !== problemBinding.optimizationProblemReportSha256
    || problemContract.optimizationModelSha256 !== problemBinding.optimizationModelSha256) throw new Error("problem contract/binding mismatch");
  const circuitBinding = validateCircuitBinding(execution.circuitBinding);
  if (circuitBinding.problemBindingSha256 !== problemBinding.bindingSha256) throw new Error("circuit/problem binding mismatch");
  const circuitPayload = validateCircuitPayloadBinding(execution.circuitPayload, circuitBinding, problemBinding);
  if (!Array.isArray(execution.reasonCodes) || execution.reasonCodes.some((code) => typeof code !== "string" || !TOKEN_RE.test(code))) throw new Error("backend execution reasonCodes invalid");
  const receipt = execution.executionReceipt === null ? null : validateExecutionReceipt(execution.executionReceipt);
  if (execution.verdict === "NOT_TESTED") {
    if (receipt !== null || execution.candidate !== null) throw new Error("NOT_TESTED execution cannot carry fabricated result evidence");
  } else if ((execution.verdict === "PASS" || execution.verdict === "INCONCLUSIVE") && !receipt) {
    throw new Error(`${execution.verdict} execution requires receipt`);
  }
  if (receipt) {
    if (receipt.backendFamily !== descriptor.backendFamily || receipt.hardwareExecution !== descriptor.hardwareExecution) throw new Error("receipt backend identity mismatch");
    if (receipt.problemBindingSha256 !== problemBinding.bindingSha256
      || receipt.optimizationProblemReportSha256 !== problemBinding.optimizationProblemReportSha256
      || receipt.optimizationModelSha256 !== problemBinding.optimizationModelSha256
      || receipt.circuitSha256 !== circuitBinding.circuitSha256) throw new Error("receipt binding mismatch");
  }
  return freeze({
    ...execution,
    problemBinding,
    problemContract,
    circuitBinding,
    circuitPayload,
    executionReceipt: receipt,
    reasonCodes: Object.freeze([...execution.reasonCodes]),
  });
}

export {
  QUANTUM_CONTRACT_SCHEMA_VERSION,
  canonicalQuantumSha256,
  ProblemBinding,
  QuantumProblemContract,
  CircuitBinding,
  QaoaExecutableCircuitIr,
  QaoaOpenQasm3Compiler,
  CalibrationEvidence,
  ExecutionReceipt,
  ResultDigest,
  buildProblemBinding,
  validateProblemBinding,
  buildQuantumProblemContract,
  validateQuantumProblemContract,
  buildCircuitBinding,
  validateCircuitBinding,
  buildQaoaExecutableCircuitIr,
  validateQaoaExecutableCircuitIr,
  validateQaoaExecutableCircuitIrAgainstProblem,
  buildWalshScoreTerms,
  buildQaoaGateSequence,
  compileQaoaExecutableCircuitToOpenQasm3,
  validateCompiledOpenQasm3,
  buildExecutionReceipt,
  validateExecutionReceipt,
  validateCalibrationEvidence,
  normalizeMeasurementCounts,
  buildResultDigest,
};

export const QUANTUM_EXECUTION_VERDICTS = Object.freeze([...EXECUTION_VERDICTS]);
