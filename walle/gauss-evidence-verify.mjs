#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GAUSS_ENGINE_ID, sha256Canonical } from '../gauss/core/common.mjs';
import { buildGaussFoundationFixture } from '../gauss/core/foundation-fixture.mjs';
import { executeGaussProblem } from '../gauss/core/problem.mjs';
import { contributeNexusQuantum } from '../gauss/core/quantum-contributor.mjs';
import { GAUSS_IMPLEMENTED_LAYERS } from '../gauss/core/registry.mjs';

const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const mod = (a, m) => ((a % m) + m) % m;
function gcd(a, b) {
  while (b !== 0n) [a,b] = [b, a % b];
  return a;
}
function verifyCrt(task, output) {
  const rows = task.input.congruences.map(c => ({remainder:BigInt(c.remainder),modulus:BigInt(c.modulus)}));
  // Pairwise gcd compatibility is a complete, independent existence criterion.
  const possible = rows.every((a,i) => rows.every((b,j) => j <= i ||
    (a.remainder - b.remainder) % gcd(a.modulus,b.modulus) === 0n));
  assert.equal(output?.consistent, possible, 'independent generalized CRT consistency proof failed');
  if (!possible) {
    assert.equal(output.remainder, null);
    assert.equal(output.modulus, null);
    return;
  }
  const period = rows.reduce((lcm, row) => lcm / gcd(lcm,row.modulus) * row.modulus,1n);
  const remainder = BigInt(output.remainder);
  assert.equal(output.modulus,period.toString(),'independent CRT lcm proof failed');
  assert(remainder >= 0n && remainder < period,'CRT representative is not canonical');
  for(const row of rows)
    assert.equal(mod(remainder-row.remainder,row.modulus),0n,'independent CRT congruence failed');
}
function determinantLeibniz(matrix) {
  let sum = 0n;
  function enumerate(row, chosen, sign, product) {
    if (row === matrix.length) { sum += sign*product; return; }
    for(let column=0;column<matrix.length;column++){
      if(chosen.includes(column))continue;
      const swaps=chosen.filter(previous=>previous>column).length;
      enumerate(row+1,[...chosen,column],swaps%2?-sign:sign,product*BigInt(matrix[row][column]));
    }
  }
  enumerate(0,[],1n,1n);
  return sum;
}
function verifyMatrixInverse(task, output) {
  const matrix=task.input.coefficients,p=task.input.prime,n=matrix.length;
  assert.equal(output?.fieldPrime,p,'finite-field prime mismatch');
  assert(n<=4,'independent Leibniz fixture proof is bounded to 4x4');
  const determinant=mod(determinantLeibniz(matrix),BigInt(p));
  assert.equal(output?.invertible,determinant!==0n,'independent finite-field determinant proof failed');
  if(determinant===0n){assert.equal(output.inverse,null);return;}
  assert(Array.isArray(output.inverse)&&output.inverse.length===n,'inverse dimension mismatch');
  for(const row of output.inverse){
    assert(Array.isArray(row)&&row.length===n,'inverse row dimension mismatch');
    for(const entry of row)assert(Number.isSafeInteger(entry)&&entry>=0&&entry<p,'inverse entry is not canonical');
  }
  for(const [left,right] of [[matrix,output.inverse],[output.inverse,matrix]])
    for(let i=0;i<n;i++)for(let j=0;j<n;j++){
      let dot=0;
      for(let k=0;k<n;k++)dot+=left[i][k]*right[k][j];
      assert.equal(((dot%p)+p)%p,Number(i===j),'independent two-sided matrix inverse proof failed');
    }
}
function verifyIntegerPolynomialResultant(task, output) {
  const f=task.input.left,g=task.input.right;
  const m=f.length-1,n=g.length-1,size=m+n;
  // Bounded independent Leibniz oracle: the audited connected fixture is 3x3.
  assert(size>=2&&size<=7,'independent polynomial resultant fixture exceeds Leibniz budget');
  const sylvester=Array.from({length:size},()=>Array(size).fill(0n));
  for(let row=0;row<n;row++)for(let j=0;j<=m;j++)sylvester[row][row+j]=BigInt(f[m-j]);
  for(let row=0;row<m;row++)for(let j=0;j<=n;j++)sylvester[n+row][row+j]=BigInt(g[n-j]);
  const expected=determinantLeibniz(sylvester);
  assert.equal(output?.arithmetic,'EXACT_INTEGER','independent resultant arithmetic mismatch');
  assert.deepEqual(output?.degrees,[m,n],'independent resultant degree mismatch');
  assert.equal(output?.resultant,expected.toString(),'independent polynomial resultant determinant mismatch');
  assert.equal(output?.commonComplexRoot,expected===0n,'independent polynomial resultant common-root mismatch');
}

