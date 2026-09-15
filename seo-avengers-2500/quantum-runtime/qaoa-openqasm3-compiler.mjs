import { createHash } from "node:crypto";

import {
  QUANTUM_CONTRACT_SCHEMA_VERSION as SCHEMA_VERSION,
  canonicalQuantumSha256,
  exactKeys,
  freeze,
  integer,
  sha,
} from "./common.mjs";
import { validateQaoaExecutableCircuitIr } from "./qaoa-circuit-ir.mjs";

const COMPILER_ID = "NEXUS_QAOA_OPENQASM3_COMPILER_V1";
const SCORE_SCALE = 1_000_000n;
const MICRORADIAN_SCALE = 1_000_000n;
const MAX_QASM_BYTES = 64 * 1024 * 1024;

function rawSha256(value) {
  return `sha256:${createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex")}`;
}

function gcd(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function rational(numerator, denominator) {
  if (denominator === 0n) throw new Error("angle denominator cannot be zero");
  let n = numerator;
  let d = denominator;
  if (d < 0n) { n = -n; d = -d; }
  const divisor = gcd(n, d);
  return freeze({ numerator: (n / divisor).toString(), denominator: (d / divisor).toString() });
}

function qasmAngle(value) {
  const numerator = BigInt(value.numerator);
  const denominator = BigInt(value.denominator);
  if (denominator === 1n) return `${numerator}.0`;
  return `(${numerator}.0/${denominator}.0)`;
}

function subsetQubits(mask, qubitCount) {
  const qubits = [];
  for (let qubit = 0; qubit < qubitCount; qubit += 1) if ((mask & (1 << qubit)) !== 0) qubits.push(qubit);
  return qubits;
}

function walshHadamardNumerators(scores) {
  const spectrum = scores.map((score) => BigInt(score));
  for (let width = 1; width < spectrum.length; width *= 2) {
    const blockSize = width * 2;
    for (let block = 0; block < spectrum.length; block += blockSize) {
      for (let offset = 0; offset < width; offset += 1) {
        const leftIndex = block + offset;
        const rightIndex = leftIndex + width;
        const left = spectrum[leftIndex];
        const right = spectrum[rightIndex];
        spectrum[leftIndex] = left + right;
        spectrum[rightIndex] = left - right;
      }
    }
  }
  return spectrum;
}

export function buildWalshScoreTerms(input) {
  const ir = validateQaoaExecutableCircuitIr(input);
  const stateCount = 1 << ir.logicalQubitCount;
  const denominator = BigInt(stateCount) * SCORE_SCALE;
  const numerators = walshHadamardNumerators(ir.basisScoresPpm);
  const terms = [];
  for (let subsetMask = 0; subsetMask < stateCount; subsetMask += 1) {
    const numerator = numerators[subsetMask];
    if (numerator === 0n) continue;
    terms.push(freeze({ subsetMask, coefficient: rational(numerator, denominator) }));
  }
  return freeze(terms);
}

function appendCostLayer(gates, ir, gammaMicroradians, walshTerms) {
  for (const term of walshTerms) {
    if (term.subsetMask === 0) continue; // Constant Walsh term is a global phase and cannot affect measurement probabilities.
    const qubits = subsetQubits(term.subsetMask, ir.logicalQubitCount);
    const target = qubits[qubits.length - 1];
    for (let index = 0; index < qubits.length - 1; index += 1) gates.push(freeze({ gate: "CX", control: qubits[index], target }));
    gates.push(freeze({
      gate: "RZ",
      qubit: target,
      angle: rational(
        2n * BigInt(gammaMicroradians) * BigInt(term.coefficient.numerator),
        MICRORADIAN_SCALE * BigInt(term.coefficient.denominator),
      ),
      walshSubsetMask: term.subsetMask,
    }));
    for (let index = qubits.length - 2; index >= 0; index -= 1) gates.push(freeze({ gate: "CX", control: qubits[index], target }));
  }
}

function appendMixerLayer(gates, qubitCount, betaMicroradians) {
  const angle = rational(2n * BigInt(betaMicroradians), MICRORADIAN_SCALE);
  for (let qubit = 0; qubit < qubitCount; qubit += 1) gates.push(freeze({ gate: "RX", qubit, angle }));
}

export function buildQaoaGateSequence(input) {
  const ir = validateQaoaExecutableCircuitIr(input);
  const walshTerms = buildWalshScoreTerms(ir);
  const gates = [];
  for (let qubit = 0; qubit < ir.logicalQubitCount; qubit += 1) gates.push(freeze({ gate: "H", qubit }));
  for (let layer = 0; layer < ir.gammaMicroradians.length; layer += 1) {
    appendCostLayer(gates, ir, ir.gammaMicroradians[layer], walshTerms);
    appendMixerLayer(gates, ir.logicalQubitCount, ir.betaMicroradians[layer]);
  }
  for (let qubit = 0; qubit < ir.logicalQubitCount; qubit += 1) gates.push(freeze({ gate: "MEASURE", qubit, bit: qubit }));
  return freeze(gates);
}

function serializeGate(gate) {
  if (gate.gate === "H") return `h q[${gate.qubit}];`;
  if (gate.gate === "CX") return `cx q[${gate.control}], q[${gate.target}];`;
  if (gate.gate === "RZ") return `rz(${qasmAngle(gate.angle)}) q[${gate.qubit}];`;
  if (gate.gate === "RX") return `rx(${qasmAngle(gate.angle)}) q[${gate.qubit}];`;
  if (gate.gate === "MEASURE") return `c[${gate.bit}] = measure q[${gate.qubit}];`;
  throw new Error(`unsupported lowered gate:${gate.gate}`);
}

function serializeOpenQasm3(qubitCount, gates) {
  const lines = [
    "OPENQASM 3.0;",
    "include \"stdgates.inc\";",
    `qubit[${qubitCount}] q;`,
    `bit[${qubitCount}] c;`,
    ...gates.map(serializeGate),
    "",
  ];
  const qasm3 = lines.join("\n");
  if (Buffer.byteLength(qasm3, "utf8") > MAX_QASM_BYTES) throw new Error("compiled OpenQASM 3 exceeds explicit 64 MiB evidence bound");
  return qasm3;
}

export function compileQaoaExecutableCircuitToOpenQasm3(input) {
  const ir = validateQaoaExecutableCircuitIr(input);
  const gates = buildQaoaGateSequence(ir);
  const qasm3 = serializeOpenQasm3(ir.logicalQubitCount, gates);
  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    compilerId: COMPILER_ID,
    sourceCircuitSha256: ir.circuitSha256,
    logicalQubitCount: ir.logicalQubitCount,
    measurementBitOrder: ir.measurementBitOrder,
    gateCount: gates.length,
    twoQubitGateCount: gates.filter((gate) => gate.gate === "CX").length,
    gateSequenceSha256: canonicalQuantumSha256(gates),
    qasm3Sha256: rawSha256(qasm3),
    qasm3,
  };
  return freeze({ ...unsigned, compilationSha256: canonicalQuantumSha256(unsigned) });
}

