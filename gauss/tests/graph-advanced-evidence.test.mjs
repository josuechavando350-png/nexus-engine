import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sha256Canonical } from '../core/common.mjs';
import { executeGaussProblem } from '../core/problem.mjs';
import { contributeNexusQuantum } from '../core/quantum-contributor.mjs';
import { verifyGaussFoundationEvidence } from '../../walle/gauss-evidence-verify.mjs';

const problem = JSON.parse(await readFile(new URL('../fixtures/selftest-problem.json', import.meta.url), 'utf8'));
const report = await executeGaussProblem(problem, { quantumContributor: contributeNexusQuantum });
const advancedIds = [
  'GAUSS.CS.BELLMAN_FORD_SIGNED.010',
  'GAUSS.CS.FLOYD_WARSHALL.011',
  'GAUSS.CS.ARTICULATION_VERTICES.012',
  'GAUSS.CS.BRIDGES.013',
  'GAUSS.CS.WEIGHTED_VERTEX_COVER.014',
  'GAUSS.CS.CHROMATIC_NUMBER.015',
  'GAUSS.CS.MIN_COST_ASSIGNMENT.016',
  'GAUSS.CS.WEIGHTED_TREE_DIAMETER.017',
  'GAUSS.CS.DIRECTED_EULER_TRAIL.018',
];

test('all nine advanced graph results execute with exactly-once coverage and Quantum receipt', async () => {
  assert.equal(report.status, 'PASS');
  assert.equal(report.executedLayerCount, problem.tasks.length);
  assert.deepEqual(new Set(problem.tasks.map(row => row.layerId)).size, problem.tasks.length);
  for (const id of advancedIds) assert.equal(report.taskResults.filter(row => row.layerId === id).length, 1, id);
  const verified = await verifyGaussFoundationEvidence({ problem, report });
  assert.equal(verified.executedLayerCount, problem.tasks.length);
});

test('WALLE rejects a forged result for each new graph operator even with recomputed hashes', async () => {
  for (const id of advancedIds) {
    const fake = structuredClone(report);
    const result = fake.taskResults.find(row => row.layerId === id);
    assert(result, `missing advanced operator ${id}`);
    result.output = { ...result.output, inventedResult: 123456 };
    result.outputSha256 = sha256Canonical(result.output);
    const { reportSha256: oldHash, ...unsigned } = fake;
    void oldHash;
    fake.reportSha256 = sha256Canonical(unsigned);
    await assert.rejects(verifyGaussFoundationEvidence({ problem, report: fake }), /replay differs/u, `${id} accepted fabricated evidence`);
  }
});
