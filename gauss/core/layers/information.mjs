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
  if (matrix.length * columns > 1_000_000) throw new RangeError("mutual information matrix exceeds bounded cell budget");
  const normalized = matrix.map((row, i) => assertArray(row, `joint[${i}]`, { min: columns, max: columns }).map((value, j) => assertFiniteNumber(value, `joint[${i}][${j}]`, { min: 0, max: 1 })));
  const total = normalized.reduce((sum, row) => sum + row.reduce((inner, value) => inner + value, 0), 0);
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
  const rawP = normalizeProbabilities(p, "p");
  const rawQ = normalizeProbabilities(q, "q");
  if (rawP.length !== rawQ.length) throw new TypeError("p and q must have equal length");
  const a = assertFiniteNumber(alpha, "alpha", { min: Number.EPSILON, max: 1_000_000 });
  // Normalize accepted round-off in probability mass before using log1p near alpha=1.
  const totalP = rawP.reduce((sum, value) => sum + value, 0);
  const totalQ = rawQ.reduce((sum, value) => sum + value, 0);
  const left = rawP.map((value) => value / totalP);
  const right = rawQ.map((value) => value / totalQ);
  const t = a - 1;

  if (t === 0) {
    let kl = 0;
    for (let i = 0; i < left.length; i += 1) {
      if (left[i] === 0) continue;
      if (right[i] === 0) return Object.freeze({ divergenceKind: "POSITIVE_INFINITY", divergence: null, alpha: a });
      kl += left[i] * (Math.log(left[i]) - Math.log(right[i]));
    }
    return Object.freeze({ divergenceKind: "FINITE", divergence: nonNegativeDivergence(kl, "Renyi KL-limit"), alpha: a });
  }

  let hasSupportMismatch = false;
  const logTerms = [];
  let maximumLogTerm = -Infinity;
  let nearOneDifference = 0;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] === 0) continue;
    if (right[i] === 0) {
      if (t > 0) return Object.freeze({ divergenceKind: "POSITIVE_INFINITY", divergence: null, alpha: a });
      hasSupportMismatch = true;
      continue;
    }
    const logP = Math.log(left[i]);
    const logQ = Math.log(right[i]);
    const ratioLog = logP - logQ;
    if (Math.abs(t) <= 1e-6) nearOneDifference += left[i] * Math.expm1(t * ratioLog);
    const logTerm = logP + t * ratioLog;
    if (!Number.isFinite(logTerm)) throw new RangeError("Renyi log-term exceeded finite numerical range");
    logTerms.push(logTerm);
    if (logTerm > maximumLogTerm) maximumLogTerm = logTerm;
  }
  if (logTerms.length === 0) return Object.freeze({ divergenceKind: "POSITIVE_INFINITY", divergence: null, alpha: a });

  // For full P-support under Q, log1p/expm1 avoids cancellation at alpha≈1.
  // With a support mismatch and alpha<1, the finite divergence must retain
  // missing P mass; substituting KL here would incorrectly return infinity.
  let logSum;
  if (!hasSupportMismatch && Math.abs(t) <= 1e-6) {
    logSum = Math.log1p(nearOneDifference);
  } else {
    const scaledSum = logTerms.reduce((sum, value) => sum + Math.exp(value - maximumLogTerm), 0);
    logSum = maximumLogTerm + Math.log(scaledSum);
  }
  const divergence = logSum / t;
  return Object.freeze({ divergenceKind: "FINITE", divergence: nonNegativeDivergence(divergence, "Renyi divergence"), alpha: a });
}
