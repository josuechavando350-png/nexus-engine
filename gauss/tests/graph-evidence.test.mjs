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
  'GAUSS.CS.DIJKSTRA_SHORTEST_PATH.003',
  'GAUSS.CS.MIN_SPANNING_FOREST.004',
  'GAUSS.CS.MAX_FLOW_MIN_CUT.005',
  'GAUSS.CS.STRONG_COMPONENTS.006',
  'GAUSS.CS.BIPARTITE_MATCHING.007',
  'GAUSS.CS.DAG_SCHEDULE.008',
  'GAUSS.CS.TSP_HELD_KARP.009',
  'GAUSS.INFO.PAGERANK.004',
];

test('every graph operator is executed exactly once and WALLE replays all graph results', async () => {
  assert.equal(authentic.status, 'PASS');
  assert.equal(authentic.executedLayerCount, 31);
  assert.equal(new Set(authentic.taskResults.map(row => row.layerId)).size, 31);
  assert.deepEqual(newLayerIds.filter(id => !authentic.taskResults.some(row => row.layerId === id)), []);
  const verified = await verifyGaussFoundationEvidence({ problem, report: authentic });
  assert.equal(verified.executedLayerCount, 31);
});

test('forged outputs of all eight new operators fail WALLE replay even after recomputing every altered hash', async () => {
  for (const id of newLayerIds) {
    const forged = structuredClone(authentic);
    const result = forged.taskResults.find(row => row.layerId === id);
    assert(result, `missing graph operator ${id}`);
    result.output = { ...result.output, forgedResult: true };
    result.outputSha256 = sha256Canonical(result.output);
    const { reportSha256: ignored, ...unsigned } = forged;
    void ignored;
    forged.reportSha256 = sha256Canonical(unsigned);
    await assert.rejects(
      verifyGaussFoundationEvidence({ problem, report: forged }),
      /replay differs/u,
      `${id} accepted a falsified result`,
    );
  }
});
