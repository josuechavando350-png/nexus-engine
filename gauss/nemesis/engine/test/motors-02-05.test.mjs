import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { inferBinaryCausal, solveBimatrixGame, simulateQAOAMaxCut, analyzeHiddenMarkov, MOTOR_REGISTRY, runMotor } from '../src/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const causal = () => ({
  nodes: [
    { id: 'Y', parents: ['Z'], probabilityTrue: { '0': '0', '1': '1' } },
    { id: 'X', parents: ['Z'], probabilityTrue: { '0': '1/4', '1': '3/4' } },
    { id: 'Z', parents: [], probabilityTrue: { '': '1/2' } },
  ], treatment: 'X', outcome: 'Y',
});
const game = () => ({ rowPayoffs: [['1', '-1'], ['-1', '1']], columnPayoffs: [['-1', '1'], ['1', '-1']] });
const qaoa = () => ({ vertices: 2, edges: [{ u: 0, v: 1, weight: 1 }], gammas: [Math.PI / 4], betas: [Math.PI / 8] });
const hmm = () => ({ states: ['S', 'T'], alphabet: ['A', 'B'], initial: [0.6, 0.4],
  transition: [[0.7, 0.3], [0.4, 0.6]], emission: [[0.5, 0.5], [0.1, 0.9]], observations: ['A', 'B', 'A'] });
