import { assertArray, assertFiniteNumber } from "../common.mjs";

function normalizeProbabilities(values, label) {
  const probs = assertArray(values, label, { min: 1, max: 1_000_000 }).map((value, index) => assertFiniteNumber(value, `${label}[${index}]`, { min: 0, max: 1 }));
  const total = probs.reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > 1e-9) throw new TypeError(`${label} must sum to 1`);
  return probs;
}

export function shannonEntropy({ probabilities, base = 2 }) {
  const probs = normalizeProbabilities(probabilities, "probabilities");
  const b = assertFiniteNumber(base, "base", { min: 1 + Number.EPSILON });
  const denominator = Math.log(b);
  const entropy = -probs.reduce((sum, p) => p === 0 ? sum : sum + p * Math.log(p) / denominator, 0);
  return Object.freeze({ entropy, base: b });
}

export function mutualInformation({ joint, base = 2 }) {
  const matrix = assertArray(joint, "joint", { min: 1, max: 10_000 });
  const columns = assertArray(matrix[0], "joint[0]", { min: 1, max: 10_000 }).length;
  const normalized = matrix.map((row, i) => assertArray(row, `joint[${i}]`, { min: columns, max: columns }).map((value, j) => assertFiniteNumber(value, `joint[${i}][${j}]`, { min: 0, max: 1 })));
  const total = normalized.flat().reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > 1e-9) throw new TypeError("joint probabilities must sum to 1");
  const px = normalized.map((row) => row.reduce((sum, value) => sum + value, 0));
  const py = Array.from({ length: columns }, (_, j) => normalized.reduce((sum, row) => sum + row[j], 0));
  const denominator = Math.log(assertFiniteNumber(base, "base", { min: 1 + Number.EPSILON }));
  let information = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    for (let j = 0; j < columns; j += 1) {
      const p = normalized[i][j];
      if (p === 0) continue;
      information += p * Math.log(p / (px[i] * py[j])) / denominator;
    }
  }
  return Object.freeze({ mutualInformation: information, base });
}

export function renyiDivergence({ p, q, alpha = 2 }) {
  const left = normalizeProbabilities(p, "p");
  const right = normalizeProbabilities(q, "q");
  if (left.length !== right.length) throw new TypeError("p and q must have equal length");
  const a = assertFiniteNumber(alpha, "alpha", { min: Number.EPSILON });
  if (Math.abs(a - 1) < 1e-12) throw new TypeError("alpha=1 is KL divergence and is intentionally not accepted by this Renyi operator");
  let sum = 0;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] === 0) continue;
    if (right[i] === 0) return Object.freeze({ divergenceKind: "POSITIVE_INFINITY", divergence: null, alpha: a });
    sum += (left[i] ** a) * (right[i] ** (1 - a));
  }
  return Object.freeze({ divergenceKind: "FINITE", divergence: Math.log(sum) / (a - 1), alpha: a });
}
