import test from 'node:test';
import assert from 'node:assert/strict';
import {simulateFullHistoryWalk} from '../full-memory-76.mjs';
import {runGaussNemesis} from '../bridge.mjs';
import {runMotor} from '../engine/src/index.mjs';

const sample = {steps: 256, alpha: 0, memoryWeight: 0.7, seed: 42};

test('every eligible lag is used and the horizon boundary is explicit', () => {
  const complete = simulateFullHistoryWalk(sample);
  const limited = simulateFullHistoryWalk({...sample, horizon: 128});
  assert.equal(complete.maxLag, 255);
  assert.equal(complete.truncated, false);
  assert.equal(limited.maxLag, 128);
  assert.equal(limited.truncated, true);
  assert.deepEqual(complete.positions.slice(0, 130), limited.positions.slice(0, 130));
  assert.notEqual(complete.rightProbabilities[129], limited.rightProbabilities[129]);
  assert.equal(complete.positions.length, sample.steps + 1);
  assert.equal(complete.rightProbabilities.length, sample.steps);
  for (let t = 0; t < sample.steps; t++) {
    const increments = Array.from({length: t}, (_, index) =>
      complete.positions[index + 1] - complete.positions[index]);
    const history = t === 0 ? 0 : increments.reduce((sum, step) => sum + step, 0) / t;
    const expected = (1 + sample.memoryWeight * history) / 2;
    assert.ok(Math.abs(complete.rightProbabilities[t] - expected) < 1e-14, `lag ${t}`);
    assert.ok(Math.abs(complete.positions[t + 1] - complete.positions[t]) === 1);
  }
});

test('zero memory reduces to the same unbiased seeded random walk for any alpha/horizon', () => {
  const base = {steps: 256, alpha: 0, memoryWeight: 0, seed: 123};
  const complete = simulateFullHistoryWalk(base);
  const truncated = simulateFullHistoryWalk({...base, alpha: 5, horizon: 1});
  assert.deepEqual(complete.positions, truncated.positions);
  assert.ok(complete.rightProbabilities.every(p => p === 0.5));
  assert.deepEqual(simulateFullHistoryWalk(base), complete);
});

test('short full-history case respects the 128-step legacy boundary', () => {
  const input = {steps: 128, alpha: 1.3, memoryWeight: -0.65, seed: 987, initial: 5};
  const full = simulateFullHistoryWalk(input);
  const explicit = simulateFullHistoryWalk({...input, horizon: 128});
  assert.deepEqual(full.positions, explicit.positions);
  assert.equal(full.maxLag, 127);
  assert.ok(full.rightProbabilities.every(p => p >= 0 && p <= 1));
});

test('GAUSS dispatch preserves the original implementation while exposing full history', async () => {
  const input = {steps: 128, alpha: 1.3, memoryWeight: -0.65, seed: 987, initial: 5};
  const original = runMotor('76', input);
  assert.deepEqual(await runGaussNemesis('76', input), original);
  const enhanced = await runGaussNemesis('76', {action: 'full-history', payload: input});
  assert.deepEqual(enhanced, simulateFullHistoryWalk(input));
  assert.deepEqual(enhanced.positions, original.positions);
  await assert.rejects(() => runGaussNemesis('76', {action: 'full-history', payload: input, extra: true}), /expected action and payload/);
});

test('invalid input and overly expensive full-history requests fail closed', () => {
  assert.throws(() => simulateFullHistoryWalk(null), /must be an object/);
  assert.throws(() => simulateFullHistoryWalk({...sample, horizon: 0}), /horizon/);
  assert.throws(() => simulateFullHistoryWalk({...sample, horizon: 257}), /horizon/);
  assert.throws(() => simulateFullHistoryWalk({...sample, seed: -1}), /seed/);
  assert.throws(() => simulateFullHistoryWalk({...sample, memoryWeight: 1.1}), /memoryWeight/);
  assert.throws(() => simulateFullHistoryWalk({...sample, unexpected: true}), /unknown field/);
  assert.throws(() => simulateFullHistoryWalk({...sample, steps: 4096}), /work budget/);
});
