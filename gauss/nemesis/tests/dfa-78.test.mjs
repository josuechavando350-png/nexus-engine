import test from 'node:test';
import assert from 'node:assert/strict';
import {multifractalDFA} from '../dfa-78.mjs';
import {runGaussNemesis} from '../bridge.mjs';
import {runMotor} from '../engine/src/index.mjs';

const scales = [8, 12, 16, 24, 32, 48, 64];
function noise(n, seed = 19) {
  let state = seed;
  const uniform = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) + 0.5) / 4294967296;
  return Array.from({length:n}, () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform()));
}

test('q=2 MF-DFA reproduces actual original #78 DFA1 fluctuations and GAUSS routes the new action', async () => {
  const series = noise(1024);
  const legacy = runMotor('78', {series, scales});
  const enhanced = await runGaussNemesis('78', {action: 'multifractal', payload: {series, scales, moments: [2]}});
  assert.equal(enhanced.domain, 'BOUNDED_MULTIFRACTAL_DFA');
  enhanced.curves[0].fluctuations.forEach(({fluctuation}, i) =>
    assert.ok(Math.abs(fluctuation - legacy.fluctuations[i].fluctuation) < 1e-10,
      `${i}: ${fluctuation} vs ${legacy.fluctuations[i].fluctuation}`));
  assert.ok(Math.abs(enhanced.curves[0].scalingExponent - legacy.scalingExponent) < 1e-10);
  const unchanged = await runGaussNemesis('78', {series, scales});
  assert.deepEqual(unchanged, legacy);
  await assert.rejects(() => runGaussNemesis('78', {action: 'multifractal', payload: {series, scales}, debug: true}), /expected action and payload/);
});

test('white noise yields near-one-half scaling; q=0 has finite geometric limit', () => {
  const result = multifractalDFA({series: noise(8192), scales: [16, 24, 32, 48, 64, 96, 128, 192, 256], moments: [-2, 0, 2, 4]});
  const h2 = result.curves.find(({q}) => q === 2).scalingExponent;
  assert.ok(h2 > 0.35 && h2 < 0.65, `white noise exponent ${h2}`);
  assert.ok(result.curves.every(({scalingExponent, rSquared}) => Number.isFinite(scalingExponent) && rSquared > 0.8));
  assert.equal(result.spectrum.length, 2);
});

test('positive affine rescaling changes fluctuations but not scaling exponents', () => {
  const series = noise(2048);
  const a = multifractalDFA({series, scales, moments: [-2, 0, 2, 4]});
  const b = multifractalDFA({series: series.map(v => 7 * v + 123), scales, moments: [-2, 0, 2, 4]});
  for (let i = 0; i < a.curves.length; i++) {
    assert.ok(Math.abs(a.curves[i].scalingExponent - b.curves[i].scalingExponent) < 1e-9);
    for (let j = 0; j < scales.length; j++)
      assert.ok(Math.abs(b.curves[i].fluctuations[j].fluctuation / a.curves[i].fluctuations[j].fluctuation - 7) < 1e-9);
  }
});

test('quadratic detrending produces finite estimates', () => {
  const result = multifractalDFA({series: noise(1024), scales, order: 2, moments: [0, 2]});
  assert.equal(result.order, 2);
  assert.ok(result.curves.every(curve => Number.isFinite(curve.scalingExponent)));
});

test('rejects undefined moments, insufficient windows, and invalid fields', () => {
  const constant = Array(128).fill(10);
  assert.throws(() => multifractalDFA({series: constant, scales: [8, 16, 32], moments: [-2]}), /zero window variance/);
  assert.equal(multifractalDFA({series: constant, scales: [8, 16, 32], moments: [2]}).curves[0].scalingExponent, null);
  assert.throws(() => multifractalDFA({series: noise(128), scales: [8, 8, 16]}), /duplicates/);
  assert.throws(() => multifractalDFA({series: noise(128), scales: [8, 16, 64]}), /four complete windows/);
  assert.throws(() => multifractalDFA({series: noise(128), scales: [8, 16, 32], moments: [2, 2]}), /duplicates/);
  assert.throws(() => multifractalDFA({series: noise(128), scales: [8, 16, 32], order: 3}), /order/);
  assert.throws(() => multifractalDFA({series: noise(128), scales: [8, 16, 32], unexpected: true}), /unknown field/);
});
