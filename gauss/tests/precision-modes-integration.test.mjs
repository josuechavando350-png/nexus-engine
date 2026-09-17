import assert from 'node:assert/strict';
import test from 'node:test';
import { getGaussLayer, GAUSS_IMPLEMENTED_LAYERS } from '../core/registry.mjs';
import { gaussianLinearSolve, pivotedLogDeterminant } from '../core/layers/numerical-linear-algebra.mjs';

const solve = getGaussLayer('GAUSS.MATH.GAUSSIAN_SOLVE.005');
const determinant = getGaussLayer('GAUSS.MATH.PIVOTED_LOGDET.006');

test('exact integer determinant and exact rational solve coexist without changing legacy operator IDs or results', () => {
  assert.equal(GAUSS_IMPLEMENTED_LAYERS.length, 200);
  assert.equal(new Set(GAUSS_IMPLEMENTED_LAYERS.map(layer => layer.id)).size, 200);
  const coefficients = [[2, 1], [1, -1]];
  const rhs = [1, 0];
  assert.deepStrictEqual(solve.execute({coefficients, rhs}), gaussianLinearSolve({coefficients, rhs}));
  assert.deepStrictEqual(determinant.execute({coefficients}), pivotedLogDeterminant({coefficients}));
  const exactCoefficients = coefficients.map(row => row.map(String));
  const rational = solve.execute({mode: 'EXACT_RATIONAL', coefficients: exactCoefficients, rhs: rhs.map(String), decimalPlaces: 64});
  const integer = determinant.execute({mode: 'EXACT_INTEGER', coefficients: exactCoefficients});
  assert.equal(integer.determinant, '-3');
  assert.deepStrictEqual(rational.solution.map(value => [value.numerator, value.denominator]), [['1', '3'], ['1', '3']]);
  assert.throws(() => solve.execute({mode: 'EXACT_INTEGER', coefficients: exactCoefficients, rhs: rhs.map(String)}), /unsupported/u);
  assert.throws(() => determinant.execute({mode: 'EXACT_RATIONAL', coefficients: exactCoefficients}), /unsupported/u);
});

test('independent Cramer oracle checks both precision modes on 120 deterministic 2x2 systems', () => {
  let state = 0x79bc5a0f;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return BigInt(state % 13) - 6n; };
  let verified = 0;
  for (let i = 0; i < 120; i++) {
    const [a, b, c, d, e, f] = Array.from({length: 6}, next);
    const expectedDet = a * d - b * c;
    if (expectedDet === 0n) continue;
    const coefficients = [[a.toString(), b.toString()], [c.toString(), d.toString()]];
    const actualDet = determinant.execute({mode: 'EXACT_INTEGER', coefficients});
    assert.equal(actualDet.determinant, expectedDet.toString(), `determinant case ${i}`);
    const actual = solve.execute({mode: 'EXACT_RATIONAL', coefficients, rhs: [e.toString(), f.toString()], decimalPlaces: 32});
    const numerators = [e * d - b * f, a * f - e * c];
    for (let j = 0; j < 2; j++) {
      const entry = actual.solution[j];
      assert.equal(BigInt(entry.numerator) * expectedDet, numerators[j] * BigInt(entry.denominator), `Cramer case ${i}, column ${j}`);
      assert(BigInt(entry.denominator) > 0n);
    }
    verified++;
  }
  assert(verified >= 80, 'insufficient nonsingular cross-checked systems');
});
