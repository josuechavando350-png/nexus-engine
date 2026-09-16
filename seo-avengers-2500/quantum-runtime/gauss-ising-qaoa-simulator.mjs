import { createHash } from "node:crypto";

import { freeze, integer, text, TOKEN_RE } from "./common.mjs";

const ADAPTER_ID = "NEXUS_GAUSS_ISING_STATEVECTOR_QAOA_V1";
const MAX_QUBITS = 12;
const MAX_DEPTH = 4;
const TWO_PI_MICRORADIANS = 6_283_185;

function canonicalNumericJson(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("quantum evidence numbers must be finite");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalNumericJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, child]) => [key.normalize("NFC"), child])
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    const seen = new Set();
    return `{${entries.map(([key, child]) => {
      if (seen.has(key)) throw new TypeError("normalized quantum evidence key collision");
      seen.add(key);
      return `${JSON.stringify(key)}:${canonicalNumericJson(child)}`;
    }).join(",")}}`;
  }
  throw new TypeError("quantum evidence must be JSON-compatible");
}

function gaussQuantumSha256(value) {
  return `sha256:${createHash("sha256").update(Buffer.from(canonicalNumericJson(value), "utf8")).digest("hex")}`;
}

function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function normalizeProblem(problem) {
  if (!problem || typeof problem !== "object" || Array.isArray(problem)) throw new TypeError("GAUSS Ising quantum problem must be object");
  const problemId = text(problem.problemId, "problemId", { pattern: TOKEN_RE });
  if (!Array.isArray(problem.fields) || problem.fields.length < 1 || problem.fields.length > MAX_QUBITS) {
    throw new TypeError(`fields must contain 1..${MAX_QUBITS} entries`);
  }
  const fields = problem.fields.map((value, index) => finite(value, `fields[${index}]`));
  const couplings = Array.isArray(problem.couplings) ? problem.couplings.map((edge, index) => {
    if (!edge || typeof edge !== "object" || Array.isArray(edge)) throw new TypeError(`couplings[${index}] must be object`);
    const i = integer(edge.i, `couplings[${index}].i`, 0, fields.length - 1);
    const j = integer(edge.j, `couplings[${index}].j`, 0, fields.length - 1);
    if (i >= j) throw new TypeError("coupling indices must satisfy i < j");
    return freeze({ i, j, value: finite(edge.value, `couplings[${index}].value`) });
  }) : [];
  const seen = new Set();
  for (const edge of couplings) {
    const key = `${edge.i}:${edge.j}`;
    if (seen.has(key)) throw new TypeError(`duplicate coupling:${key}`);
    seen.add(key);
  }
  const offset = finite(problem.offset ?? 0, "offset");
  return freeze({ problemId, fields: freeze(fields), couplings: freeze(couplings), offset });
}

function normalizeParameterSet(parameterSet, index) {
  if (!parameterSet || typeof parameterSet !== "object" || Array.isArray(parameterSet)) throw new TypeError(`parameterSets[${index}] must be object`);
  const parameterSetId = text(parameterSet.parameterSetId, `parameterSets[${index}].parameterSetId`, { pattern: TOKEN_RE });
  if (!Array.isArray(parameterSet.gammaMicroradians) || !Array.isArray(parameterSet.betaMicroradians)
    || parameterSet.gammaMicroradians.length < 1 || parameterSet.gammaMicroradians.length > MAX_DEPTH
    || parameterSet.gammaMicroradians.length !== parameterSet.betaMicroradians.length) {
    throw new TypeError(`parameterSets[${index}] must have equal QAOA depth 1..${MAX_DEPTH}`);
  }
  const gammaMicroradians = parameterSet.gammaMicroradians.map((value, layer) => integer(value, `gamma[${index}][${layer}]`, 0, TWO_PI_MICRORADIANS));
  const betaMicroradians = parameterSet.betaMicroradians.map((value, layer) => integer(value, `beta[${index}][${layer}]`, 0, TWO_PI_MICRORADIANS));
  return freeze({ parameterSetId, gammaMicroradians: freeze(gammaMicroradians), betaMicroradians: freeze(betaMicroradians) });
}

function spin(mask, index) {
  return ((mask >>> index) & 1) === 0 ? 1 : -1;
}

function energy(problem, mask) {
  let value = problem.offset;
  for (let i = 0; i < problem.fields.length; i += 1) value += problem.fields[i] * spin(mask, i);
  for (const edge of problem.couplings) value += edge.value * spin(mask, edge.i) * spin(mask, edge.j);
  return value;
}

function exactGround(problem) {
  const stateCount = 1 << problem.fields.length;
  let bestEnergy = Infinity;
  let bestMask = 0;
  let degeneracy = 0;
  for (let mask = 0; mask < stateCount; mask += 1) {
    const current = energy(problem, mask);
    // Only equal finite energies are degenerate; a 1e-12 tolerance could
    // otherwise publish a nonminimum ground energy or impossible negative gap.
    if (current < bestEnergy) {
      bestEnergy = current;
      bestMask = mask;
      degeneracy = 1;
    } else if (current === bestEnergy) {
      degeneracy += 1;
      if (mask < bestMask) bestMask = mask;
    }
  }
  return freeze({ energy: bestEnergy, mask: bestMask, degeneracy });
}

