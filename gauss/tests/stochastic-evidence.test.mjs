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
  'GAUSS.STATS.MARKOV_N_STEP.014',
  'GAUSS.STATS.MARKOV_HITTING.015',
  'GAUSS.STATS.ABSORBING_MARKOV_TIME.016',
  'GAUSS.STATS.MARKOV_STATIONARY.017',
  'GAUSS.STATS.HMM_FORWARD.018',
  'GAUSS.STATS.HMM_VITERBI.019',
  'GAUSS.STATS.HMM_SMOOTHING.020',
  'GAUSS.STATS.POISSON_BINOMIAL.021',
  'GAUSS.DECISION.MDP_FINITE_HORIZON.008',
  'GAUSS.DECISION.MDP_DISCOUNTED.009',
  'GAUSS.DECISION.MDP_POLICY_EVALUATION.010',
  'GAUSS.DECISION.MARKOV_REWARD.011',
];

test('each stochastic and sequential-decision operator is executed exactly once and independently replayed by WALLE', async () => {
  assert.equal(report.status, 'PASS');
  assert.equal(report.executedLayerCount, problem.tasks.length);
  assert.equal(new Set(problem.tasks.map(task => task.layerId)).size, problem.tasks.length);
  for (const id of ids) assert.equal(report.taskResults.filter(row => row.layerId === id).length, 1, id);
  const receipt = await verifyGaussFoundationEvidence({ problem, report });
  assert.equal(receipt.executedLayerCount, problem.tasks.length);
});

test('WALLE rejects every falsified stochastic output even after its output and report hashes are recalculated', async () => {
  for (const id of ids) {
    const forged = structuredClone(report);
    const result = forged.taskResults.find(row => row.layerId === id);
    assert(result, `missing stochastic operator ${id}`);
    result.output = { ...result.output, forgedStochasticClaim: 1000 };
    result.outputSha256 = sha256Canonical(result.output);
    const { reportSha256: priorHash, ...unsigned } = forged;
    void priorHash;
    forged.reportSha256 = sha256Canonical(unsigned);
    await assert.rejects(verifyGaussFoundationEvidence({ problem, report: forged }), /replay differs/u, `${id} accepted forged evidence`);
  }
});
