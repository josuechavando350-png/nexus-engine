import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { sha256Canonical } from '../core/common.mjs';
import { executeGaussProblem } from '../core/problem.mjs';
import { contributeNexusQuantum } from '../core/quantum-contributor.mjs';
import { verifyGaussFoundationEvidence } from '../../walle/gauss-evidence-verify.mjs';

const problem = JSON.parse(await readFile(new URL('../fixtures/selftest-problem.json', import.meta.url), 'utf8'));
const authentic = await executeGaussProblem(problem, { quantumContributor: contributeNexusQuantum });
const newLayerIds = [
  'GAUSS.STATS.WLS_LINE.004',
  'GAUSS.STATS.ISOTONIC_PAV.005',
  'GAUSS.STATS.BH_FDR.006',
  'GAUSS.STATS.PAIRED_PERMUTATION.007',
  'GAUSS.STATS.FISHER_EXACT.008',
  'GAUSS.STATS.KAPLAN_MEIER.009',
  'GAUSS.STATS.THEIL_SEN.010',
  'GAUSS.STATS.SPLIT_CONFORMAL.011',
  'GAUSS.STATS.SPRT_BERNOULLI.012',
];

test('all nine statistics operators are present in the unique WALLE-covered fixture', async () => {
  assert.equal(authentic.status, 'PASS');
  assert.equal(authentic.executedLayerCount, problem.tasks.length);
  assert.deepEqual(newLayerIds.filter(id => !authentic.taskResults.some(row => row.layerId === id)), []);
  const receipt = await verifyGaussFoundationEvidence({ problem, report: authentic });
  assert.equal(receipt.executedLayerCount, problem.tasks.length);
});

test('WALLE independently rejects a forged result for EACH statistical operator after hash recomputation', async () => {
  for (const id of newLayerIds) {
    const forged = structuredClone(authentic);
    const row = forged.taskResults.find(result => result.layerId === id);
    assert(row, `missing statistical operator ${id}`);
    row.output = { ...row.output, fabricatedStatisticalClaim: 99 };
    row.outputSha256 = sha256Canonical(row.output);
    const { reportSha256: oldHash, ...unsigned } = forged;
    void oldHash;
    forged.reportSha256 = sha256Canonical(unsigned);
    await assert.rejects(verifyGaussFoundationEvidence({ problem, report: forged }), /replay differs/u, `${id} accepted forged evidence`);
  }
});
