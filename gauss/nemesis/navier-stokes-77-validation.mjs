/** Manufactured-solution convergence check for the bounded periodic #77 solver. */
import {array, integer, number, object} from './engine/src/motors/shared.mjs';
import {simulateNavierStokes3D} from './engine/src/motors/batch-71-80.mjs';

const TWO_PI = 2 * Math.PI;
const DEFAULT_RESOLUTIONS = [4, 6, 8, 10, 12];

function velocityL2Error(actual, exact) {
  let errorSquared = 0;
  let exactSquared = 0;
  for (let i = 0; i < actual.length; i++) {
    for (let j = 0; j < 3; j++) {
      const delta = actual[i][j] - exact[i][j];
      errorSquared += delta * delta;
      exactSquared += exact[i][j] * exact[i][j];
    }
  }
  return {
    l2Error: Math.sqrt(errorSquared / actual.length),
    relativeL2Error: Math.sqrt(errorSquared / exactSquared)
  };
}

function divergenceMax(velocity, n, dx) {
  const idx = (x, y, z) => ((z + n) % n * n + (y + n) % n) * n + (x + n) % n;
  const at = (x, y, z, component) => velocity[idx(x, y, z)][component];
  let maximum = 0;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const divergence =
      (at(x + 1, y, z, 0) - at(x - 1, y, z, 0) +
       at(x, y + 1, z, 1) - at(x, y - 1, z, 1) +
       at(x, y, z + 1, 2) - at(x, y, z - 1, 2)) / (2 * dx);
    maximum = Math.max(maximum, Math.abs(divergence));
  }
  return maximum;
}

function shearField(n, dx, amplitude, physicalWaveNumber) {
  const velocity = [];
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
    velocity.push([amplitude * Math.sin(physicalWaveNumber * y * dx), 0, 0]);
  return velocity;
}

/**
 * Validate #77 against u=(A sin(k y),0,0), an exact periodic incompressible
 * Navier-Stokes solution whose nonlinear advection vanishes and whose
 * amplitude decays as exp(-nu*k^2*t).
 */
export function validatePeriodicShearDecay(input = {}) {
  object(input, 'Navier-Stokes shear validation',
    ['resolutions', 'amplitude', 'viscosity', 'finalTime', 'cflSafety', 'waveNumber', 'pressureIterations'],
    []);
  const resolutions = input.resolutions === undefined
    ? DEFAULT_RESOLUTIONS
    : array(input.resolutions, 'resolutions', 2, 5).map((value, index) =>
        integer(value, `resolutions[${index}]`, 4, 12));
  if (new Set(resolutions).size !== resolutions.length)
    throw new TypeError('resolutions contains duplicates');
  if (resolutions.some((value, index) => index > 0 && value <= resolutions[index - 1]))
    throw new TypeError('resolutions must be strictly increasing');

  const amplitude = number(input.amplitude ?? 0.1, 'amplitude', 1e-9, 10);
  const viscosity = number(input.viscosity ?? 0.5, 'viscosity', 1e-8, 10);
  const finalTime = number(input.finalTime ?? 0.2, 'finalTime', 1e-6, 10);
  const cflSafety = number(input.cflSafety ?? 0.5, 'cflSafety', 0.05, 0.9);
  const waveNumber = integer(input.waveNumber ?? 1, 'waveNumber', 1, 5);
  const pressureIterations = integer(input.pressureIterations ?? 80, 'pressureIterations', 20, 5000);
  const domainLength = TWO_PI;

  const cases = resolutions.map(n => {
    if (2 * waveNumber >= n)
      throw new TypeError(`resolution ${n} cannot resolve waveNumber ${waveNumber}`);
    const dx = domainLength / n;
    const physicalWaveNumber = TWO_PI * waveNumber / domainLength;
    const initial = shearField(n, dx, amplitude, physicalWaveNumber);
    const stabilityRate = 3 * amplitude / dx + 6 * viscosity / dx ** 2;
    const steps = Math.max(1, Math.ceil(finalTime * stabilityRate / cflSafety));
    if (steps > 40)
      throw new RangeError(`resolution ${n} requires ${steps} steps; exceeds motor 77 limit 40`);
    const dt = finalTime / steps;
    const numerical = simulateNavierStokes3D({
      n, velocity: initial, viscosity, dt, dx, steps, pressureIterations
    });
    const exactAmplitude = amplitude * Math.exp(-viscosity * physicalWaveNumber ** 2 * finalTime);
    const exact = shearField(n, dx, exactAmplitude, physicalWaveNumber);
    const errors = velocityL2Error(numerical.velocity, exact);
    return {
      n, dx, dt, steps, exactAmplitude,
      ...errors,
      maxDiscreteDivergence: divergenceMax(numerical.velocity, n, dx),
      finalPressureResidual: numerical.history.at(-1).pressureResidual
    };
  });

  const observedOrders = [];
  for (let i = 1; i < cases.length; i++) {
    const coarse = cases[i - 1];
    const fine = cases[i];
    observedOrders.push(
      Math.log(coarse.relativeL2Error / fine.relativeL2Error) /
      Math.log(coarse.dx / fine.dx)
    );
  }
  const monotoneErrorDecrease = cases.every((entry, index) =>
    index === 0 || entry.relativeL2Error < cases[index - 1].relativeL2Error);

  return {
    domain: 'PERIODIC_SHEAR_MANUFACTURED_SOLUTION_VALIDATION',
    exactSolution: 'u=(A sin(k y),0,0), amplitude=A exp(-nu k^2 t)',
    resolutions,
    amplitude,
    viscosity,
    finalTime,
    waveNumber,
    cases,
    observedOrders,
    minimumObservedOrder: Math.min(...observedOrders),
    monotoneErrorDecrease,
    limitations: 'Manufactured periodic shear-flow convergence test only; it does not validate turbulent, forced, boundary-driven, or arbitrary volumetric CFD.'
  };
}
