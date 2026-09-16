import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sha256Canonical } from '../core/common.mjs';
import { executeGaussProblem } from '../core/problem.mjs';
import { contributeNexusQuantum } from '../core/quantum-contributor.mjs';
import { verifyGaussFoundationEvidence } from '../../walle/gauss-evidence-verify.mjs';

const problem = JSON.parse(await readFile(new URL('../fixtures/selftest-problem.json', import.meta.url), 'utf8'));
const report = await executeGaussProblem(problem, { quantumContributor: contributeNexusQuantum });
const ids = [
  'GAUSS.MATH.EXTENDED_EUCLID.010',
  'GAUSS.MATH.MODULAR_INVERSE.011',
  'GAUSS.MATH.CRT_COPRIME.012',
  'GAUSS.MATH.MODULAR_EXPONENT.013',
  'GAUSS.MATH.PRIME_FACTORIZATION.014',
  'GAUSS.MATH.EULER_TOTIENT.015',
  'GAUSS.MATH.PRIMALITY_SAFE_INT.016',
  'GAUSS.MATH.PRIME_SIEVE.017',
  'GAUSS.MATH.INTEGER_SQRT.018',
  'GAUSS.MATH.BINOMIAL_EXACT.019',
  'GAUSS.MATH.FIBONACCI_DOUBLING.020',
  'GAUSS.MATH.INTEGER_PARTITIONS.021',
];

test('twelve distinct bounded number-theory operators have exactly-once WALLE coverage', async () => {
  assert.equal(report.status, 'PASS');
  assert.equal(report.executedLayerCount, problem.tasks.length);
  assert.equal(new Set(problem.tasks.map(row => row.layerId)).size, problem.tasks.length);
  for (const id of ids) assert.equal(report.taskResults.filter(row => row.layerId === id).length, 1, id);
  const receipt = await verifyGaussFoundationEvidence({ problem, report });
  assert.equal(receipt.executedLayerCount, problem.tasks.length);
});

test('WALLE rejects every forged number-theory result despite recalculated output and report hashes', async () => {
  for (const id of ids) {
    const forged = structuredClone(report);
    const result = forged.taskResults.find(row => row.layerId === id);
    assert(result, `missing integer operator ${id}`);
    result.output = { ...result.output, forgedExactnessClaim: true };
    result.outputSha256 = sha256Canonical(result.output);
    const { reportSha256: previous, ...unsigned } = forged;
    void previous;
    forged.reportSha256 = sha256Canonical(unsigned);
    await assert.rejects(verifyGaussFoundationEvidence({ problem, report: forged }), /replay differs/u, `${id} accepted forged output`);
  }
});
