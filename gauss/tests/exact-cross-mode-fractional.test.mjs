import test from 'node:test';
import assert from 'node:assert/strict';
import { solveExactLinearSystem } from '../core/precision/exact-linear.mjs';
import { exactIntegerDeterminant } from '../core/precision/exact-integer-determinant.mjs';

// Leibniz formula deliberately avoids both GAUSS elimination implementations.
function permutationDeterminant(matrix) {
  let sum = 0n;
  function visit(row, taken, sign, product) {
    if (row === matrix.length) { sum += sign * product; return; }
    for (let j = 0; j < matrix.length; j++) {
      if (taken.includes(j)) continue;
      const inversions = taken.filter(previous => previous > j).length;
      visit(row + 1, [...taken, j], inversions % 2 ? -sign : sign, product * matrix[row][j]);
    }
  }
  visit(0, [], 1n, 1n);
  return sum;
}

test('fractional 3x3/4x4 systems and integer determinants agree with an independent permutation oracle', () => {
  let state = 0x5e12cafe;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  let verified = 0;
  let exchanged = 0;
  for (let caseNumber = 0; caseNumber < 100; caseNumber++) {
    const n = caseNumber % 2 === 0 ? 3 : 4;
    const matrix = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) =>
      i === j ? BigInt(11 + next() % 7) : BigInt(next() % 9) - 4n));
    if (caseNumber % 3 === 0) {
      matrix[0][0] = 0n;
      matrix[0][1] = 1n;
      matrix[1][0] = 1n;
    }
    const expected = permutationDeterminant(matrix);
    if (expected === 0n) continue;
    const integerCoefficients = matrix.map(row => row.map(String));
    const determinant = exactIntegerDeterminant({ mode: 'EXACT_INTEGER', coefficients: integerCoefficients });
    assert.equal(determinant.determinant, expected.toString(), `determinant case ${caseNumber}`);
    const fractionalCoefficients = matrix.map(row => row.map(value => `${value}/7`));
    const rhs = matrix.map(row => `${row.reduce((sum, value, j) => sum + value * BigInt(j + 1), 0n)}/77`);
    const result = solveExactLinearSystem({
      mode: 'EXACT_RATIONAL', coefficients: fractionalCoefficients, rhs, decimalPlaces: 128,
    });
    assert.equal(result.exactResidualVerified, true);
    for (let j = 0; j < n; j++) {
      const value = result.solution[j];
      assert.equal(BigInt(value.numerator) * 11n, BigInt(j + 1) * BigInt(value.denominator),
        `fractional solution case ${caseNumber} component ${j}`);
      assert.match(value.decimal, /^-?\d+\.\d{128}$/u);
    }
    if (caseNumber % 3 === 0) {
      assert(result.pivotExchanges > 0, `zero initial pivot was not exchanged in case ${caseNumber}`);
      exchanged++;
    }
    verified++;
  }
  assert(verified >= 95, 'insufficient nonsingular independently verified cases');
  assert(exchanged >= 30, 'insufficient pivot exchange cases');
});
