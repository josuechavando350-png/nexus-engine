import assert from 'node:assert/strict';
import test from 'node:test';
import { discreteEntropicValueAtRisk as evar } from '../core/layers/entropic-risk.mjs';

// Independently minimize the Chernoff log-moment objective in log-temperature
// coordinates; this oracle does not use the implementation's KL root solver.
function independentChernoffOracle(outcomes, confidence) {
  const positive = outcomes.filter((row) => row.probability > 0);
  const top = Math.max(...positive.map((row) => row.loss));
  const topMass = positive.reduce((sum, row) => sum + (row.loss === top ? row.probability : 0), 0);
  if (confidence === 0) return outcomes.reduce((sum, row) => sum + row.probability * row.loss, 0);
  if (topMass >= 1 - confidence) return top;
  const bottom = Math.min(...positive.map((row) => row.loss));
  const range = top - bottom;
  const budget = -Math.log(1 - confidence);
  const objective = (logTime) => {
    const time = Math.exp(logTime);
    const weighted = positive.reduce((sum, row) => sum + row.probability * Math.exp(time * ((row.loss - top) / range)), 0);
    return top + range * (Math.log(weighted) + budget) / time;
  };
  let left = -18;
  let right = 18;
  for (let k = 0; k < 220; k += 1) {
    const a = left + (right - left) / 3;
    const b = right - (right - left) / 3;
    if (objective(a) < objective(b)) right = b;
    else left = a;
  }
  return objective((left + right) / 2);
}

// Independent primal KL-ball solution for a Bernoulli support: q_high is the
// largest probability of the higher loss with KL(q||p) <= -log(1-alpha).
function binaryKLBudgetOracle(pHigh, low, high, alpha) {
  const budget = -Math.log(1 - alpha);
  if (budget >= -Math.log(pHigh)) return high;
  const kl = (q) => q * Math.log(q / pHigh) + (1 - q) * Math.log((1 - q) / (1 - pHigh));
  let lowQ = pHigh;
  let highQ = 1;
  for (let k = 0; k < 180; k += 1) {
    const mid = (lowQ + highQ) / 2;
    if (kl(mid) > budget) highQ = mid;
    else lowQ = mid;
  }
  return low + (high - low) * (lowQ + highQ) / 2;
}

function independentCvarOracle(outcomes, alpha) {
  return Math.min(...outcomes.map(({ loss: candidate }) => candidate + outcomes.reduce(
    (sum, { loss, probability }) => sum + probability * Math.max(0, loss - candidate), 0,
  ) / (1 - alpha)));
}

test('EVaR covers zero-confidence mean, exact worst loss, negative and duplicated outcomes', () => {
  const outcomes = [
    { loss: -8, probability: 0.4 }, { loss: 10, probability: 0.3 },
    { loss: 10, probability: 0.2 }, { loss: 90, probability: 0.1 },
    { loss: 1e9, probability: 0 },
  ];
  assert(Math.abs(evar({ outcomes, confidence: 0 }).entropicValueAtRisk - 10.8) < 1e-12);
  assert.equal(evar({ outcomes, confidence: 0.95 }).entropicValueAtRisk, 90);
  assert.equal(evar({ outcomes: [{ loss: -7, probability: 1 }], confidence: 0.999999 }).entropicValueAtRisk, -7);
  assert.equal(evar({ outcomes: [{ loss: 0, probability: 0.8 }, { loss: 1, probability: 0.2 }], confidence: 0.8 }).entropicValueAtRisk, 1);
});

test('EVaR matches an independent binary KL-ball oracle at ten confidence settings', () => {
  for (let i = 1; i <= 10; i += 1) {
    const p = i / 30;
    const alpha = i / 12;
    const outcomes = [{ loss: -8, probability: 1 - p }, { loss: 12, probability: p }];
    const actual = evar({ outcomes, confidence: alpha }).entropicValueAtRisk;
    const expected = binaryKLBudgetOracle(p, -8, 12, alpha);
    assert(Math.abs(actual - expected) < 1e-9, `${i}: ${actual} vs ${expected}`);
  }
});

test('EVaR matches a separate Chernoff optimizer and dominates CVaR on 180 seeded cases', () => {
  let state = 0x30aac811;
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  for (let trial = 0; trial < 180; trial += 1) {
    const n = 2 + (next() % 7);
    const weights = Array.from({ length: n }, () => 1 + next() % 90);
    const total = weights.reduce((sum, w) => sum + w, 0);
    const outcomes = weights.map((w) => ({ loss: (next() % 101) - 50, probability: w / total }));
    const alpha = [0.05, 0.2, 0.4, 0.6, 0.75, 0.9, 0.95][trial % 7];
    const actual = evar({ outcomes, confidence: alpha });
    const expected = independentChernoffOracle(outcomes, alpha);
    const cvar = independentCvarOracle(outcomes, alpha);
    assert(Math.abs(actual.entropicValueAtRisk - expected) < 1e-7 * Math.max(1, Math.abs(expected)), `trial ${trial}: ${actual.entropicValueAtRisk} vs ${expected}`);
    assert(actual.entropicValueAtRisk >= cvar - 1e-8, `trial ${trial}: EVaR below CVaR`);
    assert(actual.entropicValueAtRisk <= actual.worstLoss + 1e-8);
    assert(actual.entropicValueAtRisk >= actual.expectedLoss - 1e-8);
    assert(['WORST_LOSS', 'EXPONENTIAL_TILT'].includes(actual.solutionKind));
  }
});

test('EVaR is translation and positive-scale equivariant without overflow', () => {
  const outcomes = [{ loss: -8, probability: 0.5 }, { loss: 0, probability: 0.3 }, { loss: 12, probability: 0.2 }];
  const base = evar({ outcomes, confidence: 0.65 });
  const shifted = evar({ outcomes: outcomes.map(({ loss, probability }) => ({ loss: loss + 1e8, probability })), confidence: 0.65 });
  const scaled = evar({ outcomes: outcomes.map(({ loss, probability }) => ({ loss: loss * 1000, probability })), confidence: 0.65 });
  assert(Math.abs((shifted.entropicValueAtRisk - 1e8) - base.entropicValueAtRisk) < 1e-7);
  assert(Math.abs(scaled.entropicValueAtRisk / 1000 - base.entropicValueAtRisk) < 1e-9);
});

test('EVaR rejects malformed distributions, unsupported sizes and invalid confidence', () => {
  const valid = [{ loss: 1, probability: 1 }];
  for (const confidence of [-1, 1, NaN, Infinity, '0.5', null]) {
    assert.throws(() => evar({ outcomes: valid, confidence }), TypeError);
  }
  for (const outcomes of [[], [{ loss: 1, probability: 0.9 }],
    [{ loss: 1, probability: -1 }], [{ loss: Infinity, probability: 1 }],
    [{ loss: 1e10, probability: 1 }], [{ loss: 1, probability: 1, extra: 0 }],
    [{ loss: 0, probability: 0 }], Array.from({ length: 4097 }, () => ({ loss: 0, probability: 1 / 4097 }))]) {
    assert.throws(() => evar({ outcomes, confidence: 0.9 }), TypeError);
  }
});
