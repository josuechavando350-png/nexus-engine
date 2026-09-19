import assert from 'node:assert/strict';
import test from 'node:test';
import { solvePureStackelberg } from '../advanced/stackelberg.mjs';
import { optimizeRobustScenarios } from '../advanced/robust-scenarios.mjs';
import { queryTemporalGraph } from '../advanced/temporal-graph.mjs';
import { solveDiscountedMdp } from '../advanced/discounted-mdp.mjs';
import { certifyFiniteErgodicity } from '../advanced/ergodic-chain.mjs';
import { estimateBinaryTransferEntropy } from '../advanced/transfer-entropy.mjs';
import { executeGaussAdvancedProblem, GAUSS_ADVANCED_OPERATORS } from '../advanced/index.mjs';
import { readFileSync } from 'node:fs';

const number = (x) => { const [a, b] = x.split('/').map(Number); return a / b; };
const near = (a, b, eps = 1e-10) => assert(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);
const rng = (seed = 12345) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);

const mdp = { states: ['s0', 's1'], actions: ['stay', 'jump'],
  transition: [[['1/1', '0/1'], ['0/1', '1/1']], [['0/1', '1/1'], ['1/1', '0/1']]],
  rewards: [[0, 2], [1, 0]], discount: '1/2', initialDistribution: ['1/2', '1/2'] };

test('pure Stackelberg enforces exact follower best responses and both tie policies', () => {
  const x = { leaderPayoffs: [[6, 1], [3, 4]], followerPayoffs: [[2, 2], [3, 3]], tiePolicy: 'OPTIMISTIC' };
  const optimistic = solvePureStackelberg(x);
  assert.equal(optimistic.leaderValue, 6);
  assert.equal(optimistic.followerAction, 0);
  assert.deepEqual(optimistic.responses[0].followerBestResponses, [0, 1]);
  const pessimistic = solvePureStackelberg({ ...x, tiePolicy: 'PESSIMISTIC' });
  assert.equal(pessimistic.leaderValue, 3);
  assert.equal(pessimistic.leaderAction, 1);
});

test('Stackelberg agrees with independently enumerated follower best-response policies over 40 games', () => {
  const random = rng(214);
  for (let trial = 0; trial < 40; trial++) {
    const rows = 2 + trial % 3, cols = 2 + trial % 4;
    const l = Array.from({ length: rows }, () => Array.from({ length: cols }, () => Math.floor(random() * 11) - 5));
    const f = Array.from({ length: rows }, () => Array.from({ length: cols }, () => Math.floor(random() * 7) - 3));
    for (const policy of ['OPTIMISTIC', 'PESSIMISTIC']) {
      const expected = l.map((row, a) => {
        const best = Math.max(...f[a]);
        const available = row.map((payoff, b) => f[a][b] === best ? payoff : null).filter((v) => v !== null);
        return policy === 'OPTIMISTIC' ? Math.max(...available) : Math.min(...available);
      });
      const result = solvePureStackelberg({ leaderPayoffs: l, followerPayoffs: f, tiePolicy: policy });
      assert.equal(result.leaderValue, Math.max(...expected));
      assert.equal(result.responses.length, rows);
    }
  }
});

test('Stackelberg rejects incomplete payoffs and fabricated tie policy', () => {
  const x = { leaderPayoffs: [[1, 2], [3, 4]], followerPayoffs: [[1, 2], [3, 4]], tiePolicy: 'OPTIMISTIC' };
  assert.throws(() => solvePureStackelberg({ ...x, followerPayoffs: [[1], [2]] }), /length|dimensions|bounded/i);
  assert.throws(() => solvePureStackelberg({ ...x, tiePolicy: 'MAGIC' }), /policy/i);
  assert.throws(() => solvePureStackelberg({ ...x, leaderPayoffs: [[1, 2], [3, Infinity]] }), /safe integer/i);
});

