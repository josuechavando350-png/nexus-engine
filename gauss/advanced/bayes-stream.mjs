import { assertArray, assertExactKeys, assertSafeInteger } from '../core/common.mjs';
import { asString, fraction } from './rational.mjs';

const MAX_COUNT = 1_000_000_000;
function count(n, label) { return assertSafeInteger(n, label, { min: 1, max: MAX_COUNT }); }
function bit(value) { if (value !== 0 && value !== 1) throw new TypeError('observation must be 0 or 1'); return value; }
function initialize(priorAlpha, priorBeta) {
  return { alpha: count(priorAlpha, 'priorAlpha'), beta: count(priorBeta, 'priorBeta'), observations: 0 };
}
function update(state, value) {
  bit(value);
  if (state.alpha + state.beta >= MAX_COUNT) throw new RangeError('posterior count budget exceeded');
  return { alpha: state.alpha + value, beta: state.beta + 1 - value, observations: state.observations + 1 };
}
function receipt(s) {
  return Object.freeze({ alpha: s.alpha, beta: s.beta, observations: s.observations,
    predictiveTrue: asString(fraction(BigInt(s.alpha), BigInt(s.alpha + s.beta))),
    predictiveFalse: asString(fraction(BigInt(s.beta), BigInt(s.alpha + s.beta))),
    posteriorMean: asString(fraction(BigInt(s.alpha), BigInt(s.alpha + s.beta))) });
}

/** Conjugate Beta-Bernoulli assimilation; deterministic posterior after each observation. */
export function betaBernoulliBatch(input) {
  assertExactKeys(input, ['priorAlpha', 'priorBeta', 'observations'], 'Beta-Bernoulli input');
  const samples = assertArray(input.observations, 'observations', { max: 10_000 });
  let state = initialize(input.priorAlpha, input.priorBeta);
  const history = [];
  for (const sample of samples) { state = update(state, sample); history.push(receipt(state)); }
  return { ...receipt(state), history, model: 'BETA_BERNOULLI_CONJUGATE',
    note: 'Predictions are conditional on exchangeable Bernoulli observations and the supplied Beta prior.' };
}

/** Real AsyncIterable consumption: downstream may await each update and stop the source. */
export async function* betaBernoulliUpdates({ priorAlpha, priorBeta }, source, { maxObservations = 10_000 } = {}) {
  let state = initialize(priorAlpha, priorBeta);
  assertSafeInteger(maxObservations, 'maxObservations', { min: 1, max: 100_000 });
  let read = 0;
  for await (const sample of source) {
    if (read >= maxObservations) throw new RangeError('async observation budget exceeded');
    state = update(state, sample);
    read++;
    yield receipt(state);
  }
}
