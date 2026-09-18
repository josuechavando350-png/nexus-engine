import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { solveExactLinearSystem } from '../core/precision/exact-linear.mjs';
import { executeGaussProblem } from '../core/problem.mjs';
import { contributeNexusQuantum } from '../core/quantum-contributor.mjs';
import { sha256Canonical } from '../core/common.mjs';
import { verifyGaussExactEvidence } from '../../walle/gauss-exact-evidence-verify.mjs';
const exact = (coefficients, rhs, decimalPlaces = 64) => solveExactLinearSystem({
  mode: 'EXACT_RATIONAL', coefficients, rhs, decimalPlaces,
});
const fixture = JSON.parse(await readFile(new URL('../fixtures/exact-linear-problem.json', import.meta.url), 'utf8'));

test('exact rational elimination produces 64 proven decimal places, not floats', () => {
  const result = exact([['2', '1'], ['1', '-1']], ['1', '0']);
  assert.equal(result.exactResidualVerified, true);
  assert.equal(result.solution.length, 2);
  for (const value of result.solution) {
    assert.equal(value.numerator, '1');
    assert.equal(value.denominator, '3');
    assert.equal(value.decimal, `0.${'3'.repeat(64)}`);
    assert.deepEqual(value.absoluteError, { numerator: '1', denominator: `3${'0'.repeat(64)}` });
  }
  assert.deepEqual(result, exact([['2', '1'], ['1', '-1']], ['1', '0']));
});

test('half-even rounding, sign, carry and zero places are exact', () => {
  assert.equal(exact([['8']], ['1'], 2).solution[0].decimal, '0.12');
  assert.equal(exact([['8']], ['3'], 2).solution[0].decimal, '0.38');
  assert.equal(exact([['8']], ['-1'], 2).solution[0].decimal, '-0.12');
  assert.equal(exact([['1000']], ['999'], 2).solution[0].decimal, '1.00');
  assert.equal(exact([['2']], ['-1'], 0).solution[0].decimal, '0');
  assert.equal(exact([['2']], ['-3'], 0).solution[0].decimal, '-2');
});

test('precise decimal/scientific input survives ill-conditioning and high output precision', () => {
  const tiny = `0.${'0'.repeat(79)}1`;
  const result = exact([['1', '1'], ['1', `1.${'0'.repeat(79)}1`]], ['2', `2.${'0'.repeat(79)}1`], 256);
  assert.deepEqual(result.solution.map(x => [x.numerator, x.denominator]), [['1', '1'], ['1', '1']]);
  assert.equal(exact([['1e-80']], [tiny], 64).solution[0].decimal, `1.${'0'.repeat(64)}`);
  assert.equal(exact([['3']], ['1'], 4096).solution[0].decimal, `0.${'3'.repeat(4096)}`);
  assert.equal(exact([['2']], ['1'], 1).solution[0].decimal, '0.5');
});

test('invalid, singular, overbudget and pre-rounded inputs fail closed', () => {
  assert.throws(() => exact([['1','2'], ['2','4']], ['1','2']), /singular/u);
  assert.throws(() => exact([['1.00000000000000000000000000001']], [1.5]), /floats lose precision/u);
  assert.throws(() => exact([['NaN']], ['1']), /canonical/u);
  assert.throws(() => exact([['1/0']], ['1']), /canonical/u);
  assert.throws(() => exact([['1e999']], ['1']), /budget/u);
  assert.throws(() => exact([['1']], ['1'], 4097), /decimalPlaces/u);
  assert.throws(() => solveExactLinearSystem({mode:'EXACT_RATIONAL',coefficients:[['1']],rhs:['1'],intruder:1}), /declared fields/u);
  assert.throws(() => exact(Array.from({length:13},()=>Array(13).fill('0')), Array(13).fill('0')), /1\.\.12/u);
});

test('seeded independent matrix construction validates unique integer solutions', () => {
  let state = 0x1a2b3c4d;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  for (let caseNumber = 0; caseNumber < 60; caseNumber++) {
    const n = caseNumber % 2 ? 3 : 2;
    const answer = Array.from({length:n},()=>Number(next()%13)-6);
    const coefficients = Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=> i === j ? 10 + Number(next()%9) : Number(next()%5)-2));
    const rhs = coefficients.map(row=>row.reduce((sum, v, j)=>sum+v*answer[j],0));
    const result = exact(coefficients.map(row=>row.map(String)),rhs.map(String),64);
    assert.deepEqual(result.solution.map(x => [x.numerator, x.denominator]), answer.map(x=>[String(x),'1']), `case ${caseNumber}`);
  }
});

test('NEXUS executes exact task, Quantum executes an actual classical simulation, WALLE verifies each exact witness', async () => {
  const report = await executeGaussProblem(fixture, { quantumContributor: contributeNexusQuantum });
  assert.equal(report.status, 'PASS');
  assert.equal(report.executedLayerCount, 2);
  assert.equal(report.quantumContribution.status, 'EXECUTED');
  assert.equal(report.quantumContribution.simulation.hardwareExecution, false);
  const proof = await verifyGaussExactEvidence({ problem: fixture, report });
  assert.equal(proof.exactResidualVerified, true);
  assert.equal(proof.quantumStatus, 'EXECUTED');
  const forged = structuredClone(report);
  forged.taskResults[0].output.solution[0].numerator = '2';
  forged.taskResults[0].output.solution[0].decimal = `0.${'6'.repeat(63)}7`;
  forged.taskResults[0].outputSha256 = sha256Canonical(forged.taskResults[0].output);
  const { reportSha256: ignored, ...unsigned } = forged; void ignored;
  forged.reportSha256 = sha256Canonical(unsigned);
  await assert.rejects(verifyGaussExactEvidence({problem:fixture,report:forged}), /residual failed/u);
});