test('transfer entropy is one bit for delay-copy with balanced conditioning and zero for constant target', () => {
  const one = estimateBinaryTransferEntropy({ source: [0, 0, 1, 1, 0], target: [1, 0, 0, 1, 1] });
  near(one.bits, 1); assert.equal(one.effectiveSamples, 4);
  near(estimateBinaryTransferEntropy({ source: [0, 1, 0, 1, 0], target: [0, 0, 0, 0, 0] }).bits, 0);
});

test('transfer entropy agrees with independent conditional entropy calculation for 60 deterministic samples', () => {
  const random = rng(181);
  for (let trial = 0; trial < 60; trial++) {
    const x = Array.from({ length: 16 }, () => random() < .5 ? 0 : 1);
    const y = Array.from({ length: 16 }, () => random() < .5 ? 0 : 1);
    const result = estimateBinaryTransferEntropy({ source: x, target: y });
    const conditionalEntropy = (conditionOnSource) => {
      const buckets = new Map();
      for (let i = 0; i < 15; i++) {
        const key = conditionOnSource ? `${y[i]},${x[i]}` : `${y[i]}`;
        if (!buckets.has(key)) buckets.set(key, [0, 0]);
        buckets.get(key)[y[i + 1]]++;
      }
      let entropy = 0;
      for (const cells of buckets.values()) {
        const total = cells[0] + cells[1];
        for (const count of cells) if (count) entropy -= count / 15 * Math.log2(count / total);
      }
      return entropy;
    };
    near(result.bits, conditionalEntropy(false) - conditionalEntropy(true), 1e-12);
  }
});

test('transfer entropy fails closed on mismatched, sparse or invalid signals', () => {
  assert.throws(() => estimateBinaryTransferEntropy({ source: [0, 1, 0], target: [0, 1] }), /length|bounded/i);
  assert.throws(() => estimateBinaryTransferEntropy({ source: [0, 2, 1], target: [0, 1, 0] }), /safe integer/i);
  assert.throws(() => estimateBinaryTransferEntropy({ source: [0, , 1], target: [0, 1, 0] }), /dense/i);
});

test('finite robust scenarios distinguish minimax loss, expected loss and minimax regret exactly', () => {
  const r = optimizeRobustScenarios({ decisions: ['A', 'B'], scenarioProbabilities: ['1/2', '1/2'], losses: [[0, 4], [3, 3]] });
  assert.equal(r.minimaxLossDecision, 'B');
  assert.equal(r.minimumExpectedLossDecision, 'A');
  assert.equal(r.minimaxRegretDecision, 'A');
  assert.deepEqual(r.byDecision[0], { decision: 'A', worstCaseLoss: '4/1', expectedLoss: '2/1', maximumRegret: '1/1', losses: ['0/1', '4/1'] });
});

test('robust scenario choices match independent brute force on 60 randomized profiles', () => {
  const random = rng(42);
  for (let trial = 0; trial < 60; trial++) {
    const losses = Array.from({ length: 4 }, () => Array.from({ length: 3 }, () => Math.floor(random() * 21) - 10));
    const result = optimizeRobustScenarios({ decisions: ['a', 'b', 'c', 'd'], scenarioProbabilities: ['1/2', '1/3', '1/6'], losses });
    const minima = Array.from({ length: 3 }, (_, s) => Math.min(...losses.map((row) => row[s])));
    const metrics = losses.map((row) => [Math.max(...row), Math.max(...row.map((v, s) => v - minima[s])), (3 * row[0] + 2 * row[1] + row[2]) / 6]);
    for (const [key, col] of [['minimaxLossDecision', 0], ['minimaxRegretDecision', 1], ['minimumExpectedLossDecision', 2]]) {
      const best = metrics.reduce((index, row, i) => row[col] < metrics[index][col] ? i : index, 0);
      assert.equal(result[key], ['a', 'b', 'c', 'd'][best]);
    }
  }
});

