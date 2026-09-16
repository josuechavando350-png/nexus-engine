import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shortestPathDijkstra, minimumSpanningForest, maximumFlowMinimumCut,
  stronglyConnectedComponents, bipartiteMaximumMatching, directedAcyclicSchedule,
  exactTravelingSalesperson, stationaryPageRank,
} from '../core/layers/graph-optimization.mjs';

let state = 0xdecafbad;
const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
const int = max => Math.floor(random() * max);
const nearly = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

function bellmanFord(n, edges, s) {
  const distance = Array(n).fill(Infinity);
  distance[s] = 0;
  for (let k = 1; k < n; k++) for (const { from, to, cost } of edges)
    distance[to] = Math.min(distance[to], distance[from] + cost);
  return distance;
}

test('shortest paths match independent Bellman-Ford for 200 seeded directed graphs', () => {
  for (let iteration = 0; iteration < 200; iteration++) {
    const n = 2 + int(6);
    const edges = [];
    for (let u = 0; u < n; u++) for (let v = 0; v < n; v++) if (u !== v && random() < 0.4) edges.push({ from: u, to: v, cost: int(20) });
    const s = int(n);
    const oracle = bellmanFord(n, edges, s);
    for (let target = 0; target < n; target++) {
      const got = shortestPathDijkstra({ vertexCount: n, edges, source: s, target });
      assert.equal(got.distance, oracle[target] === Infinity ? null : oracle[target]);
      if (got.reachable) {
        assert.equal(got.path[0], s);
        assert.equal(got.path.at(-1), target);
        assert.equal(new Set(got.path).size, got.path.length);
        let witness = 0;
        for (let i = 1; i < got.path.length; i++) {
          const candidates = edges.filter(e => e.from === got.path[i - 1] && e.to === got.path[i]);
          assert(candidates.length);
          witness += Math.min(...candidates.map(e => e.cost));
        }
        assert.equal(witness, got.distance);
      }
    }
  }
});

function componentCount(n, edges) {
  const p = Array.from({ length: n }, (_, i) => i);
  const find = i => { while (p[i] !== i) i = p[i]; return i; };
  for (const { from, to } of edges) p[find(from)] = find(to);
  return new Set(p.map(find)).size;
}
function exhaustiveForest(n, edges) {
  const target = componentCount(n, edges);
  let best = Infinity;
  for (let mask = 0; mask < 2 ** edges.length; mask++) {
    const chosen = edges.filter((_, i) => mask & (1 << i));
    if (chosen.length !== n - target) continue;
    if (componentCount(n, chosen) === target) best = Math.min(best, chosen.reduce((s, e) => s + e.weight, 0));
  }
  return best;
}

test('minimum spanning forest matches exhaustive subset oracle on 100 weighted graphs', () => {
  for (let iteration = 0; iteration < 100; iteration++) {
    const n = 2 + int(5);
    const edges = [];
    for (let u = 0; u < n; u++) for (let v = u + 1; v < n; v++) if (random() < 0.43) edges.push({ from: u, to: v, weight: int(17) - 8 });
    if (edges.length > 14) continue;
    const actual = minimumSpanningForest({ vertexCount: n, edges });
    assert.equal(actual.totalWeight, exhaustiveForest(n, edges));
    assert.equal(actual.components, componentCount(n, edges));
    assert.equal(actual.selectedEdges.length, n - actual.components);
  }
});

function bruteMinCut(n, edges, s, t) {
  let minimum = Infinity;
  for (let mask = 0; mask < 2 ** n; mask++) {
    if (!(mask & (1 << s)) || (mask & (1 << t))) continue;
    const value = edges.reduce((sum, e) => sum + ((mask & (1 << e.from)) && !(mask & (1 << e.to)) ? e.capacity : 0), 0);
    minimum = Math.min(minimum, value);
  }
  return minimum;
}

test('max flow and min cut agree with exhaustive cut oracle on 140 flow networks', () => {
  for (let iteration = 0; iteration < 140; iteration++) {
    const n = 2 + int(5);
    const edges = [];
    for (let u = 0; u < n; u++) for (let v = 0; v < n; v++) if (u !== v && random() < 0.35) edges.push({ from: u, to: v, capacity: int(11) });
    const result = maximumFlowMinimumCut({ vertexCount: n, edges, source: 0, sink: n - 1 });
    const oracle = bruteMinCut(n, edges, 0, n - 1);
    assert.equal(result.maximumFlow, oracle);
    assert.equal(result.cutCapacity, oracle);
    assert(result.sourceSide.includes(0));
    assert(!result.sourceSide.includes(n - 1));
    assert.equal(edges.filter(e => result.sourceSide.includes(e.from) && !result.sourceSide.includes(e.to)).reduce((sum, e) => sum + e.capacity, 0), oracle);
  }
});

