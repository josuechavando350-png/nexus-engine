import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePeriodicShearDecay} from '../navier-stokes-77-validation.mjs';
import {runGaussNemesis} from '../bridge.mjs';

const options = {
  resolutions: [4, 6, 8, 10, 12],
  amplitude: 0.1,
  viscosity: 0.5,
  finalTime: 0.2,
  cflSafety: 0.5,
  waveNumber: 1,
  pressureIterations: 80
};

test('manufactured periodic shear solution converges as the grid is refined', () => {
  const result = validatePeriodicShearDecay(options);
  assert.equal(result.domain, 'PERIODIC_SHEAR_MANUFACTURED_SOLUTION_VALIDATION');
  assert.equal(result.monotoneErrorDecrease, true);
  assert.equal(result.cases.length, 5);
  assert.equal(result.observedOrders.length, 4);
  assert.ok(result.minimumObservedOrder > 1.7, `minimum observed order ${result.minimumObservedOrder}`);
  assert.ok(result.cases.at(-1).relativeL2Error < 0.002);
  for (const entry of result.cases) {
    assert.ok(Number.isFinite(entry.relativeL2Error) && entry.relativeL2Error > 0);
    assert.ok(entry.maxDiscreteDivergence < 1e-12);
    assert.ok(entry.finalPressureResidual < 1e-12);
    assert.ok(entry.steps >= 1 && entry.steps <= 40);
  }
  assert.match(result.limitations, /does not validate turbulent/);
});

test('validation is deterministic and exposed through GAUSS without replacing original #77', async () => {
  const direct = validatePeriodicShearDecay(options);
  const throughGauss = await runGaussNemesis('77', {action: 'validate-periodic-shear', payload: options});
  assert.deepEqual(throughGauss, direct);

  const originalInput = {
    n: 4,
    velocity: Array.from({length: 64}, () => [0, 0, 0]),
    viscosity: 0.1,
    dt: 0.01,
    dx: 1,
    steps: 1,
    pressureIterations: 20
  };
  const original = await runGaussNemesis('77', originalInput);
  assert.equal(original.domain, 'BOUNDED_PERIODIC_3D_NAVIER_STOKES_FINITE_DIFFERENCE');
  assert.deepEqual(original.velocity, originalInput.velocity);
});

test('invalid or unresolved convergence requests fail closed', async () => {
  assert.throws(() => validatePeriodicShearDecay({...options, resolutions: [4, 4]}), /duplicates/);
  assert.throws(() => validatePeriodicShearDecay({...options, resolutions: [8, 6]}), /strictly increasing/);
  assert.throws(() => validatePeriodicShearDecay({...options, resolutions: [4, 6], waveNumber: 2}), /cannot resolve/);
  assert.throws(() => validatePeriodicShearDecay({...options, finalTime: 10}), /exceeds motor 77 limit/);
  assert.throws(() => validatePeriodicShearDecay({...options, unexpected: true}), /unknown field/);
  await assert.rejects(
    () => runGaussNemesis('77', {action: 'validate-periodic-shear', payload: options, extra: true}),
    /expected action and payload/
  );
});
