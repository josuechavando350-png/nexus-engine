import type { MeasurementRun, MetricSample } from "../measurement/index";
import { deterministicId } from "../measurement/index";

export type AggregationMethod = "MEAN" | "MEDIAN" | "P95";

export interface BenchmarkPolicy {
  warmupRuns: number;
  sampleRuns: number;
  aggregation: AggregationMethod;
  rejectNonFinite: boolean;
}

export interface BenchmarkSample {
  iteration: number;
  metrics: readonly MetricSample[];
}

export interface BenchmarkExecution {
  executionId: string;
  runId: string;
  policy: BenchmarkPolicy;
  rawSamples: readonly BenchmarkSample[];
  aggregates: readonly MetricSample[];
}

export interface BenchmarkWorkloadPort {
  execute(run: MeasurementRun, iteration: number): Promise<readonly MetricSample[]>;
}

export class BenchmarkValidationError extends Error {
  constructor(public readonly code: "INVALID_POLICY" | "INVALID_SAMPLE" | "INCONSISTENT_METRICS", message: string) {
    super(message);
    this.name = "BenchmarkValidationError";
  }
}

function assertPositiveInteger(value: number, field: string, allowZero = false): void {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new BenchmarkValidationError("INVALID_POLICY", `${field} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
}

export function validateBenchmarkPolicy(policy: BenchmarkPolicy): void {
  assertPositiveInteger(policy.warmupRuns, "warmupRuns", true);
  assertPositiveInteger(policy.sampleRuns, "sampleRuns");
}

function assertFiniteSample(sample: MetricSample): void {
  if (!sample.name.trim() || !sample.unit.trim()) throw new BenchmarkValidationError("INVALID_SAMPLE", "metric name and unit are required");
  if (!Number.isFinite(sample.value)) throw new BenchmarkValidationError("INVALID_SAMPLE", `${sample.name} must be finite`);
}

function percentile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(q * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))]!;
}

export function aggregateSamples(samples: readonly BenchmarkSample[], method: AggregationMethod): readonly MetricSample[] {
  if (samples.length === 0) throw new BenchmarkValidationError("INVALID_SAMPLE", "at least one benchmark sample is required");

  const signature = samples[0]!.metrics.map(({ name, unit }) => `${name}\u0000${unit}`).sort();
  const buckets = new Map<string, { name: string; unit: string; values: number[] }>();

  for (const sample of samples) {
    const currentSignature = sample.metrics.map(({ name, unit }) => `${name}\u0000${unit}`).sort();
    if (JSON.stringify(currentSignature) !== JSON.stringify(signature)) {
      throw new BenchmarkValidationError("INCONSISTENT_METRICS", "every sample iteration must contain the same metric names and units");
    }
    for (const metric of sample.metrics) {
      assertFiniteSample(metric);
      const key = `${metric.name}\u0000${metric.unit}`;
      const bucket = buckets.get(key) ?? { name: metric.name, unit: metric.unit, values: [] };
      bucket.values.push(metric.value);
      buckets.set(key, bucket);
    }
  }

  return [...buckets.values()]
    .sort((a, b) => `${a.name}\u0000${a.unit}`.localeCompare(`${b.name}\u0000${b.unit}`))
    .map(({ name, unit, values }) => {
      const value = method === "MEAN"
        ? values.reduce((sum, item) => sum + item, 0) / values.length
        : method === "MEDIAN"
          ? percentile(values, 0.5)
          : percentile(values, 0.95);
      return { name, unit, value };
    });
}

export async function executeBenchmark(run: MeasurementRun, policy: BenchmarkPolicy, workload: BenchmarkWorkloadPort): Promise<BenchmarkExecution> {
  validateBenchmarkPolicy(policy);

  for (let iteration = 0; iteration < policy.warmupRuns; iteration += 1) {
    await workload.execute(run, iteration);
  }

  const rawSamples: BenchmarkSample[] = [];
  for (let iteration = 0; iteration < policy.sampleRuns; iteration += 1) {
    const metrics = await workload.execute(run, policy.warmupRuns + iteration);
    if (metrics.length === 0) throw new BenchmarkValidationError("INVALID_SAMPLE", "benchmark iteration must emit at least one metric");
    if (policy.rejectNonFinite) metrics.forEach(assertFiniteSample);
    rawSamples.push({ iteration, metrics: [...metrics] });
  }

  const aggregates = aggregateSamples(rawSamples, policy.aggregation);
  const executionId = deterministicId("bench", {
    runId: run.runId,
    policy,
    rawSamples
  });

  return { executionId, runId: run.runId, policy, rawSamples, aggregates };
}
