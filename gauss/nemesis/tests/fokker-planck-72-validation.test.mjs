import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePeriodicFokkerPlanckDiffusion} from '../fokker-planck-72-validation.mjs';
import {runGaussNemesis} from '../bridge.mjs';

const options = {
  resolutions: [32, 48, 64, 96, 128],
  amplitude: 0.4,
  diffusion: 0.2,
  finalTime: 0.2,
  cflSafety: 0.8,
  waveNumber: 1
};

test('periodic diffusion benchmark converges while preserving mass and positivity', () => {
  const result = validatePeriodicFokkerPlanckDiffusion(options);
  assert.equal(result.domain, 'PERIODIC_FOKKER_PLANCK_DIFFUSION_MANUFACTURED_VALIDATION');
  assert.equal(result.monotoneErrorDecrease, true);
  assert.equal(result.cases.length, 5);
  assert.ok(result.minimumObservedOrder > 1.3, `minimum observed order ${result.minimumObservedOrder}`);
  assert.ok(result.cases.at(-1).perturbationRelativeL2Error < 2e-5);
  for (const entry of result.cases) {
    assert.ok(entry.minimumDensity > 0);
    assert.ok(Math.abs(entry.finalMass - 1) < 1e-12);
    assert.ok(entry.maxMassDrift < 1e-12);
    assert.ok(entry.steps >= 1 && entry.steps <= 10000);
  }
});

test('GAUSS exposes validation and retains the original motor #72 path', async () => {
  const direct = validatePeriodicFokkerPlanckDiffusion(options);
  const throughGauss = await runGaussNemesis('72', {action: 'validate-periodic-diffusion', payload: options});
  assert.deepEqual(throughGauss, direct);

  const density = Array(8).fill(1 / 8);
  const original = await runGaussNemesis('72', {
    density,
    drift: Array(8).fill(0),
    diffusion: 0.1,
    dx: 1,
    dt: 0.01,
    steps: 1
  });
  assert.equal(original.domain, 'PERIODIC_FINITE_VOLUME_FOKKER_PLANCK');
  assert.deepEqual(original.density, density);
});

test('invalid convergence requests fail closed', async () => {
  assert.throws(() => validatePeriodicFokkerPlanckDiffusion({...options, resolutions: [32, 32]}), /duplicates/);
  assert.throws(() => validatePeriodicFokkerPlanckDiffusion({...options, resolutions: [64, 32]}), /strictly increasing/);
  assert.throws(() => validatePeriodicFokkerPlanckDiffusion({...options, resolutions: [8, 16], waveNumber: 4}), /cannot resolve/);
  assert.throws(() => validatePeriodicFokkerPlanckDiffusion({...options, amplitude: 1}), /amplitude/);
  assert.throws(() => validatePeriodicFokkerPlanckDiffusion({...options, unexpected: true}), /unknown field/);
  await assert.rejects(
    () => runGaussNemesis('72', {action: 'validate-periodic-diffusion', payload: options, extra: true}),
    /expected action and payload/
  );
});
