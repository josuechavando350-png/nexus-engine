import { assertArray, assertExactKeys, assertSafeInteger } from '../core/common.mjs';
import { add, asString, complement, fraction, mul, ONE, probability } from './rational.mjs';

const cmp = (a, b) => a.n * b.d - b.n * a.d;
function pair(x, label) {
  const arr = assertArray(x, label, { min: 2, max: 2 });
  if (!Object.hasOwn(arr, 0) || !Object.hasOwn(arr, 1)) throw new TypeError(`${label} must be dense`);
  const result = arr.map((p, i) => probability(p, `${label}[${i}]`));
  if (cmp(add(result[0], result[1]), ONE) !== 0n) throw new TypeError(`${label} must sum to one`);
  return result;
}
/** Exact two-state/two-symbol hidden Markov forward-backward and Viterbi. */
export function inferHiddenMarkov(input) {
  assertExactKeys(input, ['initialTrue', 'transition', 'emission', 'observations'], 'hidden Markov model');
  const p = probability(input.initialTrue, 'initialTrue');
  const initial = [complement(p), p];
  const mat = (x, name) => {
    const rows = assertArray(x, name, { min: 2, max: 2 });
    if (!Object.hasOwn(rows, 0) || !Object.hasOwn(rows, 1)) throw new TypeError(`${name} must be dense`);
    return rows.map((r, i) => pair(r, `${name}[${i}]`));
  };
  const T = mat(input.transition, 'transition'), E = mat(input.emission, 'emission');
  const obs = assertArray(input.observations, 'observations', { min: 1, max: 32 });
  for (let i = 0; i < obs.length; i++) assertSafeInteger(obs[i], `observations[${i}]`, { min: 0, max: 1 });
  const alpha = [], delta = [], backpointer = [];
  for (let t = 0; t < obs.length; t++) {
    const a = [], d = [], b = [];
    for (let state = 0; state < 2; state++) {
      if (t === 0) { a.push(mul(initial[state], E[state][obs[t]])); d.push(a[state]); b.push(null); }
      else {
        a.push(mul(add(mul(alpha[t - 1][0], T[0][state]), mul(alpha[t - 1][1], T[1][state])), E[state][obs[t]]));
        const choices = [mul(delta[t - 1][0], T[0][state]), mul(delta[t - 1][1], T[1][state])];
        const winner = cmp(choices[1], choices[0]) > 0n ? 1 : 0;
        d.push(mul(choices[winner], E[state][obs[t]])); b.push(winner);
      }
    }
    alpha.push(a); delta.push(d); backpointer.push(b);
  }
  const likelihood = add(...alpha.at(-1));
  if (likelihood.n === 0n) throw new RangeError('observation sequence has zero probability under the supplied HMM');
  const beta = Array.from({ length: obs.length }, () => [ONE, ONE]);
  for (let t = obs.length - 2; t >= 0; t--) {
    beta[t] = [0, 1].map(s => add(
      mul(T[s][0], mul(E[0][obs[t + 1]], beta[t + 1][0])),
      mul(T[s][1], mul(E[1][obs[t + 1]], beta[t + 1][1]))));
  }
  const filtered = alpha.map(a => {
    const mass = add(a[0], a[1]);
    return asString(fraction(a[1].n * mass.d, a[1].d * mass.n));
  });
  const posterior = alpha.map((a, t) => {
    const numerator = mul(a[1], beta[t][1]);
    return asString(fraction(numerator.n * likelihood.d, numerator.d * likelihood.n));
  });
  const path = Array(obs.length);
  path[obs.length - 1] = cmp(delta.at(-1)[1], delta.at(-1)[0]) > 0n ? 1 : 0;
  for (let t = obs.length - 1; t > 0; t--) path[t - 1] = backpointer[t][path[t]];
  const nextTrue = add(mul(alpha.at(-1)[0], T[0][1]), mul(alpha.at(-1)[1], T[1][1]));
  return {
    observationLikelihood: asString(likelihood), posteriorTrue: posterior.at(-1), filteredPosteriorHistoryTrue: filtered, smoothedPosteriorHistoryTrue: posterior,
    predictiveNextTrue: asString(fraction(nextTrue.n * likelihood.d, nextTrue.d * likelihood.n)),
    viterbiPath: path, viterbiJointProbability: asString(delta.at(-1)[path.at(-1)]),
    arithmetic: 'EXACT_RATIONAL', model: 'TWO_STATE_HIDDEN_MARKOV_FORWARD_BACKWARD_VITERBI',
    note: 'Probabilities are conditional on the supplied transition/emission model; no external model identification is claimed.',
  };
}
