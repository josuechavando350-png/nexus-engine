import { describe, expect, it } from "vitest";
import { aggregateSamples, executeBenchmark, type BenchmarkPolicy, type BenchmarkWorkloadPort } from "./index";
import type { MeasurementRun } from "../measurement/index";

const run: MeasurementRun = {
  runId: "run_test",
  workloadId: "hero-motion",
  workloadVersion: "1.0.0",
  workloadDigest: "wrk_test",
  environmentDigest: "env_test",
  scope: { tenantId: "tenant-a", brandId: "brand-a" },
  startedAt: "2026-08-15T19:00:00.000Z"
};

const policy: BenchmarkPolicy = {
  warmupRuns: 1,
  sampleRuns: 3,
  aggregation: "MEDIAN",
  rejectNonFinite: true
};

describe("benchmark executor", () => {
  it("aggregates deterministic median values", () => {
    const result = aggregateSamples([
      { iteration: 0, metrics: [{ name: "frameTime", unit: "ms", value: 8 }] },
      { iteration: 1, metrics: [{ name: "frameTime", unit: "ms", value: 10 }] },
      { iteration: 2, metrics: [{ name: "frameTime", unit: "ms", value: 9 }] }
    ], "MEDIAN");
    expect(result).toEqual([{ name: "frameTime", unit: "ms", value: 9 }]);
  });

  it("rejects inconsistent metric sets", () => {
    expect(() => aggregateSamples([
      { iteration: 0, metrics: [{ name: "frameTime", unit: "ms", value: 8 }] },
      { iteration: 1, metrics: [{ name: "fps", unit: "count", value: 60 }] }
    ], "MEAN")).toThrow("same metric names and units");
  });

  it("rejects non-finite values", () => {
    expect(() => aggregateSamples([
      { iteration: 0, metrics: [{ name: "frameTime", unit: "ms", value: Number.NaN }] }
    ], "MEAN")).toThrow("must be finite");
  });

  it("executes warmups separately and stores raw samples", async () => {
    const calls: number[] = [];
    const workload: BenchmarkWorkloadPort = {
      async execute(_run, iteration) {
        calls.push(iteration);
        return [{ name: "frameTime", unit: "ms", value: iteration + 1 }];
      }
    };

    const first = await executeBenchmark(run, policy, workload);
    const secondCalls: number[] = [];
    const second = await executeBenchmark(run, policy, {
      async execute(_run, iteration) {
        secondCalls.push(iteration);
        return [{ name: "frameTime", unit: "ms", value: iteration + 1 }];
      }
    });

    expect(calls).toEqual([0, 1, 2, 3]);
    expect(secondCalls).toEqual(calls);
    expect(first.rawSamples).toHaveLength(3);
    expect(first.aggregates).toEqual([{ name: "frameTime", unit: "ms", value: 3 }]);
    expect(first.executionId).toBe(second.executionId);
  });

  it("rejects empty measurement iterations", async () => {
    await expect(executeBenchmark(run, { ...policy, warmupRuns: 0, sampleRuns: 1 }, {
      async execute() { return []; }
    })).rejects.toThrow("at least one metric");
  });
});
