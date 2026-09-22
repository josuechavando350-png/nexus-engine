import { object, array, id, unique, integer, number } from './shared.mjs';

const EPS = 1e-10;
function distribution(values, name, size) {
  const probs = array(values, name, size, size).map((p, i) => number(p, `${name}[${i}]`, 0, 1));
  if (Math.abs(probs.reduce((a, b) => a + b, 0) - 1) > EPS) throw new TypeError(`${name} probabilities must sum to 1`);
  return probs;
}
const entropy = row => -row.reduce((total, p) => total + (p === 0 ? 0 : p * Math.log2(p)), 0);
function forward(model, observations) {
  const { initial, transition, emission } = model, N = initial.length, T = observations.length;
  const alpha = new Array(T), scales = new Array(T);
  for (let t = 0; t < T; t++) {
    alpha[t] = Array.from({ length: N }, (_, i) => {
      const from = t ? alpha[t - 1].reduce((total, x, j) => total + x * transition[j][i], 0) : initial[i];
      return from * emission[i][observations[t]];
    });
    const mass = alpha[t].reduce((a, b) => a + b, 0);
    if (!(mass > 0) || !Number.isFinite(mass)) throw new RangeError(`observation sequence has zero likelihood at t=${t}`);
    scales[t] = mass;
    alpha[t] = alpha[t].map(x => x / mass);
  }
  return { alpha, scales, logLikelihood: scales.reduce((sum, x) => sum + Math.log(x), 0) };
}
function expectationMaximization(model, observations, { alpha, scales }) {
  const N = model.initial.length, K = model.emission[0].length, T = observations.length;
  const beta = Array.from({ length: T }, () => Array(N).fill(1));
  for (let t = T - 2; t >= 0; t--) for (let i = 0; i < N; i++) {
    beta[t][i] = model.transition[i].reduce((sum, aij, j) => sum + aij * model.emission[j][observations[t + 1]] * beta[t + 1][j], 0) / scales[t + 1];
  }
  const gamma = alpha.map((row, t) => {
    const unnormalized = row.map((a, i) => a * beta[t][i]);
    const total = unnormalized.reduce((a, b) => a + b, 0);
    if (!(total > 0)) throw new RangeError('zero posterior normalization');
    return unnormalized.map(p => p / total);
  });
  const transitions = Array.from({ length: N }, () => Array(N).fill(0));
  const transitionsDen = Array(N).fill(0);
  const emission = Array.from({ length: N }, () => Array(K).fill(0));
  const emissionDen = Array(N).fill(0);
  for (let t = 0; t < T; t++) for (let i = 0; i < N; i++) {
    emission[i][observations[t]] += gamma[t][i];
    emissionDen[i] += gamma[t][i];
    if (t === T - 1) continue;
    transitionsDen[i] += gamma[t][i];
    for (let j = 0; j < N; j++) transitions[i][j] +=
      alpha[t][i] * model.transition[i][j] * model.emission[j][observations[t + 1]] * beta[t + 1][j] / scales[t + 1];
  }
  return {
    initial: gamma[0],
    transition: transitions.map((row, i) => transitionsDen[i] > 1e-15 ? row.map(x => x / transitionsDen[i]) : [...model.transition[i]]),
    emission: emission.map((row, i) => emissionDen[i] > 1e-15 ? row.map(x => x / emissionDen[i]) : [...model.emission[i]]),
  };
}
function decodeViterbi(model, observations) {
  const N = model.initial.length, T = observations.length;
  const logs = model.initial.map((p, i) => Math.log(p) + Math.log(model.emission[i][observations[0]]));
  const parents = [];
  for (let t = 1; t < T; t++) {
    const previous = [...logs], back = [];
    for (let j = 0; j < N; j++) {
      let best = -Infinity, parent = 0;
      for (let i = 0; i < N; i++) {
        const score = previous[i] + Math.log(model.transition[i][j]);
        if (score > best) { best = score; parent = i; }
      }
      logs[j] = best + Math.log(model.emission[j][observations[t]]);
      back[j] = parent;
    }
    parents.push(back);
  }
  const best = logs.reduce((i, x, j) => x > logs[i] ? j : i, 0);
  const path = [best];
  for (let t = T - 2; t >= 0; t--) path.unshift(parents[t][path[0]]);
  return { hiddenStates: path, logJointProbability: logs[best] };
}
/** Forward-backward, Viterbi, Shannon entropy, and bounded Baum-Welch parameter learning. */
export function analyzeHiddenMarkov(input) {
  object(input, 'HMM input', ['states', 'alphabet', 'initial', 'transition', 'emission', 'observations', 'iterations'], ['states', 'alphabet', 'initial', 'transition', 'emission', 'observations']);
  const states = unique(array(input.states, 'states', 1, 6).map(x => id(x, 'state')), 'states');
  const alphabet = unique(array(input.alphabet, 'alphabet', 1, 12).map(x => id(x, 'symbol')), 'alphabet');
  const N = states.length, K = alphabet.length;
  let model = {
    initial: distribution(input.initial, 'initial', N),
    transition: array(input.transition, 'transition', N, N).map((row, i) => distribution(row, `transition[${i}]`, N)),
    emission: array(input.emission, 'emission', N, N).map((row, i) => distribution(row, `emission[${i}]`, K)),
  };
  const obs = array(input.observations, 'observations', 2, 512).map((symbol, i) => {
    const index = alphabet.indexOf(symbol);
    if (index < 0) throw new TypeError(`observations[${i}] unknown symbol`);
    return index;
  });
  const iterations = input.iterations === undefined ? 0 : integer(input.iterations, 'iterations', 0, 30);
  let inference = forward(model, obs);
  const likelihoodHistory = [inference.logLikelihood];
  for (let i = 0; i < iterations; i++) {
    const candidate = expectationMaximization(model, obs, inference);
    const next = forward(candidate, obs);
    if (next.logLikelihood + 1e-8 < inference.logLikelihood) throw new Error('Baum-Welch likelihood unexpectedly decreased');
    model = candidate;
    likelihoodHistory.push(next.logLikelihood);
    const improvement = next.logLikelihood - inference.logLikelihood;
    inference = next;
    if (improvement < 1e-9) break;
  }
  const viterbi = decodeViterbi(model, obs);
  const finalBelief = inference.alpha.at(-1);
  const nextState = model.initial.map((_, j) => finalBelief.reduce((total, value, i) => total + value * model.transition[i][j], 0));
  const nextObservation = alphabet.map((_, k) => nextState.reduce((total, value, i) => total + value * model.emission[i][k], 0));
  return { engine: 'NEMESIS_SHANNON_HIDDEN_MARKOV_V1', states, alphabet, observations: input.observations,
    logLikelihood: inference.logLikelihood, likelihoodHistory, fitIterations: likelihoodHistory.length - 1,
    initialEntropyBits: entropy(model.initial), nextObservationEntropyBits: entropy(nextObservation),
    posteriorLastState: Object.fromEntries(states.map((s, i) => [s, finalBelief[i]])),
    predictedNextObservation: Object.fromEntries(alphabet.map((s, i) => [s, nextObservation[i]])),
    viterbi: { hiddenStates: viterbi.hiddenStates.map(i => states[i]), logJointProbability: viterbi.logJointProbability },
    fittedParameters: model, assumptions: ['Hidden-state count and alphabet supplied by user', 'First-order stationary HMM', 'Baum-Welch finds local optima, not unique underlying structure'],
  };
}
