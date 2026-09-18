#!/usr/bin/env node
// Independent WALLE determinant oracle: permutations, not Bareiss elimination.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { sha256Canonical } from '../gauss/core/common.mjs';
import { executeGaussProblem, validateGaussProblem } from '../gauss/core/problem.mjs';
import { contributeNexusQuantum } from '../gauss/core/quantum-contributor.mjs';

const EXACT_LAYER = 'GAUSS.MATH.PIVOTED_LOGDET.006';
const ISING_LAYER = 'GAUSS.PHYSICS.ISING_EXACT_GROUND.003';
const INTEGER = /^(?:0|-?[1-9]\d*)$/u;
function independentDeterminant(matrix) {
  assert(Array.isArray(matrix) && matrix.length > 0 && matrix.length <= 6, 'WALLE oracle dimension unsupported');
  const n = matrix.length;
  const coefficients = matrix.map(row => {
    assert(Array.isArray(row) && row.length === n, 'WALLE oracle requires square matrix');
    return row.map(value => {
      assert.equal(typeof value, 'string');
      assert(INTEGER.test(value) && value.length <= 256, 'WALLE oracle requires canonical bounded integer');
      return BigInt(value);
    });
  });
  let total = 0n;
  function visit(row, used, parity, product) {
    if (row === n) { total += parity * product; return; }
    for (let col = 0; col < n; col++) {
      if (used.includes(col)) continue;
      const inversions = used.reduce((sum, prev) => sum + Number(prev > col), 0);
      visit(row + 1, [...used, col], inversions % 2 ? -parity : parity, product * coefficients[row][col]);
    }
  }
  visit(0, [], 1n, 1n);
  return total;
}
export async function verifyGaussIntegerDeterminantEvidence({ problem, report }) {
  const normalized = validateGaussProblem(problem);
  assert.equal(normalized.tasks.length, 2, 'exact determinant fixture must contain exactly two tasks');
  const [task, quantumTask] = normalized.tasks;
  assert.equal(task.taskId, 'exact-determinant');
  assert.equal(task.layerId, EXACT_LAYER);
  assert.equal(task.input.mode, 'EXACT_INTEGER');
  assert.equal(quantumTask.layerId, ISING_LAYER, 'Quantum Ising task missing');
  assert.equal(report?.status, 'PASS');
  assert.equal(report?.executedLayerCount, 2);
  assert.equal(report?.failedLayerCount, 0);
  assert.equal(report?.problemSha256, sha256Canonical(normalized), 'problem hash mismatch');
  const { reportSha256, ...unsigned } = report;
  assert.equal(reportSha256, sha256Canonical(unsigned), 'report hash mismatch');
  assert.equal(report?.taskResults?.length, 2);
  normalized.tasks.forEach((item, index) => {
    const result = report.taskResults[index];
    assert.equal(result?.taskId, item.taskId);
    assert.equal(result?.layerId, item.layerId);
    assert.equal(result?.status, 'EXECUTED');
    assert.equal(result?.inputSha256, sha256Canonical(item.input), 'input hash mismatch');
    assert.equal(result?.outputSha256, sha256Canonical(result.output), 'output hash mismatch');
  });
  const actual = report.taskResults[0].output;
  assert.equal(actual?.arithmetic, 'EXACT_INTEGER');
  assert(INTEGER.test(actual?.determinant ?? ''), 'determinant must be canonical integer');
  const independentlyComputed = independentDeterminant(task.input.coefficients);
  assert.equal(actual.determinant, independentlyComputed.toString(), 'independent exact determinant mismatch');
  assert.equal(actual.singular, independentlyComputed === 0n, 'singularity witness mismatch');
  assert(Number.isSafeInteger(actual.pivotExchanges) && actual.pivotExchanges >= 0
    && actual.pivotExchanges <= task.input.coefficients.length - 1, 'pivot count invalid');
  assert.equal(report.quantumContribution?.status, 'EXECUTED', 'classical Quantum contributor missing');
  assert.equal(report.quantumContribution?.simulation?.hardwareExecution, false, 'physical QPU not proven');
  const replay = await executeGaussProblem(normalized, { quantumContributor: contributeNexusQuantum });
  assert.deepStrictEqual(report, replay, 'independent GAUSS/Quantum replay differs');
  return Object.freeze({ reportSha256, exactDeterminantVerified: true, quantumStatus: report.quantumContribution.status });
}
async function boundedFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 16 * 1024 * 1024) {
    throw new Error('WALLE requires a bounded regular non-symlink evidence file');
  }
  return readFile(path);
}
export async function verifyGaussIntegerDeterminantEvidenceFile(problemPath, reportPath) {
  const [problemBytes, reportBytes] = await Promise.all([boundedFile(problemPath), boundedFile(reportPath)]);
  const result = await verifyGaussIntegerDeterminantEvidence({
    problem: JSON.parse(problemBytes.toString('utf8')),
    report: JSON.parse(reportBytes.toString('utf8')),
  });
  return Object.freeze({ ...result, artifactSha256: `sha256:${createHash('sha256').update(reportBytes).digest('hex')}` });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length !== 4) throw new Error('Usage: node walle/gauss-integer-determinant-evidence-verify.mjs <problem.json> <report.json>');
  const proof = await verifyGaussIntegerDeterminantEvidenceFile(process.argv[2], process.argv[3]);
  console.log(`WALLE_GAUSS_INTEGER_DETERMINANT_SHA256=${proof.artifactSha256}`);
  console.log(`WALLE_GAUSS_INTEGER_DETERMINANT_VERIFIED=${proof.exactDeterminantVerified}`);
  console.log(`WALLE_GAUSS_INTEGER_DETERMINANT_QUANTUM_STATUS=${proof.quantumStatus}`);
}
