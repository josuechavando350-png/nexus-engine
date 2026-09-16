import assert from 'node:assert/strict';
import test from 'node:test';
import { discreteConditionalValueAtRisk as cvar } from '../core/layers/risk.mjs';

// Independent Rockafellar-Uryasev discrete oracle: the convex minimum is
// attained at one of the observed loss values; no sorting/tail slicing used.
function independentOracle(outcomes, confidence) {
  return Math.min(...outcomes.map(({ loss: threshold }) => threshold + outcomes.reduce(
    (sum, { loss, probability }) => sum + probability * Math.max(0, loss - threshold), 0,
  ) / (1 - confidence)));
}

test('CVaR exactly handles a fractional boundary and ordinary VaR quantile', () => {
  const outcomes = [0, 10, 20, 30].map((loss) => ({ loss, probability: 0.25 }));
  const at75 = cvar({ outcomes, confidence: 0.75 });
  assert.equal(at75.valueAtRisk, 20);
  assert.equal(at75.conditionalValueAtRisk, 30);
  assert.equal(at75.expectedLoss, 15);
  assert.equal(cvar({ outcomes, confidence: 0.5 }).conditionalValueAtRisk, 25);
  assert.equal(cvar({ outcomes, confidence: 0 }).conditionalValueAtRisk, 15);
});

test('CVaR treats negative losses, duplicated losses and zero-probability extreme values correctly', () => {
  const outcomes = [
    { loss: -4, probability: 0.5 }, { loss: 8, probability: 0.25 },
    { loss: 8, probability: 0.25 }, { loss: 1e12, probability: 0 },
  ];
  const result = cvar({ outcomes, confidence: 0.5 });
  assert.equal(result.valueAtRisk, -4);
  assert.equal(result.conditionalValueAtRisk, 8);
  assert.equal(result.expectedLoss, 2);
  assert.equal(cvar({ outcomes: [{ loss: -3, probability: 1 }], confidence: 0.999999 }).conditionalValueAtRisk, -3);
});

test('CVaR matches a separate convex optimization oracle for 180 seeded discrete distributions', () => {
  let state = 0x719cad21;
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  for (let trial = 0; trial < 180; trial += 1) {
    const count = 2 + next() % 6;
    const weights = Array.from({ length: count }, () => 1 + next() % 9);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const outcomes = weights.map((weight) => ({ loss: (next() % 41) - 20, probability: weight / total }));
    const confidence = [0, 0.1, 0.5, 0.8, 0.95, 0.99][trial % 6];
    const actual = cvar({ outcomes, confidence }).conditionalValueAtRisk;
    const oracle = independentOracle(outcomes, confidence);
    assert(Math.abs(actual - oracle) < 2e-9, `trial=${trial} actual=${actual} oracle=${oracle}`);
  }
});

test('CVaR fails closed on invalid probabilities, confidence, losses, and unsupported shape', () => {
  const valid = [{ loss: 1, probability: 1 }];
  for (const confidence of [1, -0.1, 1.01, NaN, Infinity, '0.9']) {
    assert.throws(() => cvar({ outcomes: valid, confidence }), TypeError);
  }
  for (const outcomes of [[], [{ loss: 1, probability: 0.9 }],
    [{ loss: Infinity, probability: 1 }], [{ loss: 1e13, probability: 1 }],
    [{ loss: 1, probability: -1 }], [{ loss: 1, probability: 1, extra: true }]]) {
    assert.throws(() => cvar({ outcomes, confidence: 0.95 }), TypeError);
  }
});
