#!/usr/bin/env node
// Reproducible workloads, not a speed certification. No third-party modules.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { solveExactLinearSystem } from '../core/precision/exact-linear.mjs';
import { exactIntegerDeterminant } from '../core/precision/exact-integer-determinant.mjs';

const hash = value => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const PRIME_MODULI = [1000000007n, 1000000009n];
function remainder(value, prime) { const r = value % prime; return r < 0n ? r + prime : r; }
function modularPower(base, exponent, prime) {
  let result = 1n;
  for (; exponent > 0n; exponent >>= 1n) {
    if (exponent & 1n) result = result * base % prime;
    base = base * base % prime;
  }
  return result;
}
// Independent finite-field determinant oracle (not the Bareiss kernel).
function modularDeterminant(coefficients, prime) {
  const a = coefficients.map(row => row.map(value => remainder(BigInt(value), prime)));
  const n = a.length;
  let determinant = 1n;
  for (let k = 0; k < n; k++) {
    let row = k;
    while (row < n && a[row][k] === 0n) row++;
    if (row === n) return 0n;
    if (row !== k) { [a[k], a[row]] = [a[row], a[k]]; determinant = remainder(-determinant, prime); }
    const pivot = a[k][k];
    determinant = determinant * pivot % prime;
    const inverse = modularPower(pivot, prime - 2n, prime);
    for (let i = k + 1; i < n; i++) {
      const factor = a[i][k] * inverse % prime;
      for (let j = k + 1; j < n; j++) a[i][j] = remainder(a[i][j] - factor * a[k][j], prime);
      a[i][k] = 0n;
    }
  }
  return determinant;
}
function integerMatrix(n, digits) {
  const large = BigInt('7'.repeat(digits));
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) =>
    (i === j ? large + BigInt(1000 + i * 107) : BigInt(((i + 1) * 23 + (j + 3) * 17) % 11 - 5)).toString()));
}
function workloads() {
  const coefficients = Array.from({ length: 10 }, (_, i) => Array.from({ length: 10 }, (_, j) =>
    String(i === j ? 31 + i : ((i * 17 + j * 13) % 7) - 3)));
  const rhs = coefficients.map(row => `${row.reduce((sum, value, j) => sum + BigInt(value) * BigInt(j + 1), 0n)}/7`);
  const solveInput = { mode: 'EXACT_RATIONAL', coefficients, rhs, decimalPlaces: 256 };
  const jobs = [{
    name: 'rational-solve-10x10-256-decimals', input: solveInput, batch: 4,
    verification: 'known-exact-rational-solution',
    execute: () => solveExactLinearSystem(solveInput),
    verify(output) {
      assert.equal(output.arithmetic, 'EXACT_RATIONAL');
      assert.equal(output.exactResidualVerified, true);
      assert.equal(output.solution.length, 10);
      for (let j = 0; j < 10; j++) {
        const x = output.solution[j];
        assert.equal(BigInt(x.numerator) * 7n, BigInt(j + 1) * BigInt(x.denominator));
        assert.match(x.decimal, /^-?\d+\.\d{256}$/u);
      }
    },
  }];
  for (const [n, digits, batch] of [[8, 40, 5], [24, 72, 2]]) {
    const input = { mode: 'EXACT_INTEGER', coefficients: integerMatrix(n, digits) };
    const expectedModuli = PRIME_MODULI.map(prime => modularDeterminant(input.coefficients, prime));
    jobs.push({
      name: `integer-determinant-${n}x${n}-${digits}-digit-diagonal`, input, batch,
      verification: 'independent-finite-field-determinant-two-primes',
      execute: () => exactIntegerDeterminant(input),
      verify(output) {
        assert.equal(output.arithmetic, 'EXACT_INTEGER');
        assert.equal(output.singular, false);
        const actual = BigInt(output.determinant);
        PRIME_MODULI.forEach((prime, index) => {
          assert.equal(remainder(actual, prime), expectedModuli[index], `modular determinant oracle modulo ${prime}`);
        });
      },
    });
  }
  return jobs;
}
const quantile = (values, position) => values[Math.ceil(values.length * position) - 1];
export function runExactKernelBenchmark({ samples = 20 } = {}) {
  if (!Number.isSafeInteger(samples) || samples < 2 || samples > 100) {
    throw new RangeError('benchmark samples must be an integer from 2 to 100');
  }
  const results = [];
  for (const job of workloads()) {
    const expected = job.execute();
    job.verify(expected);
    const outputSha256 = hash(expected);
    for (let i = 0; i < 3; i++) { const warmup = job.execute(); job.verify(warmup); }
    const times = [];
    let maxRssBytes = process.memoryUsage().rss;
    for (let sample = 0; sample < samples; sample++) {
      let actual;
      const started = performance.now();
      for (let i = 0; i < job.batch; i++) actual = job.execute();
      const ms = (performance.now() - started) / job.batch;
      job.verify(actual);
      assert.equal(hash(actual), outputSha256, 'benchmark result changed between samples');
      times.push(ms);
      maxRssBytes = Math.max(maxRssBytes, process.memoryUsage().rss);
    }
    times.sort((a, b) => a - b);
    results.push({
      workload: job.name, inputSha256: hash(job.input), outputSha256,
      warmupIterations: 3, samples, operationsPerSample: job.batch,
      medianMsPerOperation: Number(quantile(times, 0.5).toFixed(6)),
      p95MsPerOperation: Number(quantile(times, 0.95).toFixed(6)),
      maxProcessRssBytes: maxRssBytes,
      verification: job.verification,
    });
  }
  return { schemaVersion: 1, description: 'Observed wall-clock samples; not performance guarantees',
    node: process.version, platform: process.platform, arch: process.arch, results };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length !== 4 || process.argv[2] !== '--out') {
    throw new Error('Usage: node gauss/benchmarks/exact-kernels.mjs --out <existing-evidence-directory/benchmark.json>');
  }
  const report = runExactKernelBenchmark();
  await writeFile(process.argv[3], `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`GAUSS_EXACT_BENCHMARK=${JSON.stringify(report)}`);
}