test('robust scenarios reject nonnormalized probabilities, sparse arrays and duplicate choices', () => {
  const x = { decisions: ['a', 'b'], scenarioProbabilities: ['1/2', '1/2'], losses: [[0, 1], [1, 0]] };
  assert.throws(() => optimizeRobustScenarios({ ...x, scenarioProbabilities: ['1/2', '1/3'] }), /sum to one/i);
  assert.throws(() => optimizeRobustScenarios({ ...x, decisions: ['a', 'a'] }), /duplicate/i);
  assert.throws(() => optimizeRobustScenarios({ ...x, losses: [[0, 1], [1]] }), /bounded|length/i);
});

test('temporal graph snapshots honor addition, removal, directionality and query order', () => {
  const input = { nodes: ['a', 'b', 'c'], directed: true,
    events: [{ at: 0, op: 'ADD', from: 'a', to: 'b', weight: 2 }, { at: 2, op: 'ADD', from: 'b', to: 'c', weight: 4 },
      { at: 4, op: 'ADD', from: 'a', to: 'c', weight: 10 }, { at: 5, op: 'REMOVE', from: 'b', to: 'c' }],
    queries: [{ at: 4, source: 'a', target: 'c' }, { at: 1, source: 'a', target: 'c' }, { at: 5, source: 'a', target: 'c' }, { at: 4, source: 'c', target: 'a' }] };
  const r = queryTemporalGraph(input);
  assert.deepEqual(r.snapshots.map((q) => q.distance), [6, null, 10, null]);
  assert.deepEqual(r.snapshots[0].path, ['a', 'b', 'c']);
  assert.deepEqual(r.snapshots[1].path, []);
  assert.equal(r.eventsProcessed, 4);
  const undirected = queryTemporalGraph({ ...input, directed: false, queries: [{ at: 4, source: 'c', target: 'a' }] });
  assert.equal(undirected.snapshots[0].distance, 6);
});

test('temporal Dijkstra equals independent Bellman-Ford across 30 graphs', () => {
  const random = rng(818);
  for (let trial = 0; trial < 30; trial++) {
    const n = 3 + trial % 4, nodes = Array.from({ length: n }, (_, i) => `v${i}`), edges = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j && random() < .4) {
      edges.push({ at: 0, op: 'ADD', from: nodes[i], to: nodes[j], weight: Math.floor(random() * 8) });
    }
    const queries = nodes.map((target) => ({ at: 0, source: 'v0', target }));
    const r = queryTemporalGraph({ nodes, directed: true, events: edges, queries });
    const distances = Array(n).fill(Infinity); distances[0] = 0;
    for (let pass = 1; pass < n; pass++) for (const edge of edges) {
      const a = nodes.indexOf(edge.from), b = nodes.indexOf(edge.to);
      distances[b] = Math.min(distances[b], distances[a] + edge.weight);
    }
    assert.deepEqual(r.snapshots.map((q) => q.distance), distances.map((d) => Number.isFinite(d) ? d : null));
    for (const q of r.snapshots) if (q.distance !== null) {
      let sum = 0;
      for (let i = 1; i < q.path.length; i++) sum += edges.find((e) => e.from === q.path[i - 1] && e.to === q.path[i]).weight;
      assert.equal(sum, q.distance);
    }
  }
});

test('temporal graph rejects removed nonexistent edges, negative weights and unsorted events', () => {
  const base = { nodes: ['a', 'b'], directed: true, events: [], queries: [{ at: 1, source: 'a', target: 'b' }] };
  assert.throws(() => queryTemporalGraph({ ...base, events: [{ at: 0, op: 'REMOVE', from: 'a', to: 'b' }] }), /absent/i);
  assert.throws(() => queryTemporalGraph({ ...base, events: [{ at: 0, op: 'ADD', from: 'a', to: 'b', weight: -1 }] }), /safe integer/i);
  assert.throws(() => queryTemporalGraph({ ...base, events: [{ at: 2, op: 'ADD', from: 'a', to: 'b', weight: 1 }, { at: 1, op: 'REMOVE', from: 'a', to: 'b' }] }), /sorted/i);
});

