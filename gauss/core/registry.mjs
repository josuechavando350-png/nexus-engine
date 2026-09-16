// The immutable audited foundation is retained byte-for-byte in registry-foundation.mjs.
// Additional scientific operators are appended here without altering its implementation.
import { deepFreeze } from './common.mjs';
import {
  GAUSS_DOMAINS,
  GAUSS_IMPLEMENTED_LAYERS as foundationLayers,
} from './registry-foundation.mjs';
import {
  extendedEuclidean, modularInverse, pairwiseCoprimeChineseRemainder,
  modularExponentiation, trialDivisionFactorization, eulerTotient,
  deterministicSafeIntegerPrimality, boundedPrimeSieve, exactIntegerSquareRoot,
  exactBinomialCoefficient, exactFibonacciFastDoubling, exactIntegerPartitionCount,
} from './layers/number-theory.mjs';

export { GAUSS_DOMAINS };

const additions = [
  ['GAUSS.MATH.EXTENDED_EUCLID.010', 'MATHEMATICS', 'Bounded exact greatest common divisor with Bezout identity certificate', extendedEuclidean],
  ['GAUSS.MATH.MODULAR_INVERSE.011', 'MATHEMATICS', 'Exact modular inverse over a coprime integer modulus', modularInverse],
  ['GAUSS.MATH.CRT_COPRIME.012', 'MATHEMATICS', 'Exact bounded Chinese remainder solution for pairwise coprime moduli', pairwiseCoprimeChineseRemainder],
  ['GAUSS.MATH.MODULAR_EXPONENT.013', 'MATHEMATICS', 'Exact binary modular exponentiation using BigInt intermediates', modularExponentiation],
  ['GAUSS.MATH.PRIME_FACTORIZATION.014', 'MATHEMATICS', 'Exact bounded prime factorization with multiplicities', trialDivisionFactorization],
  ['GAUSS.MATH.EULER_TOTIENT.015', 'MATHEMATICS', 'Euler totient by distinct prime factors of a bounded integer', eulerTotient],
  ['GAUSS.MATH.PRIMALITY_SAFE_INT.016', 'MATHEMATICS', 'Deterministic Miller-Rabin primality for IEEE-754 safe integers', deterministicSafeIntegerPrimality],
  ['GAUSS.MATH.PRIME_SIEVE.017', 'MATHEMATICS', 'Bounded sieve of Eratosthenes yielding the full prime list', boundedPrimeSieve],
  ['GAUSS.MATH.INTEGER_SQRT.018', 'MATHEMATICS', 'Exact floor square root with remainder witness for safe integers', exactIntegerSquareRoot],
  ['GAUSS.MATH.BINOMIAL_EXACT.019', 'MATHEMATICS', 'Exact binomial coefficient with a decimal BigInt result', exactBinomialCoefficient],
  ['GAUSS.MATH.FIBONACCI_DOUBLING.020', 'MATHEMATICS', 'Exact bounded Fibonacci number by fast doubling', exactFibonacciFastDoubling],
  ['GAUSS.MATH.INTEGER_PARTITIONS.021', 'MATHEMATICS', 'Exact bounded unrestricted integer partition count', exactIntegerPartitionCount],
];

const domainIds = new Set(GAUSS_DOMAINS.map(domain => domain.id));
const ids = new Set(foundationLayers.map(layer => layer.id));
export const GAUSS_IMPLEMENTED_LAYERS = deepFreeze([
  ...foundationLayers,
  ...additions.map(([id, domain, description, execute]) => {
    if (ids.has(id)) throw new Error(`duplicate GAUSS layer id:${id}`);
    if (!domainIds.has(domain)) throw new Error(`unknown GAUSS domain:${domain}`);
    if (typeof execute !== 'function') throw new Error(`GAUSS layer is not executable:${id}`);
    ids.add(id);
    return { id, domain, description, execute };
  }),
]);
const byId = new Map(GAUSS_IMPLEMENTED_LAYERS.map(layer => [layer.id, layer]));
export function getGaussLayer(layerId) { return byId.get(layerId) ?? null; }
export function gaussRegistrySummary() {
  const implementedByDomain = Object.fromEntries(GAUSS_DOMAINS.map(domain => [domain.id, 0]));
  for (const layer of GAUSS_IMPLEMENTED_LAYERS) implementedByDomain[layer.domain] += 1;
  return deepFreeze({
    targetLayerCount: GAUSS_DOMAINS.reduce((sum, domain) => sum + domain.targetLayers, 0),
    implementedLayerCount: GAUSS_IMPLEMENTED_LAYERS.length,
    implementedByDomain,
    domains: GAUSS_DOMAINS,
  });
}
