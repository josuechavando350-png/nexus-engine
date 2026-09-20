import { assertArray, assertExactKeys, assertSafeInteger, assertToken } from '../core/common.mjs';

const bounded = (value, label) => assertSafeInteger(value, label, { min: -1_000_000, max: 1_000_000 });

/** Exact H_0 persistence of a finite graph filtration, including zero-length bars. */
export function persistentHomologyZero(input) {
  assertExactKeys(input, ['vertices', 'edges', 'queryTimes'], 'H0 input');
  const vertices = assertArray(input.vertices, 'vertices', { min: 1, max: 64 });
  const edges = assertArray(input.edges, 'edges', { max: 256 });
  const queries = assertArray(input.queryTimes, 'queryTimes', { max: 128 });
  const born = new Map();
  for (const [i, vertex] of vertices.entries()) {
    assertExactKeys(vertex, ['id', 'birth'], `vertices[${i}]`);
    const id = assertToken(vertex.id, `vertices[${i}].id`);
    if (born.has(id)) throw new TypeError('duplicate vertex ID');
    born.set(id, bounded(vertex.birth, `vertices[${i}].birth`));
  }
  const used = new Set();
  const events = edges.map((edge, i) => {
    assertExactKeys(edge, ['u', 'v', 'time'], `edges[${i}]`);
    if (!born.has(edge.u) || !born.has(edge.v) || edge.u === edge.v) throw new TypeError('edge requires two distinct known vertices');
    const key = [edge.u, edge.v].sort().join('\u0000');
    if (used.has(key)) throw new TypeError('duplicate undirected edge');
    used.add(key);
    const time = bounded(edge.time, `edges[${i}].time`);
    if (time < born.get(edge.u) || time < born.get(edge.v)) throw new RangeError('edge must appear after both vertices');
    return { ...edge, time };
  }).sort((a, b) => a.time - b.time || a.u.localeCompare(b.u) || a.v.localeCompare(b.v));
  const parent = new Map([...born.keys()].map((id) => [id, id]));
  function root(id) { let r = id; while (parent.get(r) !== r) r = parent.get(r); while (parent.get(id) !== id) { const n = parent.get(id); parent.set(id, r); id = n; } return r; }
  // The elder component survives; ties use vertex ID for deterministic zero-length bars.
  const older = (a, b) => born.get(a) < born.get(b) || (born.get(a) === born.get(b) && a < b);
  const bars = [];
  for (const edge of events) {
    const a = root(edge.u), b = root(edge.v);
    if (a === b) continue; // Creates a cycle, which H0 does not count.
    const survivor = older(a, b) ? a : b, killed = survivor === a ? b : a;
    bars.push({ component: killed, birth: born.get(killed), death: edge.time, lifetime: edge.time - born.get(killed) });
    parent.set(killed, survivor);
  }
  for (const id of born.keys()) if (root(id) === id) bars.push({ component: id, birth: born.get(id), death: null, lifetime: null });
  bars.sort((a,b) => a.birth - b.birth || (a.death ?? Infinity) - (b.death ?? Infinity) || a.component.localeCompare(b.component));
  const bettiZero = queries.map((time, i) => {
    bounded(time, `queryTimes[${i}]`);
    return { time, components: bars.filter((bar) => bar.birth <= time && (bar.death === null || time < bar.death)).length };
  });
  return { dimension: 0, bars, bettiZero, essentialComponentCount: bars.filter((x) => x.death === null).length,
    method: 'UNION_FIND_ELDER_RULE', note: 'H0 persistence only; does not compute H1 or higher homology.' };
}
