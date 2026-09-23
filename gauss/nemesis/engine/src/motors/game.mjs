import { object, array, rational, sub, add, mul, div, cmp, fmt, ZERO, ONE } from './shared.mjs';

/** Enumerates every pure Nash equilibrium, plus strictly interior mixed equilibrium of nondegenerate 2x2 games. */
export function solveBimatrixGame(input) {
  object(input, 'game', ['rowPayoffs', 'columnPayoffs']);
  const rows = array(input.rowPayoffs, 'rowPayoffs', 2, 8);
  const cols = array(input.columnPayoffs, 'columnPayoffs', rows.length, rows.length);
  const width = array(rows[0], 'rowPayoffs[0]', 2, 8).length;
  const parse = (matrix, name) => matrix.map((row, i) => array(row, `${name}[${i}]`, width, width)
    .map((entry, j) => rational(entry, `${name}[${i}][${j}]`)));
  const A = parse(rows, 'rowPayoffs'), B = parse(cols, 'columnPayoffs');
  const pureEquilibria = [];
  for (let i = 0; i < rows.length; i++) for (let j = 0; j < width; j++) {
    const rowBest = A.every(row => cmp(A[i][j], row[j]) >= 0);
    const columnBest = B[i].every(payoff => cmp(B[i][j], payoff) >= 0);
    if (rowBest && columnBest) pureEquilibria.push({ row: i, column: j, rowPayoff: fmt(A[i][j]), columnPayoff: fmt(B[i][j]) });
  }
  let interiorMixed = null;
  let mixedScope = 'NOT_COMPUTED_FOR_GENERAL_GAME';
  if (rows.length === 2 && width === 2) {
    // Column plays column 0 with probability q, making row player indifferent.
    const dq = add(sub(A[0][0], A[0][1]), sub(A[1][1], A[1][0]));
    // Row plays row 0 with probability p, making column player indifferent.
    const dp = add(sub(B[0][0], B[1][0]), sub(B[1][1], B[0][1]));
    if (dq[0] !== 0n && dp[0] !== 0n) {
      const q = div(sub(A[1][1], A[0][1]), dq);
      const p = div(sub(B[1][1], B[1][0]), dp);
      if (cmp(q, ZERO) > 0 && cmp(q, ONE) < 0 && cmp(p, ZERO) > 0 && cmp(p, ONE) < 0) {
        const rowPayoff = add(mul(q, A[0][0]), mul(sub(ONE, q), A[0][1]));
        const columnPayoff = add(mul(p, B[0][0]), mul(sub(ONE, p), B[1][0]));
        interiorMixed = { rowStrategy: [fmt(p), fmt(sub(ONE, p))], columnStrategy: [fmt(q), fmt(sub(ONE, q))], rowPayoff: fmt(rowPayoff), columnPayoff: fmt(columnPayoff) };
      }
      mixedScope = 'ALL_STRICTLY_INTERIOR_NONDEGENERATE_2X2_EQUILIBRIA';
    } else mixedScope = 'DEGENERATE_2X2_MIXED_EQUILIBRIA_NOT_ENUMERATED';
  }
  return { engine: 'NEMESIS_FINITE_NASH_V1', players: 2, strategies: [rows.length, width], pureEquilibria, interiorMixed, mixedScope,
    disclaimer: 'All pure equilibria are exhaustive. Mixed equilibria for larger or degenerate games are not enumerated.' };
}
