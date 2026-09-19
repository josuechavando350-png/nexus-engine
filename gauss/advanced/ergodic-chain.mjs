import { assertExactKeys } from '../core/common.mjs';
import { add, asString, mul, ONE, probability, sub, ZERO } from './rational.mjs';
import { cmp, dense, solveLinear } from './scientific-linear.mjs';

function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }

/** Finite Markov irreducibility, exact period and exact unique invariant measure. */
export function certifyFiniteErgodicity(input) {
  assertExactKeys(input, ['transition'], 'ergodic-chain input');
  const rows = dense(input.transition, 'transition', 2, 8);
  const n = rows.length;
  const p = rows.map((row, i) => {
    const probabilities = dense(row, `transition[${i}]`, n, n).map((v, j) => probability(v, `transition[${i}][${j}]`));
    if (cmp(probabilities.reduce(add, ZERO), ONE) !== 0n) throw new TypeError('each transition row must sum exactly to one');
    return probabilities;
  });
  const neighbors = p.map((row) => row.flatMap((v, i) => v.n ? [i] : []));
  function traverse(from, backwards = false) {
    const seen = new Set([from]), queue = [from];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const node = queue[cursor];
      const adj = backwards ? Array.from({ length: n }, (_, i) => i).filter((i) => neighbors[i].includes(node)) : neighbors[node];
      for (const next of adj) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    return seen.size === n;
  }
  const irreducible = traverse(0) && traverse(0, true);
  if (!irreducible) return { irreducible: false, aperiodic: null, ergodic: false, period: null,
    stationary: null, stationaryUniqueness: 'NOT_ASSERTED', method: 'FINITE_COMMUNICATING_CLASS_CHECK',
    note: 'The chain is reducible. An invariant distribution may exist or be unique, but this algorithm does not assert one.' };
  const levels = Array(n).fill(-1), queue = [0]; levels[0] = 0;
  for (let i = 0; i < queue.length; i++) for (const j of neighbors[queue[i]]) {
    if (levels[j] === -1) { levels[j] = levels[queue[i]] + 1; queue.push(j); }
  }
  let period = 0;
  for (let i = 0; i < n; i++) for (const j of neighbors[i]) period = gcd(period, Math.abs(levels[i] + 1 - levels[j]));
  if (period < 1) throw new Error('irreducible chain has invalid period');
  const a = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) =>
    i === n - 1 ? ONE : sub(p[j][i], i === j ? ONE : ZERO)));
  const rhs = Array.from({ length: n }, (_, i) => i === n - 1 ? ONE : ZERO);
  const stationary = solveLinear(a, rhs);
  if (cmp(stationary.reduce(add, ZERO), ONE) !== 0n || stationary.some((value) => value.n <= 0n)) throw new Error('invalid exact invariant measure');
  for (let j = 0; j < n; j++) {
    const mass = stationary.reduce((total, value, i) => add(total, mul(value, p[i][j])), ZERO);
    if (cmp(mass, stationary[j]) !== 0n) throw new Error('stationary vector failed exact invariance');
  }
  return { irreducible: true, aperiodic: period === 1, ergodic: period === 1, period,
    stationary: stationary.map(asString), stationaryUniqueness: 'UNIQUE_FOR_FINITE_IRREDUCIBLE_CHAIN',
    method: 'EXACT_FINITE_MARKOV_PERIOD_AND_STATIONARY',
    note: 'An irreducible periodic chain has a unique stationary distribution but powers of its transition matrix need not converge.' };
}