function oracleReachability(n, edges) {
  const reach = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j));
  for (const { from, to } of edges) reach[from][to] = true;
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) reach[i][j] ||= reach[i][k] && reach[k][j];
  return reach;
}

test('strongly connected components match independent transitive closure on 200 graphs', () => {
  for (let iteration = 0; iteration < 200; iteration++) {
    const n = 2 + int(6);
    const edges = [];
    for (let u = 0; u < n; u++) for (let v = 0; v < n; v++) if (u !== v && random() < 0.35) edges.push({ from: u, to: v });
    const result = stronglyConnectedComponents({ vertexCount: n, edges });
    const reach = oracleReachability(n, edges);
    assert.equal(result.components.flat().length, n);
    for (let u = 0; u < n; u++) for (let v = 0; v < n; v++) {
      const same = result.components.some(c => c.includes(u) && c.includes(v));
      assert.equal(same, reach[u][v] && reach[v][u]);
    }
  }
});

function bruteMatching(n, edges) {
  const adj = Array.from({ length: n }, () => []);
  for (const { left, right } of edges) adj[left].push(right);
  function search(u, taken) {
    if (u === n) return 0;
    let best = search(u + 1, taken);
    for (const v of adj[u]) if (!(taken & (1 << v))) best = Math.max(best, 1 + search(u + 1, taken | (1 << v)));
    return best;
  }
  return search(0, 0);
}

test('bipartite maximum matching matches independent subset oracle on 160 graphs', () => {
  for (let iteration = 0; iteration < 160; iteration++) {
    const left = 1 + int(6);
    const right = 1 + int(6);
    const edges = [];
    for (let u = 0; u < left; u++) for (let v = 0; v < right; v++) if (random() < 0.5) edges.push({ left: u, right: v });
    const got = bipartiteMaximumMatching({ leftCount: left, rightCount: right, edges });
    assert.equal(got.size, bruteMatching(left, edges));
    assert.equal(new Set(got.pairs.map(p => p.left)).size, got.size);
    assert.equal(new Set(got.pairs.map(p => p.right)).size, got.size);
    for (const pair of got.pairs) assert(edges.some(e => e.left === pair.left && e.right === pair.right));
  }
});

function exhaustiveSchedule(n, durations, dependencies) {
  const incoming = Array.from({ length: n }, () => []);
  for (const e of dependencies) incoming[e.to].push(e.from);
  const finish = Array(n).fill(-1);
  function resolve(u) {
    if (finish[u] !== -1) return finish[u];
    return finish[u] = durations[u] + Math.max(0, ...incoming[u].map(resolve));
  }
  return Math.max(...Array.from({ length: n }, (_, u) => resolve(u)));
}

test('DAG schedule computes critical-path makespan against recursive independent oracle', () => {
  for (let iteration = 0; iteration < 160; iteration++) {
    const n = 2 + int(7);
    const durations = Array.from({ length: n }, () => int(20));
    const dependencies = [];
    for (let u = 0; u < n; u++) for (let v = u + 1; v < n; v++) if (random() < 0.35) dependencies.push({ from: u, to: v });
    const got = directedAcyclicSchedule({ durations, dependencies });
    assert.equal(got.makespan, exhaustiveSchedule(n, durations, dependencies));
    assert.equal(got.criticalPath.reduce((sum, u) => sum + durations[u], 0), got.makespan);
    for (const { from, to } of dependencies) {
      assert(got.order.indexOf(from) < got.order.indexOf(to));
      assert(got.earliestFinish[from] <= got.earliestStart[to]);
    }
  }
});

function bruteTsp(weights) {
  const n = weights.length;
  function permute(path, remaining, length) {
    if (!remaining.length) return length + weights[path.at(-1)][0];
    return Math.min(...remaining.map((v, i) => permute([...path, v], remaining.filter((_, j) => j !== i), length + weights[path.at(-1)][v])));
  }
  return n === 1 ? 0 : permute([0], Array.from({ length: n - 1 }, (_, i) => i + 1), 0);
}

