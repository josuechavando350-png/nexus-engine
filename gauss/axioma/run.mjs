/** AXIOMA: bounded independent mathematical references, never a universal precision claim. */
import assert from 'node:assert/strict';
import {runFinitePolynomialBank} from '../precision-bank/finite-polynomials-v1.mjs';
import {runPermutationBank} from './permutations-v1.mjs';
import {runNumberTheoryBank} from './number-theory-v1.mjs';
import {runFiniteGraphBank} from './finite-graphs-v1.mjs';
import {runBooleanBank} from './boolean-functions-v1.mjs';
import {runFiniteRelationBank} from './finite-relations-v1.mjs';
import {runPartitionBank} from './partitions-compositions-v1.mjs';
import {runWeightedTreeBank} from './weighted-trees-v1.mjs';
import {runPrefixCodeBank} from './prefix-codes-v1.mjs';
import {runModularMatrixBank} from './modular-matrices-v1.mjs';
import {runRationalSeriesBank} from './rational-series-v1.mjs';
import {runTwoMarkovBank} from './markov-two-v1.mjs';
import {runBitword238Bank} from './bitwords-238-v1.mjs';
import {runFiniteSet238Bank} from './finite-sets-238-v1.mjs';
import {runFiniteFunction238Bank} from './finite-functions-238-v1.mjs';
import {runUrn238Bank} from './urn-probability-238-v1.mjs';
import {runInterval238Bank} from './intervals-238-v1.mjs';
import {runBinaryGrid238Bank} from './binary-grids-238-v1.mjs';
import {runRootedTree238Bank} from './rooted-trees-238-v1.mjs';
import {runCellular238Bank} from './cellular-automata-238-v1.mjs';
import {runSequence438Bank} from './sequences-438-v1.mjs';
import {runIntegerPolynomial438Bank} from './integer-polynomials-438-v1.mjs';
import {runIntegerMatrix438Bank} from './integer-matrices-438-v1.mjs';
import {runGraphInvariant438Bank} from './graph-invariants-438-v1.mjs';
import {runUnicode438Bank} from './unicode-strings-438-v1.mjs';
import {runFiniteNumber438Bank} from './finite-number-theory-438-v1.mjs';
import {runHypergraph438Bank} from './hypergraphs-438-v1.mjs';
import {runPoset438Bank} from './posets-438-v1.mjs';
import {runGeometry438Bank} from './lattice-geometry-438-v1.mjs';
import {runGf2Coding438Bank} from './gf2-codes-438-v1.mjs';
import {runFiniteAutomata438Bank,runNumerical438Bank} from './contract-overrides-438-v1.mjs';
import {runFinalPrimePolynomialBank} from './final-prime-polynomials-v1.mjs';
import {runFinalExactMarkovBank} from './final-exact-markov-v1.mjs';
import {runFinalFiniteEventsBank} from './final-finite-events-v1.mjs';
import {runFinalCombinatoricsBank} from './final-combinatorics-v1.mjs';
import {runFinalUnicodeIndexBank} from './final-unicode-index-v1.mjs';
import {runFinalNumberTheoryTailBank} from './final-number-theory-tail-v1.mjs';
import {runFinalBasicNumberTheoryBank} from './final-basic-number-theory-v1.mjs';
import {runFinalDescriptiveStatisticsBank} from './final-descriptive-statistics-v1.mjs';

export function runAxioma({resolveLayer} = {}) {
  const options = resolveLayer ? {resolveLayer} : {};
  const suites = [runFinitePolynomialBank,runPermutationBank,runNumberTheoryBank,runFiniteGraphBank,runBooleanBank,runFiniteRelationBank,runPartitionBank,runWeightedTreeBank,runPrefixCodeBank,runModularMatrixBank,runRationalSeriesBank,runTwoMarkovBank,runBitword238Bank,runFiniteSet238Bank,runFiniteFunction238Bank,runUrn238Bank,runInterval238Bank,runBinaryGrid238Bank,runRootedTree238Bank,runCellular238Bank,runSequence438Bank,runIntegerPolynomial438Bank,runIntegerMatrix438Bank,runGraphInvariant438Bank,runUnicode438Bank,runFiniteNumber438Bank,runHypergraph438Bank,runPoset438Bank,runGeometry438Bank,runGf2Coding438Bank,runFiniteAutomata438Bank,runNumerical438Bank,runFinalPrimePolynomialBank,runFinalExactMarkovBank,runFinalFiniteEventsBank,runFinalCombinatoricsBank,runFinalUnicodeIndexBank,runFinalNumberTheoryTailBank,runFinalBasicNumberTheoryBank,runFinalDescriptiveStatisticsBank].map(fn=>fn(options));
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
    subject: 'GAUSS integration branch, bounded independently referenced comparisons',
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
    precisionClaim: 'Only evaluated inputs for named bounded operators; exact comparisons exact, numerical methods checked against explicit analytic tolerances, entropy compared within stated tolerance; no universal accuracy claim',
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
