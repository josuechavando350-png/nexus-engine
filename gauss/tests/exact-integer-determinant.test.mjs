import test from 'node:test';
import assert from 'node:assert/strict';
import { exactIntegerDeterminant } from '../core/precision/exact-integer-determinant.mjs';

const run = matrix => exactIntegerDeterminant({ mode: 'EXACT_INTEGER', coefficients: matrix });
// Independent Leibniz permutation oracle: no shared elimination code.
function permutationDeterminant(matrix) {
  const n = matrix.length;
  let result = 0n;
  function visit(row, chosen, parity, product) {
    if (row === n) { result += parity * product; return; }
    for (let col = 0; col < n; col++) {
      if (chosen.includes(col)) continue;
      const inversions = chosen.reduce((sum, prior) => sum + Number(prior > col), 0);
      visit(row + 1, [...chosen, col], inversions % 2 ? -parity : parity, product * BigInt(matrix[row][col]));
    }
  }
  visit(0, [], 1n, 1n);
  return result;
}

test('exact integer determinant preserves huge integers, signs and singularity', () => {
  assert.equal(run([['2', '3'], ['5', '7']]).determinant, '-1');
  assert.equal(run([['0', '1'], ['1', '0']]).determinant, '-1');
  assert.equal(run([['0', '0'], ['0', '0']]).determinant, '0');
  assert.equal(run([['2', '4'], ['3', '6']]).singular, true);
  assert.equal(run([['-7']]).determinant, '-7');
  const huge = '9'.repeat(100);
  assert.equal(run([[huge, '0'], ['0', huge]]).determinant, (BigInt(huge) ** 2n).toString());
  assert.equal(run(Array.from({ length: 24 }, (_, i) => Array.from({ length: 24 }, (_, j) => i === j ? '3' : '0'))).determinant, (3n ** 24n).toString());
});

test('Bareiss determinant equals independently enumerated permutations in 200 seeded integer matrices', () => {
  let state = 0x55aa11cc;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  for (let caseNumber = 0; caseNumber < 200; caseNumber++) {
    const n = 1 + (caseNumber % 5);
    const matrix = Array.from({ length: n }, () => Array.from({ length: n }, () => String(Number(next() % 13) - 6)));
    const expected = permutationDeterminant(matrix);
    const result = run(matrix);
    assert.equal(result.determinant, expected.toString(), `case ${caseNumber}`);
    assert.equal(result.singular, expected === 0n, `case ${caseNumber}`);
  }
});

test('exact determinant rejects malformed and pre-rounded inputs instead of giving false precision', () => {
  assert.throws(() => run([[1.5]]), /pre-rounded/u);
  assert.throws(() => run([[Number.MAX_SAFE_INTEGER + 1]]), /pre-rounded/u);
  assert.throws(() => run([['01']]), /canonical/u);
  assert.throws(() => run([['-0']]), /canonical/u);
  assert.throws(() => run([['1e2']]), /canonical/u);
  assert.throws(() => run([['1', '2']]), /square/u);
  assert.throws(() => run(Array.from({ length: 25 }, () => Array(25).fill('0'))), /1\.\.24/u);
  assert.throws(() => run([['9'.repeat(257)]]), /bounded/u);
  assert.throws(() => exactIntegerDeterminant({ mode: 'EXACT_INTEGER', coefficients: [['1']], fake: true }), /declared/u);
});
