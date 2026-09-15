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
import { validateProblemBinding } from "./problem-contract.mjs";

export function buildCircuitBinding({ problemBinding, circuitId, circuitFormat, logicalQubitCount, circuitSha256, parameterBindingSha256, measurementBitOrder = "QUBIT_0_RIGHTMOST" }) {
  const problem = validateProblemBinding(problemBinding);
  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    bindingKind: "NEXUS_QUANTUM_CIRCUIT_BINDING_V1",
    circuitId: text(circuitId, "circuitId", { pattern: TOKEN_RE }),
    circuitFormat: text(circuitFormat, "circuitFormat", { pattern: TOKEN_RE }),
    logicalQubitCount: integer(logicalQubitCount, "logicalQubitCount", 1, 4096),
    circuitSha256: sha(circuitSha256, "circuit hash"),
    parameterBindingSha256: sha(parameterBindingSha256, "parameter binding hash"),
    problemBindingSha256: problem.bindingSha256,
    measurementBitOrder: text(measurementBitOrder, "measurementBitOrder", { pattern: TOKEN_RE }),
  };
  if (unsigned.measurementBitOrder !== "QUBIT_0_RIGHTMOST") throw new Error("unsupported measurement bit order");
  return freeze({ ...unsigned, bindingSha256: canonicalQuantumSha256(unsigned) });
}

export function validateCircuitBinding(binding) {
  exactKeys(binding, ["bindingKind", "bindingSha256", "circuitFormat", "circuitId", "circuitSha256", "logicalQubitCount", "measurementBitOrder", "parameterBindingSha256", "problemBindingSha256", "schemaVersion"], "CircuitBinding");
  if (binding.schemaVersion !== SCHEMA_VERSION || binding.bindingKind !== "NEXUS_QUANTUM_CIRCUIT_BINDING_V1") throw new Error("unsupported CircuitBinding schema");
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    bindingKind: binding.bindingKind,
    circuitId: text(binding.circuitId, "circuitId", { pattern: TOKEN_RE }),
    circuitFormat: text(binding.circuitFormat, "circuitFormat", { pattern: TOKEN_RE }),
    logicalQubitCount: integer(binding.logicalQubitCount, "logicalQubitCount", 1, 4096),
    circuitSha256: sha(binding.circuitSha256, "circuit hash"),
    parameterBindingSha256: sha(binding.parameterBindingSha256, "parameter binding hash"),
    problemBindingSha256: sha(binding.problemBindingSha256, "problem binding hash"),
    measurementBitOrder: text(binding.measurementBitOrder, "measurementBitOrder", { pattern: TOKEN_RE }),
  };
  if (normalized.measurementBitOrder !== "QUBIT_0_RIGHTMOST") throw new Error("unsupported measurement bit order");
  const bindingSha256 = sha(binding.bindingSha256, "CircuitBinding hash");
  if (canonicalQuantumSha256(normalized) !== bindingSha256) throw new Error("CircuitBinding hash mismatch");
  return freeze({ ...normalized, bindingSha256 });
}

export const CircuitBinding = Object.freeze({ build: buildCircuitBinding, validate: validateCircuitBinding });
