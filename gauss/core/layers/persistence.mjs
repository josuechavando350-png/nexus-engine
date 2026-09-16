import { assertArray, assertFiniteNumber, assertObject, assertSafeInteger } from "../common.mjs";

/**
 * Zero-dimensional persistent homology for the sublevel-set filtration of
 * a finite weighted undirected graph. All vertices are born at filtration 0;
 * an edge (i,j,w) appears at filtration w >= 0. Every successful union kills
 * one H0 class born at 0; components that never merge survive indefinitely.
 *
 * Infinite intervals are represented by an integer count instead of Infinity
 * so that evidence remains finite, canonical JSON.
 */
export function zeroDimensionalPersistence({ vertexCount, edges }) {
  const n = assertSafeInteger(vertexCount, "vertexCount", { min: 1, max: 10_000 });
  const inputEdges = assertArray(edges, "edges", { min: 0, max: 100_000 });
  const seen = new Set();
  const sortedEdges = inputEdges.map((edge, index) => {
    assertObject(edge, `edges[${index}]`);
    const i = assertSafeInteger(edge.i, `edges[${index}].i`, { min: 0, max: n - 1 });
    const j = assertSafeInteger(edge.j, `edges[${index}].j`, { min: 0, max: n - 1 });
    if (i >= j) throw new TypeError(`edges[${index}] must satisfy i < j`);
    const weight = assertFiniteNumber(edge.weight, `edges[${index}].weight`, { min: 0 });
    const key = `${i}:${j}`;
    if (seen.has(key)) throw new TypeError(`duplicate undirected edge ${key}`);
    seen.add(key);
    return { i, j, weight };
  }).sort((a, b) => a.weight - b.weight || a.i - b.i || a.j - b.j);

  const parent = Array.from({ length: n }, (_, i) => i);
  const size = new Array(n).fill(1);
  const find = (index) => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };

  const deaths = [];
  let cycleEdgeCount = 0;
  let components = n;
  for (const edge of sortedEdges) {
    let a = find(edge.i);
    let b = find(edge.j);
    if (a === b) {
      cycleEdgeCount += 1;
      continue;
    }
    if (size[a] < size[b] || (size[a] === size[b] && a > b)) [a, b] = [b, a];
    parent[b] = a;
    size[a] += size[b];
    components -= 1;
    deaths.push(edge.weight);
  }

  const finiteIntervals = deaths.map((death) => Object.freeze({ birth: 0, death, persistence: death }));
  return Object.freeze({
    filtration: "WEIGHTED_GRAPH_SUBLEVEL_H0",
    vertexCount: n,
    edgeCount: sortedEdges.length,
    finiteIntervals: Object.freeze(finiteIntervals),
    infiniteIntervalCount: components,
    connectedComponentCount: components,
    cycleEdgeCount,
    totalFinitePersistence: deaths.reduce((total, death) => total + death, 0),
  });
}
