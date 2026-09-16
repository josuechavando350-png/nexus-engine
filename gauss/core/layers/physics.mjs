import { assertArray, assertFiniteNumber, assertObject, assertSafeInteger, normalizeNumberArray } from "../common.mjs";

export function takensEmbedding({ series, dimension, delay }) {
  const values = normalizeNumberArray(series, "series", { minLength: 3 });
  const d = assertSafeInteger(dimension, "dimension", { min: 2, max: 64 });
  const tau = assertSafeInteger(delay, "delay", { min: 1, max: values.length - 1 });
  const rows = values.length - (d - 1) * tau;
  if (rows < 1) throw new TypeError("series is too short for requested Takens embedding");
  const embedded = Array.from({ length: rows }, (_, start) => Object.freeze(
    Array.from({ length: d }, (_, k) => values[start + k * tau]),
  ));
  return Object.freeze({ dimension: d, delay: tau, pointCount: embedded.length, embedding: Object.freeze(embedded) });
}

function normalizeIsing(input) {
  assertObject(input, "ising input");
  const fields = normalizeNumberArray(input.fields, "fields", { minLength: 1, maxLength: 24 });
  const n = fields.length;
  const couplings = assertArray(input.couplings ?? [], "couplings", { min: 0, max: n * (n - 1) / 2 }).map((edge, index) => {
    assertObject(edge, `couplings[${index}]`);
    const i = assertSafeInteger(edge.i, `couplings[${index}].i`, { min: 0, max: n - 1 });
    const j = assertSafeInteger(edge.j, `couplings[${index}].j`, { min: 0, max: n - 1 });
    if (i >= j) throw new TypeError("coupling indices must satisfy i < j");
    return Object.freeze({ i, j, value: assertFiniteNumber(edge.value, `couplings[${index}].value`) });
  });
  const seen = new Set();
  for (const edge of couplings) {
    const key = `${edge.i}:${edge.j}`;
    if (seen.has(key)) throw new TypeError(`duplicate coupling ${key}`);
    seen.add(key);
  }
  const offset = assertFiniteNumber(input.offset ?? 0, "offset");
  return Object.freeze({ fields: Object.freeze(fields), couplings: Object.freeze(couplings), offset });
}

export function isingEnergy({ spins, fields, couplings = [], offset = 0 }) {
  const model = normalizeIsing({ fields, couplings, offset });
  const state = assertArray(spins, "spins", { min: model.fields.length, max: model.fields.length }).map((spin, index) => {
    if (spin !== -1 && spin !== 1) throw new TypeError(`spins[${index}] must be -1 or 1`);
    return spin;
  });
  let energy = model.offset;
  for (let i = 0; i < state.length; i += 1) energy += model.fields[i] * state[i];
  for (const edge of model.couplings) energy += edge.value * state[edge.i] * state[edge.j];
  return Object.freeze({ energy });
}

export function exactIsingGroundState({ fields, couplings = [], offset = 0 }) {
  const model = normalizeIsing({ fields, couplings, offset });
  const n = model.fields.length;
  if (n > 22) throw new RangeError("exact Ising search is bounded to 22 spins");
  const total = 2 ** n;
  let bestEnergy = Infinity;
  let bestSpins = null;
  let degeneracy = 0;
  for (let mask = 0; mask < total; mask += 1) {
    // Canonical GAUSS/Quantum convention: computational bit 0 -> spin +1,
    // computational bit 1 -> spin -1.
    const spins = Array.from({ length: n }, (_, index) => ((mask >>> index) & 1) === 0 ? 1 : -1);
    let energy = model.offset;
    for (let i = 0; i < n; i += 1) energy += model.fields[i] * spins[i];
    for (const edge of model.couplings) energy += edge.value * spins[edge.i] * spins[edge.j];
    if (energy < bestEnergy - 1e-12) {
      bestEnergy = energy;
      bestSpins = spins;
      degeneracy = 1;
    } else if (Math.abs(energy - bestEnergy) <= 1e-12) {
      degeneracy += 1;
    }
  }
  return Object.freeze({ energy: bestEnergy, spins: Object.freeze(bestSpins), degeneracy, evaluatedStates: total });
}
