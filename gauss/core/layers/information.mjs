import { assertArray, assertFiniteNumber } from "../common.mjs";

function normalizeProbabilities(values, label) {
  const probs = assertArray(values, label, { min: 1, max: 1_000_000 }).map((value, index) => assertFiniteNumber(value, `${label}[${index}]`, { min: 0, max: 1 }));
  const total = probs.reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > 1e-9) throw new TypeError(`${label} must sum to 1`);
  return probs;
}

function nonNegativeDivergence(value, label) {
  if (!Number.isFinite(value)) throw new Error(`${label} produced non-finite numerical output`);
  if (value < -1e-10) throw new Error(`${label} violated non-negativity beyond numerical tolerance`);
  return value < 0 ? 0 : value;
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
  return Object.freeze({ mutualInformation: nonNegativeDivergence(information, "mutual information"), base });
}

export function renyiDivergence({ p, q, alpha = 2 }) {
  const left = normalizeProbabilities(p, "p");
  const right = normalizeProbabilities(q, "q");
  if (left.length !== right.length) throw new TypeError("p and q must have equal length");
  const a = assertFiniteNumber(alpha, "alpha", { min: Number.EPSILON, max: 1_000_000 });

  // D_1 is the Kullback-Leibler limit. Evaluating the limit directly also
  // avoids catastrophic cancellation for alpha numerically close to one.
  if (Math.abs(a - 1) <= 1e-8) {
    let kl = 0;
    for (let i = 0; i < left.length; i += 1) {
      if (left[i] === 0) continue;
      if (right[i] === 0) return Object.freeze({ divergenceKind: "POSITIVE_INFINITY", divergence: null, alpha: a });
      kl += left[i] * Math.log(left[i] / right[i]);
    }
    return Object.freeze({ divergenceKind: "FINITE", divergence: nonNegativeDivergence(kl, "Renyi KL-limit"), alpha: a });
  }

  const logTerms = [];
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] === 0) continue;
    if (right[i] === 0) {
      if (a > 1) return Object.freeze({ divergenceKind: "POSITIVE_INFINITY", divergence: null, alpha: a });
      continue;
    }
    logTerms.push(a * Math.log(left[i]) + (1 - a) * Math.log(right[i]));
  }
  if (logTerms.length === 0) return Object.freeze({ divergenceKind: "POSITIVE_INFINITY", divergence: null, alpha: a });

  const maximumLogTerm = Math.max(...logTerms);
  const scaledSum = logTerms.reduce((sum, value) => sum + Math.exp(value - maximumLogTerm), 0);
  const logSum = maximumLogTerm + Math.log(scaledSum);
  const divergence = logSum / (a - 1);
  return Object.freeze({ divergenceKind: "FINITE", divergence: nonNegativeDivergence(divergence, "Renyi divergence"), alpha: a });
}
