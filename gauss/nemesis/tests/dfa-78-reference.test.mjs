import test from 'node:test';
import assert from 'node:assert/strict';
import {whiteNoiseDFAReference} from '../dfa-78-reference.mjs';
import {runGaussNemesis} from '../bridge.mjs';
function sample(n, seed = 1) {
  let state = seed >>> 0;
  return Array.from({length:n}, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32 - 0.5;
  });
}
const options = {series: sample(512), scales: [8, 16, 32, 64], moments: [0, 2], replicates: 40, seed: 55};
test('reference is deterministic and returns ordered finite null quantiles for both q=0 and q=2', () => {
  const a = whiteNoiseDFAReference(options), b = whiteNoiseDFAReference(options);
  assert.deepEqual(a, b);
  assert.equal(a.curves.length, 2);
  for (const curve of a.curves) {
    assert.ok(Number.isFinite(curve.observedExponent));
    assert.ok(curve.whiteNoiseCentralInterval[0] <= curve.whiteNoiseMedian);
    assert.ok(curve.whiteNoiseMedian <= curve.whiteNoiseCentralInterval[1]);
    assert.ok(curve.fractionOfNullExponentsAtOrBelowObserved >= 0 && curve.fractionOfNullExponentsAtOrBelowObserved <= 1);
  }
  assert.match(a.limitations, /NOT a confidence interval/);
});
test('different seeds alter Monte Carlo null reference without altering observed estimate', () => {
  const first = whiteNoiseDFAReference(options), second = whiteNoiseDFAReference({...options, seed: 56});
  assert.equal(first.curves[0].observedExponent, second.curves[0].observedExponent);
  assert.notDeepEqual(first.curves[0].whiteNoiseCentralInterval, second.curves[0].whiteNoiseCentralInterval);
});
test('GAUSS exposes reference without altering original motor 78', async () => {
  const result = await runGaussNemesis('78', {action: 'white-noise-reference', payload: options});
  assert.deepEqual(result, whiteNoiseDFAReference(options));
  const original = await runGaussNemesis('78', {series: options.series, scales: options.scales});
  assert.equal(original.domain, 'DFA1');
  await assert.rejects(() => runGaussNemesis('78', {action: 'white-noise-reference', payload: options, extra: true}), /expected action and payload/);
});
test('reject invalid samples, cost budgets and unsupported inference claims', () => {
  assert.throws(() => whiteNoiseDFAReference({...options, replicates: 1}), /replicates/);
  assert.throws(() => whiteNoiseDFAReference({...options, level: 1}), /level/);
  assert.throws(() => whiteNoiseDFAReference({...options, seed: -1}), /seed/);
  assert.throws(() => whiteNoiseDFAReference({...options, bogus: 1}), /unknown field/);
  assert.throws(() => whiteNoiseDFAReference({...options, series: Array(16385).fill(1)}), /requires series/);
  assert.throws(() => whiteNoiseDFAReference({...options, series: Array(16000).fill(1), replicates: 200}), /budget/);
  assert.throws(() => whiteNoiseDFAReference({...options, series: Array(512).fill(1)}), /undefined/);
});
