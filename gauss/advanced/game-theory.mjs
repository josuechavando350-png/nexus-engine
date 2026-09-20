import { assertArray, assertExactKeys, assertSafeInteger } from '../core/common.mjs';
import { add, asString, fraction, mul, ONE, sub } from './rational.mjs';

const PAYOFF_LIMIT = 1_000_000;

function matrix(value, label) {
  const rows = assertArray(value, label, { min: 2, max: 8 });
  if (!Object.hasOwn(rows, 0)) throw new TypeError(`${label} must be dense`);
  const columns = assertArray(rows[0], `${label}[0]`, { min: 2, max: 8 }).length;
  return rows.map((row, i) => {
    if (!Object.hasOwn(rows, i)) throw new TypeError(`${label} must be dense`);
    if (!Array.isArray(row) || row.length !== columns) throw new TypeError(`${label} must be rectangular`);
    return Array.from({ length: columns }, (_, j) => {
      if (!Object.hasOwn(row, j)) throw new TypeError(`${label} must be dense`);
      return assertSafeInteger(row[j], `${label}[${i}][${j}]`, { min: -PAYOFF_LIMIT, max: PAYOFF_LIMIT });
    });
  });
}

function interior(num, denominator) {
  if (denominator === 0n) return null;
  const p = fraction(num, denominator);
  return p.n > 0n && p.n < p.d ? p : null;
}

/** Exhaustive pure Nash and a nondegenerate interior mixed equilibrium for 2x2 bimatrix games. */
export function solveFiniteBimatrixGame(input) {
  assertExactKeys(input, ['rowPayoffs', 'columnPayoffs'], 'bimatrix game');
  const a = matrix(input.rowPayoffs, 'rowPayoffs');
  const b = matrix(input.columnPayoffs, 'columnPayoffs');
  const m = a.length;
  const n = a[0].length;
  if (b.length !== m || b[0].length !== n) throw new TypeError('payoff matrix dimensions must match');
  const pureEquilibria = [];
  for (let row = 0; row < m; row++) {
    for (let column = 0; column < n; column++) {
      const rowBest = a.every((other) => a[row][column] >= other[column]);
      const columnBest = b[row].every((payoff) => b[row][column] >= payoff);
      if (rowBest && columnBest) pureEquilibria.push({ row, column, rowPayoff: a[row][column], columnPayoff: b[row][column] });
    }
  }
  let interiorMixedEquilibrium = null;
  if (m === 2 && n === 2) {
    // Column indifference determines row's mixing probability; row indifference determines column's.
    const p = interior(BigInt(b[1][1] - b[1][0]), BigInt(b[0][0] - b[0][1] - b[1][0] + b[1][1]));
    const q = interior(BigInt(a[1][1] - a[0][1]), BigInt(a[0][0] - a[0][1] - a[1][0] + a[1][1]));
    if (p && q) {
      function expectation(payoffs) {
        const top = add(mul(q, fraction(BigInt(payoffs[0][0]))), mul(sub(ONE, q), fraction(BigInt(payoffs[0][1]))));
        const bottom = add(mul(q, fraction(BigInt(payoffs[1][0]))), mul(sub(ONE, q), fraction(BigInt(payoffs[1][1]))));
        return asString(add(mul(p, top), mul(sub(ONE, p), bottom)));
      }
      interiorMixedEquilibrium = {
        rowStrategy: [asString(p), asString(sub(ONE, p))],
        columnStrategy: [asString(q), asString(sub(ONE, q))],
        expectedRowPayoff: expectation(a),
        expectedColumnPayoff: expectation(b),
      };
    }
  }
  return {
    arithmetic: 'EXACT_RATIONAL',
    game: 'FINITE_TWO_PLAYER_NORMAL_FORM',
    evaluatedPureProfiles: m * n,
    pureEquilibria,
    pureEquilibriaComplete: true,
    interiorMixedEquilibrium,
    mixedEquilibriaComplete: false,
    note: 'Pure equilibria exhaustively enumerated. Only nondegenerate strictly interior 2x2 mixed equilibria are computed; boundary/degenerate and larger mixed equilibria are NOT enumerated.',
  };
}
