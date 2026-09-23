import { object, array, integer, number, unique } from './shared.mjs';

/** Actual statevector simulation of the weighted MaxCut cost Hamiltonian and X mixer; no hardware/training claim. */
export function simulateQAOAMaxCut(input) {
  object(input, 'QAOA input', ['vertices', 'edges', 'gammas', 'betas']);
  const n = integer(input.vertices, 'vertices', 2, 8);
  const edges = array(input.edges, 'edges', 1, (n * (n - 1)) / 2);
  const seen = new Set();
  const graph = edges.map((edge, i) => {
    object(edge, `edges[${i}]`, ['u', 'v', 'weight']);
    const u = integer(edge.u, 'edge.u', 0, n - 1), v = integer(edge.v, 'edge.v', 0, n - 1);
    const weight = integer(edge.weight, 'edge.weight', 1, 100);
    if (u === v) throw new TypeError('self edges forbidden');
    const key = [u, v].sort((a, b) => a - b).join(':');
    if (seen.has(key)) throw new TypeError('duplicate undirected edge');
    seen.add(key);
    return { u, v, weight };
  });
  const gammas = array(input.gammas, 'gammas', 1, 4).map((v, i) => number(v, `gammas[${i}]`, -1000, 1000));
  const betas = array(input.betas, 'betas', gammas.length, gammas.length).map((v, i) => number(v, `betas[${i}]`, -1000, 1000));
  const size = 1 << n, costs = new Float64Array(size), real = new Float64Array(size), imag = new Float64Array(size);
  for (let mask = 0; mask < size; mask++) for (const { u, v, weight } of graph) {
    if (((mask >> u) & 1) !== ((mask >> v) & 1)) costs[mask] += weight;
  }
  real.fill(1 / Math.sqrt(size));
  for (let layer = 0; layer < gammas.length; layer++) {
    const gamma = gammas[layer], beta = betas[layer];
    // Diagonal e^{-i gamma C(z)} phase separator.
    for (let z = 0; z < size; z++) {
      const c = Math.cos(gamma * costs[z]), s = Math.sin(gamma * costs[z]);
      const r = real[z], i = imag[z];
      real[z] = c * r + s * i;
      imag[z] = c * i - s * r;
    }
    // e^{-i beta X} applied to each qubit by disjoint two-amplitude rotations.
    const c = Math.cos(beta), s = Math.sin(beta);
    for (let bit = 0; bit < n; bit++) for (let z = 0; z < size; z++) {
      const other = z ^ (1 << bit);
      if (z > other) continue;
      const a = real[z], b = imag[z], d = real[other], e = imag[other];
      real[z] = c * a + s * e;
      imag[z] = c * b - s * d;
      real[other] = c * d + s * b;
      imag[other] = c * e - s * a;
    }
  }
  const probabilities = Array.from({ length: size }, (_, z) => real[z] ** 2 + imag[z] ** 2);
  const normalization = probabilities.reduce((a, b) => a + b, 0);
  if (Math.abs(normalization - 1) > 1e-10) throw new Error('statevector lost normalization');
  const expectation = probabilities.reduce((acc, p, z) => acc + p * costs[z], 0);
  const optimum = Math.max(...costs);
  const distribution = probabilities.map((p, z) => ({ bitstring: z.toString(2).padStart(n, '0'), probability: p, cutValue: costs[z] }));
  distribution.sort((a, b) => b.probability - a.probability || a.bitstring.localeCompare(b.bitstring));
  return { engine: 'NEMESIS_LOCAL_QAOA_MAXCUT_V1', backend: 'CLASSICAL_STATEVECTOR', vertices: n, layers: gammas.length,
    normalization, expectedCut: expectation, maxCutByExhaustiveClassicalSearch: optimum, optimalBitstrings: distribution.filter(x => x.cutValue === optimum).map(x => x.bitstring).sort(),
    mostLikely: distribution[0], distribution, measuredShots: 0, trainedAngles: false,
    disclaimer: 'Ideal noiseless local statevector simulator. No quantum hardware, optimizer training, or guarantee of optimal MaxCut.' };
}
