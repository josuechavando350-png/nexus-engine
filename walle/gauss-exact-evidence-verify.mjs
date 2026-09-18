#!/usr/bin/env node
// WALLE: independent BigInt reconstruction of exact-linear witnesses.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Canonical } from '../gauss/core/common.mjs';
import { executeGaussProblem, validateGaussProblem } from '../gauss/core/problem.mjs';
import { contributeNexusQuantum } from '../gauss/core/quantum-contributor.mjs';
const EXACT_LAYER = 'GAUSS.MATH.GAUSSIAN_SOLVE.005';
function magnitude(x) { return x < 0n ? -x : x; }
function divisor(a, b) {
  a = magnitude(a); b = magnitude(b);
  while (b) { const temporary = a % b; a = b; b = temporary; }
  return a;
}
function rational(p, q = 1n) {
  assert.notEqual(q, 0n, 'zero rational denominator');
  if (q < 0n) { p = -p; q = -q; }
  const factor = divisor(p, q);
  return [p / factor, q / factor];
}
function scalar(value) {
  if (typeof value === 'number') {
    assert(Number.isSafeInteger(value), 'exact rational input must not contain rounded JS floats');
    value = String(value);
  }
  assert.equal(typeof value, 'string');
  const fraction = /^(-?(?:0|[1-9]\d*))\/([1-9]\d*)$/u.exec(value);
  if (fraction) return rational(BigInt(fraction[1]), BigInt(fraction[2]));
  const decimal = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/u.exec(value);
  assert(decimal, 'invalid exact rational input');
  const power = Number(decimal[4] ?? 0) - (decimal[3]?.length ?? 0);
  assert(Math.abs(Number(decimal[4] ?? 0)) <= 256, 'exponent out of range');
  const integer = BigInt(`${decimal[1]}${decimal[2]}${decimal[3] ?? ''}`);
  return power >= 0 ? rational(integer * 10n ** BigInt(power)) : rational(integer, 10n ** BigInt(-power));
}
function sum([a, b], [c, d]) { return rational(a * d + c * b, b * d); }
function product([a, b], [c, d]) { return rational(a * c, b * d); }
function checkWitness(input, output) {
  assert.equal(output?.arithmetic, 'EXACT_RATIONAL');
  assert.equal(output?.exactResidualVerified, true);
  const places = input.decimalPlaces ?? 64;
  assert.equal(output.decimalPlaces, places);
  assert(Number.isSafeInteger(places) && places >= 0 && places <= 4096);
  const n = input.coefficients.length;
  assert(n >= 1 && n <= 12, 'exact evidence matrix dimension out of bounds');
  assert.equal(output.solution?.length, n);
  const solutions = output.solution.map((entry, index) => {
    assert.match(entry?.numerator, /^-?(?:0|[1-9]\d*)$/u, `solution ${index} numerator`);
    assert.match(entry?.denominator, /^[1-9]\d*$/u, `solution ${index} denominator`);
    assert(entry.numerator.length <= 10000 && entry.denominator.length <= 10000, 'witness exceeds exact rational budget');
    const x = rational(BigInt(entry.numerator), BigInt(entry.denominator));
    assert.equal(x[0].toString(), entry.numerator, 'rational numerator is not canonical');
    assert.equal(x[1].toString(), entry.denominator, 'rational denominator is not canonical');
    const scale = 10n ** BigInt(places);
    const scaled = magnitude(x[0]) * scale;
    let rounded = scaled / x[1];
    const remainder = scaled % x[1];
    if (2n * remainder > x[1] || (2n * remainder === x[1] && rounded % 2n === 1n)) rounded++;
    const digits = rounded.toString().padStart(places + 1, '0');
    const expectedDecimal = `${x[0] < 0n && rounded !== 0n ? '-' : ''}${places === 0 ? digits : `${digits.slice(0, -places)}.${digits.slice(-places)}`}`;
    assert.equal(entry.decimal, expectedDecimal, 'decimal is not correctly rounded to nearest-even');
    const expectedError = rational(magnitude(scaled - rounded * x[1]), x[1] * scale);
    assert.deepStrictEqual(entry.absoluteError, {
      numerator: expectedError[0].toString(), denominator: expectedError[1].toString(),
    }, 'absolute rounding error differs from exact rational witness');
    assert(2n * expectedError[0] * scale <= expectedError[1], 'rounding error exceeds half an ulp');
    return x;
  });
  input.coefficients.forEach((row, i) => {
    let acc = [0n, 1n];
    row.forEach((value, j) => { acc = sum(acc, product(scalar(value), solutions[j])); });
    assert.deepStrictEqual(acc, scalar(input.rhs[i]), `exact A*x=b residual failed at row ${i}`);
  });
}
export async function verifyGaussExactEvidence({ problem, report }) {
  const normalized = validateGaussProblem(problem);
  const exactTasks = normalized.tasks.filter(task => task.layerId === EXACT_LAYER && task.input.mode === 'EXACT_RATIONAL');
  assert.equal(exactTasks.length, 1, 'evidence must contain exactly one exact linear task');
  assert.equal(report?.status, 'PASS', 'GAUSS exact evidence did not PASS');
  assert.equal(report?.problemSha256, sha256Canonical(normalized), 'problem SHA mismatch');
  const { reportSha256, ...unsigned } = report;
  assert.equal(reportSha256, sha256Canonical(unsigned), 'report SHA mismatch');
  assert.equal(report.taskResults?.length, normalized.tasks.length, 'task count mismatch');
  normalized.tasks.forEach((task, index) => {
    const result = report.taskResults[index];
    assert.equal(result?.taskId, task.taskId, 'task identity mismatch');
    assert.equal(result?.status, 'EXECUTED', 'task did not execute');
    assert.equal(result?.inputSha256, sha256Canonical(task.input), 'input hash mismatch');
    assert.equal(result?.outputSha256, sha256Canonical(result.output), 'output hash mismatch');
  });
  const exactTask = exactTasks[0];
  const exactResult = report.taskResults.find(row => row.taskId === exactTask.taskId);
  assert.equal(exactResult.layerId, EXACT_LAYER, 'exact layer identity mismatch');
  checkWitness(exactTask.input, exactResult.output);
  // Replay also validates the existing Quantum protocol and its Ising binding.
  const replay = await executeGaussProblem(normalized, { quantumContributor: contributeNexusQuantum });
  assert.deepStrictEqual(report, replay, 'GAUSS/Quantum replay differs from evidence');
  return Object.freeze({ reportSha256, exactResidualVerified: true, quantumStatus: report.quantumContribution.status });
}
async function boundedJson(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 16 * 1024 * 1024) {
    throw new Error('WALLE requires a bounded regular non-symlink JSON file');
  }
  return readFile(path);
}
export async function verifyGaussExactEvidenceFile(problemPath, reportPath) {
  const [problemBytes, reportBytes] = await Promise.all([boundedJson(problemPath), boundedJson(reportPath)]);
  const verification = await verifyGaussExactEvidence({
    problem: JSON.parse(problemBytes.toString('utf8')),
    report: JSON.parse(reportBytes.toString('utf8')),
  });
  return Object.freeze({
    ...verification, artifactSha256: `sha256:${createHash('sha256').update(reportBytes).digest('hex')}`,
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length !== 4) throw new Error('Usage: node walle/gauss-exact-evidence-verify.mjs <problem.json> <report.json>');
  const proof = await verifyGaussExactEvidenceFile(process.argv[2], process.argv[3]);
  console.log(`WALLE_GAUSS_EXACT_REPORT_SHA256=${proof.artifactSha256}`);
  console.log(`WALLE_GAUSS_EXACT_RESIDUAL_VERIFIED=${proof.exactResidualVerified}`);
  console.log(`WALLE_GAUSS_EXACT_QUANTUM_STATUS=${proof.quantumStatus}`);
}