test('exact TSP matches permutation oracle on 90 directed cost matrices', () => {
  for (let iteration = 0; iteration < 90; iteration++) {
    const n = 2 + int(6);
    const distances = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j ? 0 : int(50)));
    const got = exactTravelingSalesperson({ distances });
    assert.equal(got.minimumCost, bruteTsp(distances));
    assert.equal(got.tour.length, n + 1);
    assert.equal(got.tour[0], 0);
    assert.equal(got.tour.at(-1), 0);
    assert.equal(new Set(got.tour.slice(0, -1)).size, n);
  }
});

test('PageRank matches a separately solved two-node stationary equation and rejects nonconvergence', () => {
  const got = stationaryPageRank({ vertexCount: 2, edges: [{ from: 0, to: 1 }], damping: 0.85 });
  const exact0 = 1 / (2 + 0.85);
  assert(nearly(got.scores[0], exact0));
  assert(nearly(got.scores[1], 1 - exact0));
  assert(nearly(got.scores.reduce((a, b) => a + b, 0), 1));
  assert.throws(() => stationaryPageRank({ vertexCount: 2, edges: [{ from: 0, to: 1 }], maxIterations: 1, tolerance: 1e-15 }), /did not converge/u);
});

function solveLinearSystem(matrix, rhs) {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i]]);
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++) if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    assert(Math.abs(a[pivot][column]) > 1e-12);
    [a[pivot], a[column]] = [a[column], a[pivot]];
    const value = a[column][column];
    for (let c = column; c <= n; c++) a[column][c] /= value;
    for (let row = 0; row < n; row++) if (row !== column) {
      const factor = a[row][column];
      for (let c = column; c <= n; c++) a[row][c] -= factor * a[column][c];
    }
  }
  return a.map(row => row[n]);
}

test('PageRank matches independently solved stationary linear equations for 120 directed graphs', () => {
  for (let iteration = 0; iteration < 120; iteration++) {
    const n = 2 + int(5);
    const damping = 0.25 + random() * 0.7;
    const edges = [];
    for (let u = 0; u < n; u++) for (let v = 0; v < n; v++) if (u !== v && random() < 0.35) edges.push({ from: u, to: v });
    const outDegree = Array.from({ length: n }, (_, u) => edges.filter(e => e.from === u).length);
    const transition = Array.from({ length: n }, (_, v) => Array.from({ length: n }, (_, u) => {
      return outDegree[u] === 0 ? 1 / n : edges.some(e => e.from === u && e.to === v) ? 1 / outDegree[u] : 0;
    }));
    const matrix = transition.map((row, v) => row.map((p, u) => (u === v ? 1 : 0) - damping * p));
    const rhs = Array(n).fill((1 - damping) / n);
    const oracle = solveLinearSystem(matrix, rhs);
    const actual = stationaryPageRank({ vertexCount: n, edges, damping, tolerance: 1e-12 });
    for (let v = 0; v < n; v++) assert(nearly(actual.scores[v], oracle[v], 1e-10));
  }
});

test('all eight operators fail closed for invalid inputs and do not claim unbounded exactness', () => {
  assert.throws(() => shortestPathDijkstra({ vertexCount: 2, edges: [{ from: 0, to: 1, cost: -1 }], source: 0, target: 1 }), /safe integer/u);
  assert.throws(() => minimumSpanningForest({ vertexCount: 2, edges: [{ from: 0, to: 1, weight: 1 }, { from: 1, to: 0, weight: 1 }] }), /duplicate/u);
  assert.throws(() => maximumFlowMinimumCut({ vertexCount: 2, edges: [], source: 0, sink: 0 }), /differ/u);
  assert.throws(() => stronglyConnectedComponents({ vertexCount: 2, edges: [{ from: 0, to: 1 }, { from: 0, to: 1 }] }), /duplicate/u);
  assert.throws(() => bipartiteMaximumMatching({ leftCount: 1, rightCount: 1, edges: [{ left: 0, right: 0 }, { left: 0, right: 0 }] }), /duplicate/u);
  assert.throws(() => directedAcyclicSchedule({ durations: [1, 1], dependencies: [{ from: 0, to: 1 }, { from: 1, to: 0 }] }), /cycle/u);
  assert.throws(() => exactTravelingSalesperson({ distances: Array.from({ length: 12 }, () => Array(12).fill(0)) }), /1..11/u);
  assert.throws(() => stationaryPageRank({ vertexCount: 2, edges: [], damping: 1 }), /damping/u);
});
