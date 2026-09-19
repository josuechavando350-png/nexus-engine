import { assertExactKeys, assertSafeInteger, assertArray, assertFiniteNumber } from '../core/common.mjs';

/** Discrete-time unitary Hadamard coined quantum walk on a periodic cycle. No QPU used. */
export function simulateCoinedQuantumWalk(input) {
  assertExactKeys(input, ['sites', 'steps', 'initialSite', 'coinState'], 'coined quantum walk');
  const sites = assertSafeInteger(input.sites, 'sites', { min: 3, max: 1024 });
  const steps = assertSafeInteger(input.steps, 'steps', { min: 0, max: 10_000 });
  const at = assertSafeInteger(input.initialSite, 'initialSite', { min: 0, max: sites - 1 });
  const coin = assertArray(input.coinState, 'coinState', { min: 4, max: 4 });
  if (coin.some((_, i) => !Object.hasOwn(coin, i))) throw new TypeError('coinState must be dense');
  const [r0, i0, r1, i1] = coin.map((v, i) => assertFiniteNumber(v, `coinState[${i}]`, { min: -1, max: 1 }));
  const initNorm = r0 * r0 + i0 * i0 + r1 * r1 + i1 * i1;
  if (Math.abs(initNorm - 1) > 1e-12) throw new TypeError('coinState must have squared norm one');
  // Layout [site,coin] for both real/imaginary arrays; Hadamard coin then conditional shift.
  let re = new Float64Array(sites * 2), im = new Float64Array(sites * 2);
  re[2 * at] = r0; im[2 * at] = i0; re[2 * at + 1] = r1; im[2 * at + 1] = i1;
  const invSqrt2 = Math.SQRT1_2;
  for (let t = 0; t < steps; t++) {
    const nr = new Float64Array(sites * 2), ni = new Float64Array(sites * 2);
    for (let x = 0; x < sites; x++) {
      const a = x * 2, left = ((x - 1 + sites) % sites) * 2, right = ((x + 1) % sites) * 2 + 1;
      nr[left] += (re[a] + re[a + 1]) * invSqrt2;
      ni[left] += (im[a] + im[a + 1]) * invSqrt2;
      nr[right] += (re[a] - re[a + 1]) * invSqrt2;
      ni[right] += (im[a] - im[a + 1]) * invSqrt2;
    }
    re = nr; im = ni;
  }
  const positionProbabilities = Array.from({ length: sites }, (_, x) => {
    const j = 2 * x;
    return re[j] ** 2 + im[j] ** 2 + re[j + 1] ** 2 + im[j + 1] ** 2;
  });
  const norm = positionProbabilities.reduce((s, p) => s + p, 0);
  if (Math.abs(norm - 1) > 1e-9) throw new Error('statevector norm drift exceeds numerical tolerance');
  const coinProbabilities = [0, 1].map(c => {
    let p = 0;
    for (let x = 0; x < sites; x++) p += re[2 * x + c] ** 2 + im[2 * x + c] ** 2;
    return p;
  });
  return { positionProbabilities, coinProbabilities, norm, normError: Math.abs(norm - 1),
    sites, steps, model: 'UNITARY_COINED_HADAMARD_CYCLE_CLASSICAL_SIMULATION', physicalQpuExecution: false,
    note: 'Classical statevector simulation of a specified quantum walk; numerical roundoff is reported, not a hardware experiment.' };
}
