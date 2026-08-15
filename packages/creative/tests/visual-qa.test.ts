import { describe, expect, it } from "vitest";
import { compareBenchmark, evaluateVisualQa, VisualQaError, type BenchmarkBaseline, type BenchmarkRegressionPolicy, type BenchmarkSample, type VisualMeasurement, type VisualQaProfile } from "../visual-qa";

const scope = Object.freeze({ tenantId: "tenant-a", brandId: "brand-a" });
const profile: VisualQaProfile = Object.freeze({ profileId: "visual-profile-1", scope, budgets: Object.freeze([
  Object.freeze({ metric: "layoutShift", direction: "MAX", threshold: 0.1, weight: 1 }),
  Object.freeze({ metric: "contrast", direction: "MIN", threshold: 4.5, weight: 1 }),
  Object.freeze({ metric: "frameTimeMs", direction: "MAX", threshold: 16.7, weight: 2 })
]) });

const measurements: readonly VisualMeasurement[] = Object.freeze([
  Object.freeze({ measurementId: "m-1", scope, scenarioId: "hero-1", metric: "frameTimeMs", value: 12 }),
  Object.freeze({ measurementId: "m-2", scope, scenarioId: "hero-1", metric: "layoutShift", value: 0.02 }),
  Object.freeze({ measurementId: "m-3", scope, scenarioId: "hero-1", metric: "contrast", value: 7 })
]);

const sample: BenchmarkSample = Object.freeze({ sampleId: "sample-1", scope, scenarioId: "hero-1", backend: "webgpu", iterations: 120, durationMs: 2000, frameTimeP50Ms: 9, frameTimeP95Ms: 14, gpuTimeP95Ms: 7, droppedFrameRatio: 0.01 });
const baseline: BenchmarkBaseline = Object.freeze({ scenarioId: "hero-1", backend: "webgpu", frameTimeP95Ms: 13, gpuTimeP95Ms: 6.5, droppedFrameRatio: 0.005 });
const policy: BenchmarkRegressionPolicy = Object.freeze({ maxFrameTimeRegressionRatio: 0.1, maxGpuTimeRegressionRatio: 0.1, maxDroppedFrameIncrease: 0.01 });

describe("visual QA and benchmark evaluation", () => {
  it("evaluates visual budgets deterministically regardless of measurement order", () => {
    const first = evaluateVisualQa(profile, measurements);
    const second = evaluateVisualQa(profile, [...measurements].reverse());
    expect(second).toEqual(first);
    expect(first.passed).toBe(true);
    expect(first.results.map((result) => result.metric)).toEqual(["contrast", "frameTimeMs", "layoutShift"]);
  });

  it("fails a visual budget when a threshold is exceeded", () => {
    const report = evaluateVisualQa(profile, measurements.map((measurement) => measurement.metric === "frameTimeMs" ? { ...measurement, value: 30 } : measurement));
    expect(report.passed).toBe(false);
    expect(report.results.find((result) => result.metric === "frameTimeMs")?.passed).toBe(false);
  });

  it("rejects cross-scope measurements and missing metrics", () => {
    expect(() => evaluateVisualQa(profile, [{ ...measurements[0]!, scope: { tenantId: "tenant-b", brandId: "brand-a" } }, ...measurements.slice(1)])).toThrowError(VisualQaError);
    expect(() => evaluateVisualQa(profile, measurements.filter((measurement) => measurement.metric !== "contrast"))).toThrowError(VisualQaError);
  });

  it("rejects NaN and invalid duplicate profile budgets", () => {
    expect(() => evaluateVisualQa(profile, [{ ...measurements[0]!, value: Number.NaN }, ...measurements.slice(1)])).toThrowError(VisualQaError);
    expect(() => evaluateVisualQa({ ...profile, budgets: [profile.budgets[0]!, profile.budgets[0]!] }, measurements)).toThrowError(VisualQaError);
  });

  it("compares benchmark results against an explicit regression policy", () => {
    const result = compareBenchmark(sample, baseline, policy);
    expect(result.passed).toBe(true);
    expect(result.frameTimeRegressionRatio).toBeCloseTo(14 / 13 - 1);
  });

  it("fails benchmark regressions outside policy", () => {
    const result = compareBenchmark({ ...sample, frameTimeP95Ms: 20 }, baseline, policy);
    expect(result.passed).toBe(false);
  });

  it("rejects mismatched scenario/backend and invalid numeric samples", () => {
    expect(() => compareBenchmark({ ...sample, backend: "webgl2" }, baseline, policy)).toThrowError(VisualQaError);
    expect(() => compareBenchmark({ ...sample, iterations: 0 }, baseline, policy)).toThrowError(VisualQaError);
    expect(() => compareBenchmark({ ...sample, droppedFrameRatio: Number.POSITIVE_INFINITY }, baseline, policy)).toThrowError(VisualQaError);
  });
});
