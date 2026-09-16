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
  'GAUSS.DECISION.WEIGHTED_INTERVAL_SCHEDULING.005',
  'GAUSS.CS.MATRIX_CHAIN.019',
  'GAUSS.DECISION.MIN_COIN_CHANGE.006',
  'GAUSS.CS.SUBSET_SUM.020',
  'GAUSS.CS.LONGEST_INCREASING_SUBSEQUENCE.021',
  'GAUSS.CS.LEVENSHTEIN.022',
  'GAUSS.CS.LONGEST_COMMON_SUBSEQUENCE.023',
  'GAUSS.INFO.HUFFMAN_CODE_LENGTHS.006',
  'GAUSS.CS.OPTIMAL_BST.024',
  'GAUSS.CS.MIN_PALINDROME_PARTITION.025',
  'GAUSS.DECISION.JOHNSON_TWO_MACHINE.007',
];

test('eleven distinct decision and discrete optimization algorithms have unique WALLE coverage', async () => {
  assert.equal(report.status, 'PASS');
  assert.equal(report.executedLayerCount, problem.tasks.length);
  assert.equal(new Set(problem.tasks.map(row => row.layerId)).size, problem.tasks.length);
  for (const id of ids) assert.equal(report.taskResults.filter(row => row.layerId === id).length, 1, id);
  const receipt = await verifyGaussFoundationEvidence({ problem, report });
  assert.equal(receipt.executedLayerCount, problem.tasks.length);
});

test('WALLE rejects each forged discrete optimization output even after all affected hashes are recomputed', async () => {
  for (const id of ids) {
    const fake = structuredClone(report);
    const result = fake.taskResults.find(row => row.layerId === id);
    assert(result, `missing discrete operator ${id}`);
    result.output = { ...result.output, forgedOptimizationClaim: 1000 };
    result.outputSha256 = sha256Canonical(result.output);
    const { reportSha256: oldHash, ...unsigned } = fake;
    void oldHash;
    fake.reportSha256 = sha256Canonical(unsigned);
    await assert.rejects(verifyGaussFoundationEvidence({ problem, report: fake }), /replay differs/u, `${id} accepted forged evidence`);
  }
});
