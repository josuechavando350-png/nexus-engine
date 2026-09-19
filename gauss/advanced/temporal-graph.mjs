import { assertExactKeys, assertSafeInteger, assertToken } from '../core/common.mjs';
import { dense } from './scientific-linear.mjs';

const tick = (value, label) => assertSafeInteger(value, label, { min: 0, max: 1_000_000 });

/** Event-sourced directed/undirected graph with exact integer Dijkstra snapshots. */
export function queryTemporalGraph(input) {
  assertExactKeys(input, ['nodes', 'directed', 'events', 'queries'], 'temporal graph');
  const nodes = dense(input.nodes, 'nodes', 2, 128).map((id, i) => assertToken(id, `nodes[${i}]`));
  if (new Set(nodes).size !== nodes.length) throw new TypeError('duplicate graph node');
  const ids = new Set(nodes);
  if (typeof input.directed !== 'boolean') throw new TypeError('directed must be boolean');
  const events = dense(input.events, 'events', 0, 1024).map((event, i) => {
    if (!event || !['ADD', 'REMOVE'].includes(event.op)) throw new TypeError(`events[${i}] invalid op`);
    assertExactKeys(event, event.op === 'ADD' ? ['at', 'op', 'from', 'to', 'weight'] : ['at', 'op', 'from', 'to'], `events[${i}]`);
    const at = tick(event.at, `events[${i}].at`);
    if (i && at < input.events[i - 1].at) throw new TypeError('events must be sorted by timestamp');
    if (!ids.has(event.from) || !ids.has(event.to) || event.from === event.to) throw new TypeError('unknown node or self-loop');
    if (event.op === 'ADD') assertSafeInteger(event.weight, `events[${i}].weight`, { min: 0, max: 1_000_000 });
    return event;
  });
  const queries = dense(input.queries, 'queries', 1, 128).map((query, i) => {
    assertExactKeys(query, ['at', 'source', 'target'], `queries[${i}]`);
    tick(query.at, `queries[${i}].at`);
    if (!ids.has(query.source) || !ids.has(query.target)) throw new TypeError('unknown query node');
    return query;
  });
  const graph = new Map(nodes.map((name) => [name, new Map()]));
  let cursor = 0;
  const snapshots = Array(queries.length);
  const ordered = queries.map((query, index) => ({ ...query, index })).sort((a, b) => a.at - b.at || a.index - b.index);
  for (const query of ordered) {
    while (cursor < events.length && events[cursor].at <= query.at) {
      const event = events[cursor++], a = graph.get(event.from), b = graph.get(event.to);
      if (event.op === 'ADD') {
        if (a.has(event.to)) throw new TypeError('duplicate ADD without REMOVE');
        a.set(event.to, event.weight);
        if (!input.directed) b.set(event.from, event.weight);
      } else {
        if (!a.has(event.to)) throw new TypeError('REMOVE of absent edge');
        a.delete(event.to);
        if (!input.directed) b.delete(event.from);
      }
    }
    const distances = new Map(nodes.map((node) => [node, Infinity]));
    const parents = new Map(), visited = new Set();
    distances.set(query.source, 0);
    while (visited.size < nodes.length) {
      let current = null;
      for (const node of nodes) if (!visited.has(node) && (current === null || distances.get(node) < distances.get(current))) current = node;
      if (current === null || !Number.isFinite(distances.get(current))) break;
      visited.add(current);
      for (const [neighbor, weight] of graph.get(current)) {
        const proposal = distances.get(current) + weight;
        if (!Number.isSafeInteger(proposal)) throw new RangeError('shortest path distance overflow');
        if (proposal < distances.get(neighbor)) { distances.set(neighbor, proposal); parents.set(neighbor, current); }
      }
    }
    const reachable = Number.isFinite(distances.get(query.target));
    const path = [];
    if (reachable) {
      let node = query.target;
      for (let i = 0; i <= nodes.length; i++) {
        path.unshift(node);
        if (node === query.source) break;
        node = parents.get(node);
        if (!node) throw new Error('shortest path predecessor invariant failed');
      }
      if (path[0] !== query.source) throw new Error('shortest path reconstruction overflow');
    }
    snapshots[query.index] = { at: query.at, source: query.source, target: query.target,
      distance: reachable ? distances.get(query.target) : null, path,
      reachableCount: [...distances.values()].filter(Number.isFinite).length };
  }
  return { directed: input.directed, snapshots, eventsProcessed: cursor,
    method: 'EVENT_SOURCED_EXACT_INTEGER_DIJKSTRA',
    note: 'Time-stamped graph snapshots and nonnegative edge weights; no network scraping or real-time subscription.' };
}
