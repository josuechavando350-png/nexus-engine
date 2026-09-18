import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runPermutationBank} from '../axioma/permutations-v1.mjs';
import {runAxioma} from '../axioma/run.mjs';
import {getGaussLayer,GAUSS_IMPLEMENTED_LAYERS} from '../core/registry.mjs';

test('AXIOMA: 25 bounded permutation operators against exhaustive independent S_n references', () => {
  const report = runPermutationBank();
  assert.equal(report.coveredOperators, 25);
  assert.equal(report.validCases, 2500);
  assert.equal(report.passedValidCases, 2500, JSON.stringify(report.failures));
  assert.equal(report.invalidCases, 75);
  assert.equal(report.passedInvalidRejections, 75, JSON.stringify(report.failures));
  assert.equal(report.failedValidCases, 0);
  assert.equal(report.failedInvalidRejections, 0);
  console.log(`AXIOMA_PERMUTATIONS_V1=${JSON.stringify({coveredOperators: report.coveredOperators, validCases: report.validCases, passedValidCases: report.passedValidCases, invalidCases: report.invalidCases, passedInvalidRejections: report.passedInvalidRejections, caseDigest: report.caseDigest})}`);
});

test('AXIOMA rejects a broken permutation implementation and malformed data acceptance', () => {
  const report = runPermutationBank({resolveLayer: id => id === 'GAUSS.MATH.PERM_INVERSE.526'
    ? {execute: () => ({permutation: [0]})}
    : getGaussLayer(id)});
  assert.ok(report.failedValidCases > 0);
  assert.ok(report.failedInvalidRejections > 0);
});

test('AXIOMA reports exactly 823 unique reference-checked operators, not the other 177', () => {
  const report = runAxioma();
  const ids=report.suites.flatMap(suite=>suite.operatorResults.map(operator=>operator.id));
  const registry=new Set(GAUSS_IMPLEMENTED_LAYERS.map(layer=>layer.id));
  assert.equal(ids.length,new Set(ids).size,'no duplicated operator may inflate coverage');
  assert.ok(ids.every(id=>registry.has(id)),'every verified ID must belong to actual GAUSS registry');
  assert.equal(report.coveredOperators, 823);
  assert.equal(report.untestedOperators, 177);
  assert.equal(report.validCases, 82300);
  assert.equal(report.passedValidCases, 82300, JSON.stringify(report.suites.flatMap(s => s.failures)));
  assert.equal(report.invalidCases, 2469);
  assert.equal(report.passedInvalidRejections, 2469, JSON.stringify(report.suites.flatMap(s=>s.failures)));
  assert.equal(report.failedValidCases, 0);
  assert.equal(report.failedInvalidRejections, 0);
  assert.equal(report.validPassRate, 1);
  assert.equal(report.coverageRate, 0.823);
  assert.notEqual(report.coverageRate, report.validPassRate);
  assert.equal(report.suites.length,38);
  assert.deepStrictEqual(report, runAxioma(), 'same SHA, seed, and cases must reproduce bit-for-bit');
  console.log(`AXIOMA_V1=${JSON.stringify({coveredOperators: report.coveredOperators, untestedOperators: report.untestedOperators, coverageRate: report.coverageRate, validCases: report.validCases, passedValidCases: report.passedValidCases, invalidCases: report.invalidCases, passedInvalidRejections: report.passedInvalidRejections, suites: report.suites.map(s => ({subject: s.subject, caseDigest: s.caseDigest}))})}`);
});
