import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sha256Canonical } from '../core/common.mjs';
import { executeGaussProblem } from '../core/problem.mjs';
import { contributeNexusQuantum } from '../core/quantum-contributor.mjs';
import { verifyGaussFoundationEvidence } from '../../walle/gauss-evidence-verify.mjs';

const problem = JSON.parse(await readFile(new URL('../fixtures/selftest-problem.json', import.meta.url), 'utf8'));
const genuine = await executeGaussProblem(problem, { quantumContributor: contributeNexusQuantum });
const numericalLayerIds = [
  'GAUSS.MATH.GAUSSIAN_SOLVE.005',
  'GAUSS.MATH.PIVOTED_LOGDET.006',
  'GAUSS.MATH.CHOLESKY.007',
  'GAUSS.MATH.CONJUGATE_GRADIENT.008',
  'GAUSS.MATH.HOUSEHOLDER_QR.009',
  'GAUSS.STATS.QR_LEAST_SQUARES.013',
  'GAUSS.INFO.FFT_RADIX2.005',
];

test('every bounded numerical operator is executed and independently replayed by WALLE', async () => {
  assert.equal(genuine.status, 'PASS');
  assert.equal(genuine.executedLayerCount, problem.tasks.length);
  assert.deepEqual(numericalLayerIds.filter(id => !genuine.taskResults.some(row => row.layerId === id)), []);
  const verified = await verifyGaussFoundationEvidence({ problem, report: genuine });
  assert.equal(verified.executedLayerCount, problem.tasks.length);
});

test('WALLE rejects each forged numerical result even with recomputed output and report hashes', async () => {
  for (const id of numericalLayerIds) {
    const fake = structuredClone(genuine);
    const result = fake.taskResults.find(row => row.layerId === id);
    assert(result, `missing numerical operator ${id}`);
    result.output = { ...result.output, fabricatedNumericalClaim: 99 };
    result.outputSha256 = sha256Canonical(result.output);
    const { reportSha256: ignored, ...unsigned } = fake;
    void ignored;
    fake.reportSha256 = sha256Canonical(unsigned);
    await assert.rejects(verifyGaussFoundationEvidence({ problem, report: fake }), /replay differs/u, `${id} accepted forged evidence`);
  }
});
