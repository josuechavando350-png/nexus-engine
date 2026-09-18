import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runFinitePolynomialBank} from '../precision-bank/finite-polynomials-v1.mjs';
import {getGaussLayer} from '../core/registry.mjs';

test('independent precision bank: twelve finite-field polynomial operators', () => {
  const report = runFinitePolynomialBank();
  console.log(`GAUSS_PRECISION_BANK_V1=${JSON.stringify(report)}`);
  assert.equal(report.coveredOperators, 12);
  assert.equal(report.validCases, 1200);
  assert.equal(report.invalidCases, 36);
  assert.equal(report.failedValidCases, 0, JSON.stringify(report.failures));
  assert.equal(report.failedInvalidRejections, 0, JSON.stringify(report.failures));
});

test('independent precision bank rejects a deliberately defective oracle target', () => {
  const report = runFinitePolynomialBank({resolveLayer: id => id === 'GAUSS.MATH.FP_NORMALIZE.676'
    ? {execute: () => ({coefficients: [0]})}
    : getGaussLayer(id)});
  assert.ok(report.failedValidCases > 0, 'a broken implementation must fail visibly');
  assert.ok(report.failedInvalidRejections > 0, 'a broken implementation must not accept malformed inputs');
});

test('independent precision bank cases and report are deterministic', () => {
  const first = runFinitePolynomialBank();
  const second = runFinitePolynomialBank();
  assert.deepStrictEqual(first, second);
});
