import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getGaussLayer, gaussRegistrySummary } from '../core/registry.mjs';
import { executeGaussProblem } from '../core/problem.mjs';
import { contributeNexusQuantum } from '../core/quantum-contributor.mjs';
import { sha256Canonical } from '../core/common.mjs';
import { verifyGaussIntegerDeterminantEvidence } from '../../walle/gauss-integer-determinant-evidence-verify.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/exact-integer-determinant-problem.json', import.meta.url), 'utf8'));

test('registered exact-integer mode keeps legacy logdet semantics and the true 204-ID count', () => {
  const layer = getGaussLayer('GAUSS.MATH.PIVOTED_LOGDET.006');
  assert(layer);
  assert.equal(gaussRegistrySummary().implementedLayerCount, 204);
  const exact = layer.execute(fixture.tasks[0].input);
  assert.deepEqual(exact, { arithmetic: 'EXACT_INTEGER', determinant: '-12', singular: false, pivotExchanges: 1 });
  const legacy = layer.execute({ coefficients: [[3, 1], [1, 2]] });
  assert.equal(legacy.sign, 1);
  assert(Math.abs(legacy.logAbsoluteDeterminant - Math.log(5)) < 1e-12);
  assert.throws(() => layer.execute({ mode: 'UNSUPPORTED', coefficients: [[1]] }), /unsupported/u);
});

test('NEXUS executes exact integer determinant, classical Quantum and independent WALLE oracle', async () => {
  const report = await executeGaussProblem(fixture, { quantumContributor: contributeNexusQuantum });
  assert.equal(report.status, 'PASS');
  assert.equal(report.executedLayerCount, 2);
  assert.equal(report.quantumContribution.status, 'EXECUTED');
  assert.equal(report.quantumContribution.simulation.hardwareExecution, false);
  const proof = await verifyGaussIntegerDeterminantEvidence({ problem: fixture, report });
  assert.equal(proof.exactDeterminantVerified, true);
  const forged = structuredClone(report);
  forged.taskResults[0].output.determinant = '999';
  forged.taskResults[0].outputSha256 = sha256Canonical(forged.taskResults[0].output);
  const { reportSha256: ignored, ...unsigned } = forged; void ignored;
  forged.reportSha256 = sha256Canonical(unsigned);
  await assert.rejects(verifyGaussIntegerDeterminantEvidence({ problem: fixture, report: forged }), /independent exact determinant mismatch/u);
});
