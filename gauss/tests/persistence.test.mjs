import assert from "node:assert/strict";
import test from "node:test";
import { zeroDimensionalPersistence } from "../core/layers/persistence.mjs";

function referenceComponentCount(n, edges, threshold) {
  const visited = new Set();
  const adjacency = Array.from({ length: n }, () => []);
  for (const { i, j, weight } of edges) {
    if (weight > threshold) continue;
    adjacency[i].push(j);
    adjacency[j].push(i);
  }
  let components = 0;
  for (let vertex = 0; vertex < n; vertex += 1) {
    if (visited.has(vertex)) continue;
    components += 1;
    const queue = [vertex];
    visited.add(vertex);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      for (const adjacent of adjacency[queue[cursor]]) {
        if (visited.has(adjacent)) continue;
        visited.add(adjacent);
        queue.push(adjacent);
      }
    }
  }
  return components;
}

function assertAgainstIndependentOracle(n, edges) {
  const result = zeroDimensionalPersistence({ vertexCount: n, edges });
  const weights = [...new Set(edges.map((edge) => edge.weight))].sort((a, b) => a - b);
  let previous = n;
  let deathCount = 0;
  for (const threshold of weights) {
    const actual = referenceComponentCount(n, edges, threshold);
    const atThreshold = result.finiteIntervals.filter((interval) => interval.death === threshold).length;
    assert.equal(previous - actual, atThreshold, `incorrect H0 death multiplicity at ${threshold}`);
    previous = actual;
    deathCount += atThreshold;
  }
  assert.equal(result.connectedComponentCount, referenceComponentCount(n, edges, Infinity));
  assert.equal(result.finiteIntervals.length + result.infiniteIntervalCount, n);
  assert.equal(deathCount + result.infiniteIntervalCount, n);
  assert.equal(result.cycleEdgeCount, edges.length - deathCount);
  assert.equal(result.totalFinitePersistence, result.finiteIntervals.reduce((sum, x) => sum + x.persistence, 0));
}

let seed = 713821;
function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
}

test("H0 known disconnected graph includes zero-length, finite and infinite bars", () => {
  const edges = [
    { i: 0, j: 1, weight: 0 }, { i: 1, j: 2, weight: 2 },
    { i: 0, j: 2, weight: 4 }, { i: 3, j: 4, weight: 3 },
  ];
  const result = zeroDimensionalPersistence({ vertexCount: 5, edges });
  assert.deepEqual(result.finiteIntervals.map((x) => x.death), [0, 2, 3]);
  assert.equal(result.infiniteIntervalCount, 2);
  assert.equal(result.cycleEdgeCount, 1);
  assert.equal(result.totalFinitePersistence, 5);
  assertAgainstIndependentOracle(5, edges);
});

test("H0 matches independent BFS filtration for 150 seeded small weighted graphs", () => {
  for (let trial = 0; trial < 150; trial += 1) {
    const n = 1 + Math.floor(random() * 9);
    const edges = [];
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        if (random() < 0.56) edges.push({ i, j, weight: Math.floor(random() * 6) });
      }
    }
    edges.reverse();
    assertAgainstIndependentOracle(n, edges);
  }
});

test("H0 rejects malformed inputs, duplicate edges and non-finite/negative weights", () => {
  assert.throws(() => zeroDimensionalPersistence({ vertexCount: 0, edges: [] }), /vertexCount/u);
  assert.throws(() => zeroDimensionalPersistence({ vertexCount: 2, edges: [{ i: 1, j: 0, weight: 1 }] }), /i < j/u);
  assert.throws(() => zeroDimensionalPersistence({ vertexCount: 2, edges: [{ i: 0, j: 1, weight: 1 }, { i: 0, j: 1, weight: 2 }] }), /duplicate/u);
  assert.throws(() => zeroDimensionalPersistence({ vertexCount: 2, edges: [{ i: 0, j: 1, weight: -1 }] }), /finite/u);
  assert.throws(() => zeroDimensionalPersistence({ vertexCount: 2, edges: [{ i: 0, j: 1, weight: Infinity }] }), /finite/u);
});
