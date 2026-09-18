import test from 'node:test';
import assert from 'node:assert/strict';
import { exactIntegerPolynomialResultant as resultant } from '../core/layers/integer-polynomial-resultant.mjs';

// Independent Leibniz determinant oracle: never calls the Bareiss implementation.
function referenceResultant(f, g) {
  const m = f.length - 1, n = g.length - 1, size = m + n;
  const a = Array.from({ length: size }, () => Array(size).fill(0n));
  for (let i = 0; i < n; i++) for (let j = 0; j <= m; j++) a[i][i + j] = BigInt(f[m - j]);
  for (let i = 0; i < m; i++) for (let j = 0; j <= n; j++) a[n + i][i + j] = BigInt(g[n - j]);
  let total = 0n;
  function permutations(row, used, product, parity) {
    if (row === size) { total += parity * product; return; }
    for (let j = 0; j < size; j++) {
      if (used.includes(j)) continue;
      const inversions = used.filter((previous) => previous > j).length;
      permutations(row + 1, [...used, j], product * a[row][j], inversions % 2 ? -parity : parity);
    }
  }
  permutations(0, [], 1n, 1n);
  return total;
}

test('resultant of two linear polynomials and independent root-evaluation oracle', () => {
  assert.equal(resultant({ left: [3, 2], right: [5, 4] }).resultant, '-2');
  assert.equal(resultant({ left: [-2, 1], right: [1, 0, 1] }).resultant, '5');
  assert.equal(resultant({ left: [-2, 1], right: [-6, 1, 1] }).commonComplexRoot, true);
  assert.equal(resultant({ left: [1, 1], right: [1, 1] }).resultant, '0');
});

test('80 independent seeded Leibniz oracles for degrees 1..3', () => {
  let seed = 0x5a17c9e3;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let attempt = 0; attempt < 80; attempt++) {
    const m = 1 + random() % 3, n = 1 + random() % 3;
    const f = Array.from({ length: m + 1 }, () => Number(random() % 11) - 5);
    const g = Array.from({ length: n + 1 }, () => Number(random() % 11) - 5);
    if (f.at(-1) === 0) f[m] = 1;
    if (g.at(-1) === 0) g[n] = -1;
    const reference = referenceResultant(f, g);
    assert.equal(BigInt(resultant({ left: f, right: g }).resultant), reference, `case ${attempt}`);
    const swapped = BigInt(resultant({ left: g, right: f }).resultant);
    assert.equal(swapped, (m * n) % 2 ? -reference : reference);
  }
});

test('exact 40-digit integers, malformed input, and bounded work', () => {
  const large = '9999999999999999999999999999999999999999';
  assert.equal(resultant({ left: [large, 1], right: [1, 1] }).resultant, (1n - BigInt(large)).toString());
  for (const invalid of [[], [1], [1, 0], [1, 1.5], [1, Number.MAX_SAFE_INTEGER + 1], [1, '01'], [1, '-0'], [1, '1'.repeat(41)], [1, null], Array(8).fill(1)]) {
    assert.throws(() => resultant({ left: invalid, right: [1, 1] }));
  }
});
