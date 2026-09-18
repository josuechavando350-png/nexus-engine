/** AXIOMA: fail-closed independent GAUSS accuracy observations (never a universal claim). */
import assert from 'node:assert/strict';
import {runFinitePolynomialBank} from '../precision-bank/finite-polynomials-v1.mjs';
import {runPermutationBank} from './permutations-v1.mjs';
import {runNumberTheoryBank} from './number-theory-v1.mjs';

export function runAxioma({resolveLayer} = {}) {
  const options = resolveLayer ? {resolveLayer} : {};
  const suites = [runFinitePolynomialBank(options), runPermutationBank(options), runNumberTheoryBank(options)];
  const seen = new Set();
  for (const suite of suites) {
    assert.equal(suite.registryOperators, 1000, 'AXIOMA registry count mismatch');
    for (const item of suite.operatorResults) {
      assert.ok(!seen.has(item.id), `AXIOMA operator counted twice: ${item.id}`);
      seen.add(item.id);
    }
    assert.equal(suite.coveredOperators, suite.operatorResults.length, 'AXIOMA suite coverage mismatch');
    assert.equal(suite.validCases, suite.passedValidCases + suite.failedValidCases, 'AXIOMA valid-case denominator mismatch');
    assert.equal(suite.invalidCases, suite.passedInvalidRejections + suite.failedInvalidRejections, 'AXIOMA invalid-case denominator mismatch');
  }
  const sum = key => suites.reduce((total, suite) => total + suite[key], 0);
  const coveredOperators = seen.size;
  const report = {
    schemaVersion: 1,
    bank: 'AXIOMA',
    subject: 'GAUSS integration branch, exact bounded reference comparisons',
    registryOperators: 1000,
    coveredOperators,
    untestedOperators: 1000 - coveredOperators,
    coverageRate: coveredOperators / 1000,
    validCases: sum('validCases'),
    passedValidCases: sum('passedValidCases'),
    failedValidCases: sum('failedValidCases'),
    invalidCases: sum('invalidCases'),
    passedInvalidRejections: sum('passedInvalidRejections'),
    failedInvalidRejections: sum('failedInvalidRejections'),
    validPassRate: sum('validCases') ? sum('passedValidCases') / sum('validCases') : null,
    invalidRejectionRate: sum('invalidCases') ? sum('passedInvalidRejections') / sum('invalidCases') : null,
    precisionClaim: 'Only the evaluated inputs of the named exact operators; no universal accuracy, no approximate-operator tolerance claim',
    suites: suites.map(suite => ({
      subject: suite.subject ?? suite.domain,
      seed: suite.seed,
      oracle: suite.oracle,
      caseDigest: suite.caseDigest,
      coveredOperators: suite.coveredOperators,
      validCases: suite.validCases,
      passedValidCases: suite.passedValidCases,
      failedValidCases: suite.failedValidCases,
      invalidCases: suite.invalidCases,
      passedInvalidRejections: suite.passedInvalidRejections,
      failedInvalidRejections: suite.failedInvalidRejections,
      operatorResults: suite.operatorResults,
      failures: suite.failures,
    })),
  };
  assert.equal(report.coveredOperators + report.untestedOperators, 1000);
  return report;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const report = runAxioma();
  console.log(JSON.stringify(report, null, 2));
  if (report.failedValidCases || report.failedInvalidRejections) process.exitCode = 1;
}
