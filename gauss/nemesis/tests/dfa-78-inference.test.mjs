import test from 'node:test';
import assert from 'node:assert/strict';
import {whiteNoiseDFAReference} from '../dfa-78-reference.mjs';

// Independent LCG and Box-Muller implementation, not the engine's sampler.
function gaussian(count, seed) {
  let state = seed >>> 0;
  const uniform = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state + 0.5) / 4294967296;
  };
  const result = [];
  while (result.length < count) {
    const radius = Math.sqrt(-2 * Math.log(uniform()));
    const angle = 2 * Math.PI * uniform();
    result.push(radius * Math.cos(angle));
    if (result.length < count) result.push(radius * Math.sin(angle));
  }
  return result;
}

const options = {scales: [8, 16, 32, 64], moments: [-2, 0, 2], replicates: 40, seed: 55};

test('rank p-values include the observed statistic, do not report zero, and adjust for all q', () => {
  const result = whiteNoiseDFAReference({...options, series: gaussian(512, 77)});
  assert.equal(result.nullHypothesis, 'IID_GAUSSIAN_WHITE_NOISE');
  assert.equal(result.monteCarloResolution, 1 / 41);
  for (const curve of result.curves) {
    const {lowerTailMonteCarloPValue: lower, upperTailMonteCarloPValue: upper,
      twoSidedMonteCarloPValue: two, bonferroniAdjustedPValue: adjusted} = curve;
    assert.ok(lower >= 1 / 41 && lower <= 1);
    assert.ok(upper >= 1 / 41 && upper <= 1);
    assert.equal(two, Math.min(1, 2 * Math.min(lower, upper)));
    assert.equal(adjusted, Math.min(1, result.curves.length * two));
    assert.ok(adjusted >= two);
    assert.equal(lower, (1 + curve.fractionOfNullExponentsAtOrBelowObserved * result.replicates) / (result.replicates + 1));
  }
  assert.match(result.limitations, /NOT a confidence interval/);
});

test('seeded null ranks are reproducible and invariant to positive affine rescaling', () => {
  const series = gaussian(512, 77);
  const a = whiteNoiseDFAReference({...options, series});
  assert.deepEqual(whiteNoiseDFAReference({...options, series}), a);
  const b = whiteNoiseDFAReference({...options, series: series.map(value => 7 * value + 123)});
  assert.deepEqual(a.curves.map(curve => curve.twoSidedMonteCarloPValue),
    b.curves.map(curve => curve.twoSidedMonteCarloPValue));
});

test('synthetic linear trend is distinguishable from the iid Gaussian null for q=2', () => {
  const series = gaussian(512, 77).map((value, index) => value + 0.03 * index);
  const result = whiteNoiseDFAReference({...options, moments: [2], series});
  assert.ok(result.curves[0].observedExponent > 0.8);
  assert.ok(result.curves[0].twoSidedMonteCarloPValue <= 0.05);
  assert.ok(result.curves[0].twoSidedMonteCarloPValue >= 2 / (result.replicates + 1));
});

test('iid Gaussian synthetic control does not routinely reject under fixed seeds (smoke only)', () => {
  let rejected = 0;
  for (let trial = 0; trial < 24; trial++) {
    const result = whiteNoiseDFAReference({...options, moments: [2], series: gaussian(256, 500 + trial)});
    if (result.curves[0].twoSidedMonteCarloPValue <= 0.05) rejected++;
  }
  assert.ok(rejected <= 5, `observed ${rejected} / 24 rejections`);
});
