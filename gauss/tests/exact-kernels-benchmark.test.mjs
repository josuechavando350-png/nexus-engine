import test from 'node:test';
import assert from 'node:assert/strict';
import { observedLatencyQuantiles, runExactKernelBenchmark } from '../benchmarks/exact-kernels.mjs';

test('reported median averages middle observations and nearest-rank p95 keeps its declared meaning', () => {
  const samples = [1000, 1, 100, 2];
  assert.deepEqual(observedLatencyQuantiles(samples), { medianMsPerOperation: 51, p95MsPerOperation: 1000 });
  assert.deepEqual(samples, [1000, 1, 100, 2], 'the sample array must remain unchanged');
  assert.deepEqual(observedLatencyQuantiles([3, 1, 2]), { medianMsPerOperation: 2, p95MsPerOperation: 3 });
  assert.deepEqual(observedLatencyQuantiles([1.0000001, 1.0000003]), {
    medianMsPerOperation: 1, p95MsPerOperation: 1,
  });
  for (const invalid of [[1], [], [1, NaN], [0, Infinity], [-1, 1], ['1', 2]]) {
    assert.throws(() => observedLatencyQuantiles(invalid), /latency samples/u);
  }
});

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