export async function verifyGaussFoundationEvidence({ problem, report }) {
  const expectedLayerIds = GAUSS_IMPLEMENTED_LAYERS.map((layer) => layer.id).sort();
  const fixtureLayerIds = problem?.tasks?.map((task) => task.layerId).sort();
  const extensionIds = new Set([
    'GAUSS.MATH.CRT_GENERAL.059',
    'GAUSS.MATH.FINITE_FIELD_MATRIX_INVERSE.060',
    'GAUSS.MATH.INTEGER_POLYNOMIAL_RESULTANT.061',
  ]);
  const baselineLayerIds = expectedLayerIds.filter((id) => !extensionIds.has(id));
  const isCurrentFixture = fixtureLayerIds?.length === expectedLayerIds.length;
  assert.deepStrictEqual(
    fixtureLayerIds,
    isCurrentFixture ? expectedLayerIds : baselineLayerIds,
    'foundation fixture must execute either the immutable 200-layer baseline or every registered layer exactly once',
  );
  const expectedTaskCount = fixtureLayerIds.length;

  assert.equal(report?.engineId, GAUSS_ENGINE_ID, 'GAUSS engine identity mismatch');
  assert.equal(report?.status, 'PASS', 'GAUSS report must PASS');
  assert.equal(report?.registry?.targetLayerCount, 800, 'GAUSS target mismatch');
  assert.equal(report?.registry?.implementedLayerCount, expectedLayerIds.length, 'GAUSS implemented count mismatch');
  assert.equal(report?.executedLayerCount, expectedTaskCount, 'GAUSS executed count mismatch');
  assert.equal(report?.failedLayerCount, 0, 'GAUSS failed count mismatch');
  assert.equal(report?.quantumContribution?.status, 'EXECUTED', 'Quantum contributor did not execute');
  assert.equal(report?.quantumContribution?.simulation?.verdict, 'PASS', 'Quantum simulation did not PASS');
  assert.equal(report?.quantumContribution?.simulation?.hardwareExecution, false, 'physical QPU claim forbidden');
  assert.equal(report?.quantumContribution?.simulation?.quantumAdvantageClaimAllowed, false, 'quantum advantage claim forbidden');

  const { reportSha256, ...unsigned } = report;
  assert.equal(reportSha256, sha256Canonical(unsigned), 'GAUSS report SHA-256 mismatch');
  assert.equal(report.problemSha256, sha256Canonical(problem), 'GAUSS problem SHA-256 mismatch');
  assert.equal(report.taskResults?.length, expectedTaskCount, 'task coverage mismatch');
  for (let i = 0; i < problem.tasks.length; i += 1) {
    const task = problem.tasks[i];
    const result = report.taskResults[i];
    assert.equal(result?.taskId, task.taskId, 'task ID mismatch');
    assert.equal(result?.layerId, task.layerId, 'task layer mismatch');
    assert.equal(result?.status, 'EXECUTED', 'task was not executed');
    assert.equal(result?.inputSha256, sha256Canonical(task.input), 'task input SHA-256 mismatch');
    assert.equal(result?.outputSha256, sha256Canonical(result.output), 'task output SHA-256 mismatch');
    if(task.layerId==='GAUSS.MATH.CRT_GENERAL.059')verifyCrt(task,result.output);
    if(task.layerId==='GAUSS.MATH.FINITE_FIELD_MATRIX_INVERSE.060')verifyMatrixInverse(task,result.output);
    if(task.layerId==='GAUSS.MATH.INTEGER_POLYNOMIAL_RESULTANT.061')verifyIntegerPolynomialResultant(task,result.output);
  }
  assert.equal(report.quantumContribution.problemSha256, report.problemSha256, 'Quantum problem binding mismatch');
  const source = report.taskResults.find((item) => item.taskId === report.quantumContribution.sourceTaskId);
  assert(source, 'Quantum source task missing');
  assert.equal(report.quantumContribution.sourceTaskOutputSha256, source.outputSha256, 'Quantum source task output mismatch');

  // Re-execute independently of the supplied report. A tampered output with
  // recomputed hashes is not enough to pass this fixture-bound proof.
  const replay = await executeGaussProblem(problem, { quantumContributor: contributeNexusQuantum });
  assert.deepStrictEqual(report, replay, 'GAUSS/Quantum replay differs from claimed evidence');
  return Object.freeze({ reportSha256, executedLayerCount: report.executedLayerCount, quantumExecuted: true });
}

async function readBoundedJson(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_REPORT_BYTES) {
    throw new Error('GAUSS evidence must be a bounded regular non-symlink file');
  }
  return readFile(path);
}

export async function verifyGaussEvidenceFile(path, problemPath = null) {
  const reportBytes = await readBoundedJson(path);
  const report = JSON.parse(reportBytes.toString('utf8'));
  const problem = problemPath ? JSON.parse((await readBoundedJson(problemPath)).toString('utf8'))
    : await buildGaussFoundationFixture();
  await verifyGaussFoundationEvidence({ problem, report });
  return Object.freeze({ artifactSha256: `sha256:${createHash('sha256').update(reportBytes).digest('hex')}`, executedLayerCount: report.executedLayerCount });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length < 3 || process.argv.length > 4) throw new Error('Usage: node walle/gauss-evidence-verify.mjs <report.json> [problem.json]');
  const verified = await verifyGaussEvidenceFile(process.argv[2], process.argv[3] ?? null);
  console.log(`WALLE_GAUSS_REPORT_SHA256=${verified.artifactSha256}`);
  console.log(`WALLE_GAUSS_IMPLEMENTED_LAYERS=${verified.executedLayerCount}`);
}
