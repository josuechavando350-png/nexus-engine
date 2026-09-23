/** Finite-sample white-noise reference for MF-DFA; not a confidence interval for arbitrary processes. */
import {multifractalDFA} from './dfa-78.mjs';

const allowed = ['series', 'scales', 'moments', 'order', 'replicates', 'seed', 'level'];
function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new TypeError(`${label} must be an integer between ${min} and ${max}`);
  return value;
}
function quantile(sorted, probability) {
  const rank = probability * (sorted.length - 1);
  const low = Math.floor(rank), high = Math.ceil(rank);
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}
function generator(seed) {
  // Mulberry32: reproducible simulation, never intended for cryptographic use.
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussianNoise(count, uniform) {
  const result = new Array(count);
  for (let i = 0; i < count; i += 2) {
    const radius = Math.sqrt(-2 * Math.log(Math.max(uniform(), Number.MIN_VALUE)));
    const angle = 2 * Math.PI * uniform();
    result[i] = radius * Math.cos(angle);
    if (i + 1 < count) result[i + 1] = radius * Math.sin(angle);
  }
  return result;
}

/** Compare observed MF-DFA exponents with *conditional* iid Gaussian-white-noise simulations. */
export function whiteNoiseDFAReference(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('white-noise reference input must be an object');
  for (const key of Object.keys(input)) if (!allowed.includes(key))
    throw new TypeError(`white-noise reference unknown field ${key}`);
  const replicates = integer(input.replicates ?? 80, 'replicates', 32, 200);
  const seed = integer(input.seed ?? 78, 'seed', 0, 4294967295);
  const level = input.level ?? 0.95;
  if (typeof level !== 'number' || !Number.isFinite(level) || level < 0.5 || level > 0.99)
    throw new TypeError('level must be a finite number between 0.5 and 0.99');
  if (!Array.isArray(input.series) || input.series.length > 16384 ||
      !Array.isArray(input.scales) || input.scales.length > 12 ||
      (input.moments !== undefined && (!Array.isArray(input.moments) || input.moments.length > 5)))
    throw new TypeError('white-noise reference requires series <= 16384, scales <= 12, moments <= 5');
  if (input.series.length * replicates > 2000000)
    throw new TypeError('white-noise reference simulation budget exceeded');
  const options = {series: input.series, scales: input.scales};
  if (input.moments !== undefined) options.moments = input.moments;
  if (input.order !== undefined) options.order = input.order;
  if (options.moments === undefined) options.moments = [2];
  const observed = multifractalDFA(options);
  if (observed.curves.some(curve => !Number.isFinite(curve.scalingExponent)))
    throw new RangeError('observed scaling exponent undefined; reference cannot be computed');
  const uniform = generator(seed);
  const samples = observed.curves.map(() => []);
  for (let index = 0; index < replicates; index++) {
    const nullResult = multifractalDFA({...options, series: gaussianNoise(observed.sampleCount, uniform)});
    nullResult.curves.forEach((curve, qIndex) => {
      if (!Number.isFinite(curve.scalingExponent))
        throw new RangeError('simulated white-noise exponent undefined');
      samples[qIndex].push(curve.scalingExponent);
    });
  }
  const lower = (1 - level) / 2;
  return {
    domain: 'FINITE_SAMPLE_GAUSSIAN_WHITE_NOISE_REFERENCE',
    sampleCount: observed.sampleCount, replicates, seed, level, order: observed.order,
    curves: observed.curves.map((curve, i) => {
      const sorted = samples[i].sort((a, b) => a - b);
      return {q: curve.q, observedExponent: curve.scalingExponent,
        whiteNoiseMedian: quantile(sorted, 0.5),
        whiteNoiseCentralInterval: [quantile(sorted, lower), quantile(sorted, 1 - lower)],
        fractionOfNullExponentsAtOrBelowObserved:
          sorted.filter(value => value <= curve.scalingExponent).length / replicates};
    }),
    limitations: 'Monte Carlo reference conditional on independent Gaussian samples and a seeded pseudorandom generator; NOT a confidence interval or bias correction for the observed process, and not evidence of causality or multifractality.'
  };
}