const close = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} differs from ${expected}`);

test('registry retains original four functions and rejects genuinely missing engines', () => {
  assert.deepEqual(Object.keys(MOTOR_REGISTRY).filter(k => ['02', '03', '04', '05'].includes(k)).sort(), ['02', '03', '04', '05']);
  assert.equal(runMotor('02', causal()).interventional.effectDifference, '0/1');
  assert.throws(() => runMotor('101', {}), /not implemented/);
  assert.throws(() => runMotor('__proto__', {}), /not implemented/);
});

test('02: observational association differs from causal intervention under confounding', () => {
  const result = inferBinaryCausal(causal());
  assert.deepEqual(result.observational.outcomeGivenTreatment, ['1/4', '3/4']);
  assert.deepEqual(result.interventional.outcomeGivenDo, ['1/2', '1/2']);
  assert.equal(result.interventional.effectDifference, '0/1');
  assert.equal(result.assignmentsEvaluated, 24);
  assert.deepEqual(result.topologicalOrder, ['Z', 'X', 'Y']);
});

test('02: node input order does not change result; direct causal effect is exact', () => {
  const input = causal();
  input.nodes.reverse();
  assert.deepEqual(inferBinaryCausal(input).interventional, inferBinaryCausal(causal()).interventional);
  const direct = { nodes: [
    { id: 'Y', parents: ['X'], probabilityTrue: { '0': '1/5', '1': '4/5' } },
    { id: 'X', parents: [], probabilityTrue: { '': '1/2' } },
  ], treatment: 'X', outcome: 'Y' };
  const out = inferBinaryCausal(direct);
  assert.deepEqual(out.observational.outcomeGivenTreatment, ['1/5', '4/5']);
  assert.deepEqual(out.interventional.outcomeGivenDo, ['1/5', '4/5']);
  assert.equal(out.interventional.effectDifference, '3/5');
});

test('02: conditional probability with zero treatment mass is explicitly null', () => {
  const input = causal();
  input.nodes.find(n => n.id === 'X').probabilityTrue = { '0': '0', '1': '0' };
  const output = inferBinaryCausal(input);
  assert.deepEqual(output.observational.outcomeGivenTreatment, ['1/2', null]);
  assert.deepEqual(output.interventional.outcomeGivenDo, ['1/2', '1/2']);
});

test('02: invalid DAGs, CPTs, identities and untrusted keys fail closed', () => {
  const invalid = mutation => { const input = causal(); mutation(input); assert.throws(() => inferBinaryCausal(input)); };
  invalid(x => { x.nodes[0].parents = ['X']; x.nodes[1].parents = ['Y']; });
  invalid(x => { x.nodes[0].probabilityTrue['0'] = '9/8'; });
  invalid(x => { delete x.nodes[1].probabilityTrue['1']; });
  invalid(x => { x.nodes[0].parents = ['UNKNOWN']; });
  invalid(x => { x.nodes[0].id = 'X'; });
  invalid(x => { x.nodes[0].probabilityTrue['0'] = '1/0'; });
  invalid(x => { x.nodes[0].probabilityTrue['0'] = '1/99999999999'; });
  invalid(x => { x.nodes[0].probabilityTrue['bad'] = '1/2'; });
  invalid(x => { x.treatment = 'Y'; });
});

test('03: matching pennies has no pure Nash; exact unique interior mixed Nash', () => {
  const out = solveBimatrixGame(game());
  assert.deepEqual(out.pureEquilibria, []);
  assert.deepEqual(out.interiorMixed, { rowStrategy: ['1/2', '1/2'], columnStrategy: ['1/2', '1/2'], rowPayoff: '0/1', columnPayoff: '0/1' });
});

test('03: prisoners dilemma has unique pure equilibrium and no interior mixture', () => {
  const out = solveBimatrixGame({ rowPayoffs: [['3', '0'], ['5', '1']], columnPayoffs: [['3', '5'], ['0', '1']] });
  assert.deepEqual(out.pureEquilibria, [{ row: 1, column: 1, rowPayoff: '1/1', columnPayoff: '1/1' }]);
  assert.equal(out.interiorMixed, null);
});

test('03: general 2x3 pure equilibria exhaustively enumerated; mixed scope explicitly bounded', () => {
  const out = solveBimatrixGame({ rowPayoffs: [['1', '2', '3'], ['0', '0', '0']], columnPayoffs: [['0', '0', '5'], ['1', '1', '1']] });
  assert.deepEqual(out.pureEquilibria.map(e => [e.row, e.column]), [[0, 2]]);
  assert.equal(out.mixedScope, 'NOT_COMPUTED_FOR_GENERAL_GAME');
});

test('03: degenerate coordination includes all pure strategies but does not claim to enumerate mixed continuum', () => {
  const out = solveBimatrixGame({ rowPayoffs: [['0', '0'], ['0', '0']], columnPayoffs: [['0', '0'], ['0', '0']] });
  assert.equal(out.pureEquilibria.length, 4);
  assert.equal(out.interiorMixed, null);
  assert.match(out.mixedScope, /DEGENERATE/);
});

test('03: strict shape, rational denominator and payoff validation', () => {
  assert.throws(() => solveBimatrixGame({ rowPayoffs: [['1', '2'], ['3', '4']], columnPayoffs: [['1', '2']] }));
  assert.throws(() => solveBimatrixGame({ rowPayoffs: [['1', '2'], ['3', '4']], columnPayoffs: [['1', '2'], ['3', 'nan']] }));
  assert.throws(() => solveBimatrixGame({ rowPayoffs: [['1', '2'], ['3', '4/0']], columnPayoffs: [['1', '2'], ['3', '4']] }));
});

test('04: zero cost angle retains uniform superposition and analytical mean cut', () => {
  const input = { ...qaoa(), vertices: 3, edges: [{ u: 0, v: 1, weight: 2 }, { u: 1, v: 2, weight: 3 }], gammas: [0], betas: [0.37] };
  const out = simulateQAOAMaxCut(input);
  close(out.expectedCut, 2.5);
  close(out.normalization, 1);
  assert.equal(out.maxCutByExhaustiveClassicalSearch, 5);
  for (const item of out.distribution) close(item.probability, 1 / 8);
});

test('04: statevector QAOA reproduces independent two-qubit explicit complex matrix calculation', () => {
  const input = qaoa(), out = simulateQAOAMaxCut(input);
  const gamma = input.gammas[0], beta = input.betas[0];
  const phase = c => [Math.cos(gamma * c) / 2, -Math.sin(gamma * c) / 2];
  let amplitudes = [phase(0), phase(1), phase(1), phase(0)];
  const cmul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
  const sum = (a, b) => [a[0] + b[0], a[1] + b[1]];
  for (let bit = 0; bit < 2; bit++) {
    const matrix = [Math.cos(beta), 0], offDiagonal = [0, -Math.sin(beta)];
    amplitudes = amplitudes.map((a, z, previous) => sum(cmul(matrix, a), cmul(offDiagonal, previous[z ^ (1 << bit)])));
  }
  const reference = amplitudes.map(([re, im]) => re ** 2 + im ** 2);
  for (const entry of out.distribution) close(entry.probability, reference[parseInt(entry.bitstring, 2)]);
  close(out.expectedCut, reference[1] + reference[2]);
  assert.ok(Math.abs(out.expectedCut - 0.5) > 0.1, 'nontrivial interference must change expectation');
});

test('04: multi-layer, weighted graph and deterministic replay', () => {
  const input = { vertices: 4, edges: [{ u: 0, v: 1, weight: 3 }, { u: 1, v: 2, weight: 4 }, { u: 2, v: 3, weight: 5 }], gammas: [0.3, 1.1], betas: [0.4, -0.2] };
  const out = simulateQAOAMaxCut(input);
  assert.deepEqual(out, simulateQAOAMaxCut(input));
  close(out.normalization, 1);
  assert.equal(out.maxCutByExhaustiveClassicalSearch, 12);
  assert.equal(out.distribution.length, 16);
});

test('04: malformed edges, bounds, and NaN angles are rejected', () => {
  const bad = mutation => { const input = qaoa(); mutation(input); assert.throws(() => simulateQAOAMaxCut(input)); };
  bad(x => { x.edges.push({ u: 1, v: 0, weight: 1 }); });
  bad(x => { x.edges[0].v = 0; });
  bad(x => { x.edges[0].weight = -1; });
  bad(x => { x.vertices = 9; });
  bad(x => { x.gammas[0] = NaN; });
  bad(x => { x.betas = []; });
});

test('05: scaled HMM forward probability and Viterbi match independent complete path enumeration', () => {
  const input = hmm(), out = analyzeHiddenMarkov(input);
  const T = input.observations.length;
  let total = 0, best = -1, bestPath;
  for (let mask = 0; mask < 2 ** T; mask++) {
    const path = Array.from({ length: T }, (_, t) => (mask >> t) & 1);
    let p = input.initial[path[0]] * input.emission[path[0]][input.alphabet.indexOf(input.observations[0])];
    for (let t = 1; t < T; t++) p *= input.transition[path[t - 1]][path[t]] * input.emission[path[t]][input.alphabet.indexOf(input.observations[t])];
    total += p;
    if (p > best) { best = p; bestPath = path.map(i => input.states[i]); }
  }
  close(Math.exp(out.logLikelihood), total);
  close(Math.exp(out.viterbi.logJointProbability), best);
  assert.deepEqual(out.viterbi.hiddenStates, bestPath);
  close(Object.values(out.posteriorLastState).reduce((a, b) => a + b, 0), 1);
});

test('05: Baum-Welch fits one-state categorical emissions and tracks likelihood', () => {
  const input = { states: ['S'], alphabet: ['A', 'B'], initial: [1], transition: [[1]], emission: [[0.5, 0.5]], observations: ['A', 'A', 'B'], iterations: 10 };
  const out = analyzeHiddenMarkov(input);
  close(out.fittedParameters.emission[0][0], 2 / 3);
  close(out.fittedParameters.emission[0][1], 1 / 3);
  assert.ok(out.logLikelihood > 3 * Math.log(0.5));
  for (let i = 1; i < out.likelihoodHistory.length; i++) assert.ok(out.likelihoodHistory[i] >= out.likelihoodHistory[i - 1] - 1e-8);
  assert.ok(out.fitIterations >= 1 && out.fitIterations <= 10);
});

test('05: Shannon entropy of fair observation is one bit and deterministic is zero', () => {
  const input = { states: ['S'], alphabet: ['A', 'B'], initial: [1], transition: [[1]], emission: [[0.5, 0.5]], observations: ['A', 'B'] };
  close(analyzeHiddenMarkov(input).nextObservationEntropyBits, 1);
  input.emission = [[1, 0]];
  input.observations = ['A', 'A'];
  close(analyzeHiddenMarkov(input).nextObservationEntropyBits, 0);
});

test('05: invalid stochastic rows, unseen symbols, impossible observations and over-budget fits fail closed', () => {
  const bad = mutation => { const input = hmm(); mutation(input); assert.throws(() => analyzeHiddenMarkov(input)); };
  bad(x => { x.initial = [0.5, 0.4]; });
  bad(x => { x.transition[0] = [1, 1]; });
  bad(x => { x.emission[0][0] = -1; });
  bad(x => { x.observations[0] = 'C'; });
  bad(x => { x.iterations = 31; });
  bad(x => { x.states = ['S', 'S']; });
  bad(x => { x.initial = [1, 0]; x.transition = [[1, 0], [1, 0]]; x.emission = [[1, 0], [1, 0]]; x.observations = ['B', 'B']; });
});

test('CLI runs a bounded mathematical motor and exits nonzero for unavailable engine', () => {
  const spec = resolve(root, 'examples', 'causal-confounding.json');
  const ok = spawnSync(process.execPath, ['cli.mjs', 'motor', spec, '02'], { cwd: root, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).interventional.effectDifference, '0/1');
  const missing = spawnSync(process.execPath, ['cli.mjs', 'motor', spec, '101'], { cwd: root, encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /not implemented/);
});