test('ergodic chain exact stationary distribution and periodicity', () => {
  const a = certifyFiniteErgodicity({ transition: [['1/2', '1/2'], ['1/3', '2/3']] });
  assert.deepEqual(a.stationary, ['2/5', '3/5']); assert.equal(a.period, 1); assert.equal(a.ergodic, true);
  const cyclic = certifyFiniteErgodicity({ transition: [['0/1', '1/1'], ['1/1', '0/1']] });
  assert.equal(cyclic.irreducible, true); assert.equal(cyclic.period, 2); assert.equal(cyclic.ergodic, false);
  assert.deepEqual(cyclic.stationary, ['1/2', '1/2']);
  const reducible = certifyFiniteErgodicity({ transition: [['1/1', '0/1'], ['0/1', '1/1']] });
  assert.equal(reducible.irreducible, false); assert.equal(reducible.stationary, null);
});

test('ergodicity period identifies 3-cycle and independent invariance in 30 two-state chains', () => {
  assert.equal(certifyFiniteErgodicity({ transition: [['0/1', '1/1', '0/1'], ['0/1', '0/1', '1/1'], ['1/1', '0/1', '0/1']] }).period, 3);
  for (let i = 1; i <= 5; i++) for (let j = 1; j <= 6; j++) {
    const r = certifyFiniteErgodicity({ transition: [[`${10-i}/10`, `${i}/10`], [`${j}/10`, `${10-j}/10`]] });
    near(number(r.stationary[0]), j / (i + j)); near(number(r.stationary[1]), i / (i + j));
    assert.equal(r.ergodic, true);
  }
});

test('ergodicity rejects non-Markov rows and unsupported singular inputs', () => {
  assert.throws(() => certifyFiniteErgodicity({ transition: [['1/2', '1/3'], ['1/2', '1/2']] }), /sum exactly/i);
  assert.throws(() => certifyFiniteErgodicity({ transition: [['2/1', '0/1'], ['0/1', '1/1']] }), /probability/i);
});

test('discounted stochastic DP has exact optimal Bellman policy and negative rewards', () => {
  const r = solveDiscountedMdp(mdp);
  assert.deepEqual(r.optimalPolicy, { s0: 'jump', s1: 'stay' });
  assert.deepEqual(r.values, ['3/1', '2/1']);
  assert.equal(r.expectedInitialValue, '5/2'); assert.equal(r.bellmanResidual, '0/1');
  assert.equal(solveDiscountedMdp({ ...mdp, rewards: [[-2, -1], [-3, 0]] }).bellmanResidual, '0/1');
});

test('discounted MDP agrees with independently enumerated two-state policies on 45 models', () => {
  const random = rng(998);
  for (let trial = 0; trial < 45; trial++) {
    const ratios = Array.from({ length: 4 }, () => Math.floor(random() * 11));
    const transitions = [0, 1].map((s) => [0, 1].map((a) => [`${ratios[s * 2 + a]}/10`, `${10 - ratios[s * 2 + a]}/10`]));
    const rewards = [0, 1].map(() => [0, 1].map(() => Math.floor(random() * 15) - 7));
    const gamma = .2 + .1 * (trial % 5);
    const discount = `${2 + trial % 5}/10`;
    const r = solveDiscountedMdp({ ...mdp, transition: transitions, rewards, discount });
    // Independent closed-form 2x2 policy evaluation; optimal state values are maxima over 4 policies.
    const policyValues = [];
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) {
      const p = ratios[a] / 10, q = ratios[2 + b] / 10;
      const A = 1 - gamma * p, B = -gamma * (1 - p), C = -gamma * q, D = 1 - gamma * (1 - q);
      const determinant = A * D - B * C;
      policyValues.push([(D * rewards[0][a] - B * rewards[1][b]) / determinant,
        (A * rewards[1][b] - C * rewards[0][a]) / determinant]);
    }
    for (let s = 0; s < 2; s++) near(number(r.values[s]), Math.max(...policyValues.map((v) => v[s])), 1e-8);
  }
});

