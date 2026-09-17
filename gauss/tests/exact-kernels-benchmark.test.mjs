import test from 'node:test';
import assert from 'node:assert/strict';
import { runExactKernelBenchmark } from '../benchmarks/exact-kernels.mjs';

test('exact arithmetic benchmark uses real checked workloads and stable input/output identities', () => {
  const first = runExactKernelBenchmark({ samples: 2 });
  const second = runExactKernelBenchmark({ samples: 2 });
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.results.length, 3);
  assert.equal(first.node, process.version);
  assert.deepEqual(first.results.map(({ workload, inputSha256, outputSha256, verification }) =>
    ({ workload, inputSha256, outputSha256, verification })),
  second.results.map(({ workload, inputSha256, outputSha256, verification }) =>
    ({ workload, inputSha256, outputSha256, verification })));
  for (const result of first.results) {
    assert.match(result.inputSha256, /^sha256:[a-f0-9]{64}$/u);
    assert.match(result.outputSha256, /^sha256:[a-f0-9]{64}$/u);
    assert(Number.isFinite(result.medianMsPerOperation) && result.medianMsPerOperation >= 0);
    assert(Number.isFinite(result.p95MsPerOperation) && result.p95MsPerOperation >= result.medianMsPerOperation);
    assert(Number.isSafeInteger(result.maxProcessRssBytes) && result.maxProcessRssBytes > 0);
    assert.equal(result.samples, 2);
  }
  assert.equal(first.results[0].verification, 'known-exact-rational-solution');
  assert.equal(first.results[2].verification, 'independent-finite-field-determinant-two-primes');
});

test('benchmark refuses unbounded iteration counts', () => {
  for (const samples of [0, 1, 101, 2.5, Number.NaN, '100']) {
    assert.throws(() => runExactKernelBenchmark({ samples }), /samples must be an integer/u);
  }
});
