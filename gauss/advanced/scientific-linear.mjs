import { assertArray, assertSafeInteger } from '../core/common.mjs';
import { add, div, mul, sub, ZERO } from './rational.mjs';

export const cmp = (a, b) => a.n * b.d - b.n * a.d;

export function boundedInt(value, label) {
  return assertSafeInteger(value, label, { min: -1_000_000, max: 1_000_000 });
}
export function dense(value, label, min = 1, max = 8) {
  const list = assertArray(value, label, { min, max });
  for (let i = 0; i < list.length; i++) if (!Object.hasOwn(list, i)) throw new TypeError(`${label} must be dense`);
  return list;
}

/** Gaussian elimination with pivoting in exact rational arithmetic. */
export function solveLinear(matrix, rhs) {
  const n = matrix.length;
  if (!n || rhs.length !== n || matrix.some((row) => row.length !== n)) throw new TypeError('linear system dimensions mismatch');
  const a = matrix.map((row, i) => [...row, rhs[i]]);
  for (let k = 0; k < n; k++) {
    const pivot = a.findIndex((row, i) => i >= k && row[k].n !== 0n);
    if (pivot === -1) throw new RangeError('singular exact linear system');
    [a[k], a[pivot]] = [a[pivot], a[k]];
    const scale = a[k][k];
    for (let j = k; j <= n; j++) a[k][j] = div(a[k][j], scale);
    for (let i = 0; i < n; i++) if (i !== k) {
      const factor = a[i][k];
      for (let j = k; j <= n; j++) a[i][j] = sub(a[i][j], mul(factor, a[k][j]));
    }
  }
  const x = a.map((row) => row[n]);
  for (let i = 0; i < n; i++) {
    const residual = matrix[i].reduce((sum, term, j) => add(sum, mul(term, x[j])), ZERO);
    if (cmp(residual, rhs[i]) !== 0n) throw new Error('exact linear system residual mismatch');
  }
  return x;
}