test('discounted MDP rejects gamma 1, nonnormalized transitions and invalid sparse states', () => {
  assert.throws(() => solveDiscountedMdp({ ...mdp, discount: '1/1' }), /strictly below/i);
  assert.throws(() => solveDiscountedMdp({ ...mdp, transition: [[['1/2', '1/3'], ['0/1', '1/1']], ...mdp.transition.slice(1)] }), /sum to one/i);
  assert.throws(() => solveDiscountedMdp({ ...mdp, initialDistribution: ['0/1', '0/1'] }), /sum to one/i);
});

test('all 6 additional operators interoperate via GAUSS SHA-linked task dependencies and real Quantum receipt', async () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/advanced-v1.json', import.meta.url), 'utf8'));
  const task = (taskId, operatorId, input) => ({ taskId, operatorId, input });
  const ref = (taskId, ...path) => ({ $ref: { taskId, path } });
  const report = await executeGaussAdvancedProblem({ schemaVersion: 1, problemId: 'wave4-connected-proof', objective: 'Bounded mathematical proof of module dataflow',
    gaussTasks: fixture.gaussTasks, tasks: [
      task('graph', 'TEMPORAL_GRAPH_SHORTEST_PATH_V1', { nodes: ['a', 'b'], directed: true,
        events: [{ at: 0, op: 'ADD', from: 'a', to: 'b', weight: 3 }], queries: [{ at: 0, source: 'a', target: 'b' }] }),
      task('robust', 'ROBUST_FINITE_SCENARIOS_V1', { decisions: ['A', 'B'], scenarioProbabilities: ['1/2', '1/2'],
        losses: [[ref('graph', 'snapshots', 0, 'distance'), 6], [4, 4]] }),
      task('stackelberg', 'STACKELBERG_FINITE_PURE_V1', { leaderPayoffs: [[3, 1], [ref('graph', 'snapshots', 0, 'distance'), 4]],
        followerPayoffs: [[1, 0], [0, 1]], tiePolicy: 'PESSIMISTIC' }),
      task('ergodic', 'FINITE_MARKOV_ERGODICITY_V1', { transition: [['1/2', '1/2'], ['1/3', '2/3']] }),
      task('mdp', 'DISCOUNTED_MDP_EXACT_V1', { ...mdp, initialDistribution: ref('ergodic', 'stationary') }),
      task('transfer', 'TRANSFER_ENTROPY_BINARY_LAG1_V1', { source: [0, 0, 1, 1, 0], target: [1, 0, 0, 1, 1] }),
    ] });
  assert.equal(Object.keys(GAUSS_ADVANCED_OPERATORS).length, 18);
  assert.equal(report.status, 'PASS'); assert.equal(report.advancedOperatorCount, 18);
  assert.equal(report.taskResults.length, 6);
  assert.deepEqual(report.taskResults.map((t) => t.status), Array(6).fill('EXECUTED'));
  assert.equal(report.taskResults[1].output.minimaxLossDecision, 'B');
  assert.equal(report.taskResults[1].dependencies[0].taskId, 'graph');
  assert.equal(report.taskResults[4].dependencies[0].taskId, 'ergodic');
  assert.equal(report.taskResults[4].output.expectedInitialValue, '12/5');
  near(report.taskResults[5].output.bits, 1);
  assert.equal(report.linkedGaussStatus, 'PASS');
  assert.match(report.linkedQuantumReceiptSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal((await executeGaussAdvancedProblem({ schemaVersion: 1, problemId: 'wave4-connected-proof', objective: 'Bounded mathematical proof of module dataflow',
    gaussTasks: fixture.gaussTasks, tasks: [
      task('ergodic', 'FINITE_MARKOV_ERGODICITY_V1', { transition: [['1/2', '1/2'], ['1/3', '2/3']] }),
      task('mdp', 'DISCOUNTED_MDP_EXACT_V1', { ...mdp, initialDistribution: ref('ergodic', 'stationary') }),
    ] })).status, 'PASS');
});