function multiplyPhase(real, imaginary, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [real * cos - imaginary * sin, real * sin + imaginary * cos];
}

function runStatevector(problem, parameterSet) {
  const n = problem.fields.length;
  const stateCount = 1 << n;
  const norm = 1 / Math.sqrt(stateCount);
  let real = new Float64Array(stateCount);
  let imaginary = new Float64Array(stateCount);
  real.fill(norm);

  for (let layer = 0; layer < parameterSet.gammaMicroradians.length; layer += 1) {
    const gamma = parameterSet.gammaMicroradians[layer] / 1_000_000;
    for (let mask = 0; mask < stateCount; mask += 1) {
      const [r, i] = multiplyPhase(real[mask], imaginary[mask], -gamma * energy(problem, mask));
      real[mask] = r;
      imaginary[mask] = i;
    }

    const beta = parameterSet.betaMicroradians[layer] / 1_000_000;
    const cos = Math.cos(beta);
    const sin = Math.sin(beta);
    for (let qubit = 0; qubit < n; qubit += 1) {
      const bit = 1 << qubit;
      for (let mask = 0; mask < stateCount; mask += 1) {
        if ((mask & bit) !== 0) continue;
        const pair = mask | bit;
        const a0r = real[mask];
        const a0i = imaginary[mask];
        const a1r = real[pair];
        const a1i = imaginary[pair];
        real[mask] = cos * a0r + sin * a1i;
        imaginary[mask] = cos * a0i - sin * a1r;
        real[pair] = cos * a1r + sin * a0i;
        imaginary[pair] = cos * a1i - sin * a0r;
      }
    }
  }

  let totalProbability = 0;
  let expectedEnergy = 0;
  let bestProbability = -1;
  let bestMask = 0;
  let groundProbability = 0;
  const ground = exactGround(problem);
  for (let mask = 0; mask < stateCount; mask += 1) {
    const probability = real[mask] * real[mask] + imaginary[mask] * imaginary[mask];
    totalProbability += probability;
    const e = energy(problem, mask);
    expectedEnergy += probability * e;
    if (e === ground.energy) groundProbability += probability;
    if (probability > bestProbability || (probability === bestProbability && mask < bestMask)) {
      bestProbability = probability;
      bestMask = mask;
    }
  }
  const normError = Math.abs(1 - totalProbability);
  if (normError > 1e-9) throw new Error(`statevector normalization drift:${normError}`);
  return freeze({
    parameterSetId: parameterSet.parameterSetId,
    depth: parameterSet.gammaMicroradians.length,
    expectedEnergy,
    mostProbableMask: bestMask,
    mostProbableState: bestMask.toString(2).padStart(n, "0"),
    mostProbableProbability: bestProbability,
    groundStateEnergy: ground.energy,
    groundStateMask: ground.mask,
    groundStateProbability: groundProbability,
    approximationGap: expectedEnergy - ground.energy,
    normError,
  });
}

export function executeGaussIsingQaoaSimulation({ problem, parameterSets }) {
  const normalizedProblem = normalizeProblem(problem);
  if (!Array.isArray(parameterSets) || parameterSets.length < 1 || parameterSets.length > 128) throw new TypeError("parameterSets must contain 1..128 entries");
  const normalizedSets = parameterSets.map(normalizeParameterSet);
  if (new Set(normalizedSets.map((row) => row.parameterSetId)).size !== normalizedSets.length) throw new TypeError("duplicate parameterSetId");
  const problemSha256 = gaussQuantumSha256(normalizedProblem);
  const candidates = normalizedSets.map((parameterSet) => runStatevector(normalizedProblem, parameterSet));
  candidates.sort((left, right) => left.expectedEnergy - right.expectedEnergy || left.parameterSetId.localeCompare(right.parameterSetId));
  const selected = candidates[0];
  const unsigned = {
    schemaVersion: 1,
    adapterId: ADAPTER_ID,
    backendFamily: "SIMULATOR",
    hardwareExecution: false,
    verdict: "PASS",
    reasonCodes: ["STATEVECTOR_QAOA_EXECUTED", "NO_PHYSICAL_QPU_CLAIM", "NO_QUANTUM_ADVANTAGE_CLAIM"],
    problemSha256,
    qubitCount: normalizedProblem.fields.length,
    parameterSetCount: normalizedSets.length,
    candidates,
    selectedParameterSetId: selected.parameterSetId,
    selectedExpectedEnergy: selected.expectedEnergy,
    selectedGroundStateProbability: selected.groundStateProbability,
    exactGroundStateEnergy: selected.groundStateEnergy,
    quantumAdvantageClaimAllowed: false,
  };
  return freeze({ ...unsigned, receiptSha256: gaussQuantumSha256(unsigned) });
}

export const GAUSS_ISING_QAOA_ADAPTER_ID = ADAPTER_ID;
