import { object, array, integer, number } from './shared.mjs';

function graphOf(input) {
  const n = integer(input.vertices, 'vertices', 2, 12);
  const edges = array(input.edges, 'edges', 1, n * (n - 1) / 2);
  const adj = Array.from({ length: n }, () => []), seen = new Set();
  for (const [i, e] of edges.entries()) {
    object(e, `edges[${i}]`, ['u', 'v', 'weight'], ['u', 'v']);
    const u = integer(e.u, 'edge.u', 0, n - 1), v = integer(e.v, 'edge.v', 0, n - 1);
    const weight = e.weight === undefined ? 1 : number(e.weight, 'weight', 0.00001, 4);
    if (u === v) throw new TypeError('self edge');
    const key = [Math.min(u, v), Math.max(u, v)].join(':');
    if (seen.has(key)) throw new TypeError('duplicate undirected edge');
    seen.add(key); adj[u].push({ v, weight }); adj[v].push({ v: u, weight });
  }
  return { n, adj };
}
function distribution(r, im) {
  const probabilities = Array.from(r, (v, i) => v * v + im[i] * im[i]);
  const norm = probabilities.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > 1e-9) throw new Error('unitarity/normalization check failed');
  return { probabilities, norm };
}
/** CTQW: exp(-i t A)|start> via convergent Taylor series on small bounded substeps. */
function continuous(input, adj, n) {
  const time = number(input.time, 'time', -20, 20);
  const start = integer(input.start, 'start', 0, n - 1);
  const rowMax = Math.max(...adj.map(row => row.reduce((s, e) => s + e.weight, 0)));
  const steps = Math.max(1, Math.ceil(Math.abs(time) * rowMax / 0.5));
  if (steps > 4096) throw new RangeError('CTQW substep resource bound exceeded');
  const dt = time / steps;
  let r = new Float64Array(n), im = new Float64Array(n);
  r[start] = 1;
  for (let step = 0; step < steps; step++) {
    let tr = r.slice(), ti = im.slice(), outR = r.slice(), outI = im.slice();
    let converged = dt === 0;
    for (let k = 1; k <= 64 && !converged; k++) {
      const ar = new Float64Array(n), ai = new Float64Array(n);
      for (let v = 0; v < n; v++) for (const edge of adj[v]) {
        ar[v] += edge.weight * tr[edge.v]; ai[v] += edge.weight * ti[edge.v];
      }
      const scalar = dt / k;
      let maximum = 0;
      for (let v = 0; v < n; v++) {
        tr[v] = scalar * ai[v]; ti[v] = -scalar * ar[v];
        outR[v] += tr[v]; outI[v] += ti[v];
        maximum = Math.max(maximum, Math.abs(tr[v]), Math.abs(ti[v]));
      }
      converged = maximum < 5e-17;
    }
    if (!converged) throw new Error('Taylor series failed to converge');
    r = outR; im = outI;
  }
  const { probabilities, norm } = distribution(r, im);
  return { engine: 'NEMESIS_QUANTUM_WALK_V1', mode: 'CONTINUOUS_ADJACENCY', vertices: n, start, time,
    substeps: steps, amplitudes: Array.from(r, (re, v) => ({ vertex: v, re, im: im[v] })), probabilities, norm,
    note: 'Numerical classical simulation of a finite, ideal, unitary graph walk; no quantum hardware.' };
}
/** Coined walk: Grover reflection at each vertex, then flip-flop shift of arc direction. */
function discrete(input, adj, n) {
  const steps = integer(input.steps, 'steps', 0, 1000);
  const start = integer(input.start, 'start', 0, n - 1);
  if (adj.some(row => row.length === 0)) throw new TypeError('coined graph cannot have isolated vertices');
  const arcs = []; const index = new Map();
  for (let u = 0; u < n; u++) for (const { v } of adj[u]) { index.set(`${u}:${v}`, arcs.length); arcs.push({ u, v }); }
  let r = new Float64Array(arcs.length), im = new Float64Array(arcs.length);
  for (const { v } of adj[start]) r[index.get(`${start}:${v}`)] = 1 / Math.sqrt(adj[start].length);
  for (let step = 0; step < steps; step++) {
    const cr = new Float64Array(arcs.length), ci = new Float64Array(arcs.length);
    for (let u = 0; u < n; u++) {
      const arcIds = adj[u].map(({ v }) => index.get(`${u}:${v}`));
      const meanR = arcIds.reduce((s, i) => s + r[i], 0) / arcIds.length;
      const meanI = arcIds.reduce((s, i) => s + im[i], 0) / arcIds.length;
      for (const i of arcIds) { cr[i] = 2 * meanR - r[i]; ci[i] = 2 * meanI - im[i]; }
    }
    const nr = new Float64Array(arcs.length), ni = new Float64Array(arcs.length);
    for (let i = 0; i < arcs.length; i++) {
      const j = index.get(`${arcs[i].v}:${arcs[i].u}`);
      nr[j] = cr[i]; ni[j] = ci[i];
    }
    r = nr; im = ni;
  }
  const { norm } = distribution(r, im);
  const probabilities = Array(n).fill(0);
  for (let i = 0; i < arcs.length; i++) probabilities[arcs[i].u] += r[i] ** 2 + im[i] ** 2;
  return { engine: 'NEMESIS_QUANTUM_WALK_V1', mode: 'DISCRETE_GROVER_FLIP_FLOP', vertices: n, start, steps,
    probabilities, norm, arcs: arcs.map((a, i) => ({ ...a, re: r[i], im: im[i] })),
    note: 'Numerical classical simulation of a finite coined walk; no quantum hardware.' };
}
export function simulateQuantumWalk(input) {
  object(input, 'quantum walk', ['mode', 'vertices', 'edges', 'start', 'time', 'steps'], ['mode', 'vertices', 'edges', 'start']);
  const { n, adj } = graphOf(input);
  if (input.mode === 'continuous') {
    if (input.steps !== undefined) throw new TypeError('continuous mode does not accept steps');
    return continuous(input, adj, n);
  }
  if (input.mode === 'discrete') {
    if (input.time !== undefined || adj.some(row => row.some(e => e.weight !== 1))) throw new TypeError('discrete mode requires unweighted graph and no time');
    return discrete(input, adj, n);
  }
  throw new TypeError('mode must be continuous or discrete');
}
