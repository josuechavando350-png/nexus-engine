/** Manufactured periodic diffusion convergence check for bounded Fokker-Planck motor #72. */
import {array, integer, number, object} from './engine/src/motors/shared.mjs';
import {evolveFokkerPlanck} from './engine/src/motors/batch-71-80.mjs';

const TWO_PI = 2 * Math.PI;
const DEFAULT_RESOLUTIONS = [32, 48, 64, 96, 128];

function densityField(n, dx, amplitude, physicalWaveNumber) {
  const normalization = TWO_PI;
  return Array.from({length: n}, (_, i) =>
    (1 + amplitude * Math.cos(physicalWaveNumber * i * dx)) / normalization);
}

function perturbationRelativeError(actual, exact) {
  const equilibrium = 1 / TWO_PI;
  let errorSquared = 0;
  let perturbationSquared = 0;
  for (let i = 0; i < actual.length; i++) {
    const delta = actual[i] - exact[i];
    errorSquared += delta * delta;
    const perturbation = exact[i] - equilibrium;
    perturbationSquared += perturbation * perturbation;
  }
  return {
    l2Error: Math.sqrt(errorSquared / actual.length),
    perturbationRelativeL2Error: Math.sqrt(errorSquared / perturbationSquared)
  };
}

/**
 * Validate #72 against periodic pure diffusion:
 * p(x,t)=[1+A exp(-D k^2 t) cos(kx)]/(2*pi), drift=0.
 */
export function validatePeriodicFokkerPlanckDiffusion(input = {}) {
  object(input, 'Fokker-Planck periodic diffusion validation',
    ['resolutions', 'amplitude', 'diffusion', 'finalTime', 'cflSafety', 'waveNumber'], []);
  const resolutions = input.resolutions === undefined
    ? DEFAULT_RESOLUTIONS
    : array(input.resolutions, 'resolutions', 2, 5).map((value, index) =>
        integer(value, `resolutions[${index}]`, 8, 256));
  if (new Set(resolutions).size !== resolutions.length)
    throw new TypeError('resolutions contains duplicates');
  if (resolutions.some((value, index) => index > 0 && value <= resolutions[index - 1]))
    throw new TypeError('resolutions must be strictly increasing');

  const amplitude = number(input.amplitude ?? 0.4, 'amplitude', 1e-6, 0.95);
  const diffusion = number(input.diffusion ?? 0.2, 'diffusion', 1e-8, 10);
  const finalTime = number(input.finalTime ?? 0.2, 'finalTime', 1e-6, 10);
  const cflSafety = number(input.cflSafety ?? 0.8, 'cflSafety', 0.05, 0.95);
  const waveNumber = integer(input.waveNumber ?? 1, 'waveNumber', 1, 16);

  const cases = resolutions.map(n => {
    if (2 * waveNumber >= n)
      throw new TypeError(`resolution ${n} cannot resolve waveNumber ${waveNumber}`);
    const dx = TWO_PI / n;
    const physicalWaveNumber = waveNumber;
    const initial = densityField(n, dx, amplitude, physicalWaveNumber);
    const stabilityRate = 2 * diffusion / dx ** 2;
    const steps = Math.max(1, Math.ceil(finalTime * stabilityRate / cflSafety));
    if (steps > 10000)
      throw new RangeError(`resolution ${n} requires ${steps} steps; exceeds motor 72 limit 10000`);
    const dt = finalTime / steps;
    const numerical = evolveFokkerPlanck({
      density: initial,
      drift: Array(n).fill(0),
      diffusion,
      dx,
      dt,
      steps
    });
    const exactAmplitude = amplitude * Math.exp(-diffusion * physicalWaveNumber ** 2 * finalTime);
    const exact = densityField(n, dx, exactAmplitude, physicalWaveNumber);
    const errors = perturbationRelativeError(numerical.density, exact);
    return {
      n, dx, dt, steps, exactAmplitude,
      ...errors,
      finalMass: numerical.finalMass,
      maxMassDrift: numerical.maxMassDrift,
      minimumDensity: Math.min(...numerical.density)
    };
  });

  const observedOrders = [];
  for (let i = 1; i < cases.length; i++) {
    const coarse = cases[i - 1];
    const fine = cases[i];
    observedOrders.push(
      Math.log(coarse.perturbationRelativeL2Error / fine.perturbationRelativeL2Error) /
      Math.log(coarse.dx / fine.dx)
    );
  }

  return {
    domain: 'PERIODIC_FOKKER_PLANCK_DIFFUSION_MANUFACTURED_VALIDATION',
    exactSolution: 'p=(1+A exp(-D k^2 t) cos(kx))/(2*pi), drift=0',
    resolutions,
    amplitude,
    diffusion,
    finalTime,
    waveNumber,
    cases,
    observedOrders,
    minimumObservedOrder: Math.min(...observedOrders),
    monotoneErrorDecrease: cases.every((entry, index) =>
      index === 0 || entry.perturbationRelativeL2Error < cases[index - 1].perturbationRelativeL2Error),
    limitations: 'Smooth one-dimensional periodic pure-diffusion benchmark only; it does not validate nonlinear, multidimensional, nonperiodic, or data-driven Fokker-Planck models.'
  };
}