export function validateCompiledOpenQasm3(artifact, sourceIr) {
  exactKeys(artifact, [
    "compilationSha256", "compilerId", "gateCount", "gateSequenceSha256", "logicalQubitCount", "measurementBitOrder",
    "qasm3", "qasm3Sha256", "schemaVersion", "sourceCircuitSha256", "twoQubitGateCount",
  ], "compiled OpenQASM 3 artifact");
  if (artifact.schemaVersion !== SCHEMA_VERSION || artifact.compilerId !== COMPILER_ID) throw new Error("unsupported OpenQASM 3 compiler artifact");
  const sourceCircuitSha256 = sha(artifact.sourceCircuitSha256, "compiled source circuit hash");
  const expected = compileQaoaExecutableCircuitToOpenQasm3(sourceIr);
  if (sourceCircuitSha256 !== expected.sourceCircuitSha256
    || integer(artifact.logicalQubitCount, "compiled logicalQubitCount", 1, 14) !== expected.logicalQubitCount
    || artifact.measurementBitOrder !== expected.measurementBitOrder
    || integer(artifact.gateCount, "compiled gateCount", 1) !== expected.gateCount
    || integer(artifact.twoQubitGateCount, "compiled twoQubitGateCount", 0) !== expected.twoQubitGateCount
    || sha(artifact.gateSequenceSha256, "compiled gate sequence hash") !== expected.gateSequenceSha256
    || sha(artifact.qasm3Sha256, "compiled qasm hash") !== expected.qasm3Sha256
    || artifact.qasm3 !== expected.qasm3
    || sha(artifact.compilationSha256, "compiled artifact hash") !== expected.compilationSha256) {
    throw new Error("compiled OpenQASM 3 artifact mismatch");
  }
  return expected;
}

export const QaoaOpenQasm3Compiler = Object.freeze({
  buildWalshScoreTerms,
  buildGateSequence: buildQaoaGateSequence,
  compile: compileQaoaExecutableCircuitToOpenQasm3,
  validate: validateCompiledOpenQasm3,
});
