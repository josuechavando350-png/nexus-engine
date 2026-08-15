import { assertCanonicalId, assertScope, lexicalCompare, type CreativeScope } from "../shared";

export type VisualQaErrorCode = "INVALID_INPUT" | "SCOPE_MISMATCH" | "NO_MEASUREMENTS";
export class VisualQaError extends Error {
  constructor(readonly code: VisualQaErrorCode, message: string) {
    super(message);
    this.name = "VisualQaError";
  }
}

export type VisualMetric = "layoutShift" | "contrast" | "frameTimeMs" | "droppedFrameRatio" | "gpuTimeMs";
export type MetricDirection = "MAX" | "MIN";
export type MetricBudget = Readonly<{ metric: VisualMetric; direction: MetricDirection; threshold: number; weight: number }>;
export type VisualQaProfile = Readonly<{ profileId: string; scope: CreativeScope; budgets: readonly MetricBudget[] }>;
export type VisualMeasurement = Readonly<{ measurementId: string; scope: CreativeScope; scenarioId: string; metric: VisualMetric; value: number }>;
export type VisualMetricResult = Readonly<{ metric: VisualMetric; value: number; threshold: number; passed: boolean; normalizedScore: number; weight: number }>;
export type VisualQaReport = Readonly<{
  profileId: string;
  scenarioId: string;
  scope: CreativeScope;
  passed: boolean;
  score: number;
  results: readonly VisualMetricResult[];
}>;

export type BenchmarkSample = Readonly<{
  sampleId: string;
  scope: CreativeScope;
  scenarioId: string;
  backend: string;
  iterations: number;
  durationMs: number;
  frameTimeP50Ms: number;
  frameTimeP95Ms: number;
  gpuTimeP95Ms: number;
  droppedFrameRatio: number;
}>;

export type BenchmarkBaseline = Readonly<{
  scenarioId: string;
  backend: string;
  frameTimeP95Ms: number;
  gpuTimeP95Ms: number;
  droppedFrameRatio: number;
}>;

export type BenchmarkRegressionPolicy = Readonly<{
  maxFrameTimeRegressionRatio: number;
  maxGpuTimeRegressionRatio: number;
  maxDroppedFrameIncrease: number;
}>;

export type BenchmarkComparison = Readonly<{
  scenarioId: string;
  backend: string;
  passed: boolean;
  frameTimeRegressionRatio: number;
  gpuTimeRegressionRatio: number;
  droppedFrameIncrease: number;
}>;

function finite(value: number, field: string): void {
  if (!Number.isFinite(value)) throw new VisualQaError("INVALID_INPUT", `${field} must be finite`);
}
function validateScopeMatch(expected: CreativeScope, actual: CreativeScope): void {
  if (expected.tenantId !== actual.tenantId || expected.brandId !== actual.brandId) throw new VisualQaError("SCOPE_MISMATCH", "visual QA scope mismatch");
}

export function validateProfile(profile: VisualQaProfile): VisualQaProfile {
  try { assertCanonicalId(profile.profileId, "profile.profileId"); assertScope(profile.scope); } catch (error) {
    throw new VisualQaError("INVALID_INPUT", error instanceof Error ? error.message : "invalid profile");
  }
  if (!Array.isArray(profile.budgets) || !profile.budgets.length) throw new VisualQaError("INVALID_INPUT", "profile requires budgets");
  const metrics = new Set<VisualMetric>();
  let totalWeight = 0;
  for (const budget of profile.budgets) {
    finite(budget.threshold, "budget.threshold"); finite(budget.weight, "budget.weight");
    if (budget.threshold < 0 || budget.weight <= 0) throw new VisualQaError("INVALID_INPUT", "threshold must be non-negative and weight positive");
    if (metrics.has(budget.metric)) throw new VisualQaError("INVALID_INPUT", "budget metrics must be unique");
    metrics.add(budget.metric); totalWeight += budget.weight;
  }
  if (totalWeight <= 0) throw new VisualQaError("INVALID_INPUT", "profile weight must be positive");
  return Object.freeze({ ...profile, scope: Object.freeze({ ...profile.scope }), budgets: Object.freeze([...profile.budgets].sort((a, b) => lexicalCompare(a.metric, b.metric))) });
}

export function evaluateVisualQa(profileInput: VisualQaProfile, measurements: readonly VisualMeasurement[]): VisualQaReport {
  const profile = validateProfile(profileInput);
  if (!Array.isArray(measurements) || !measurements.length) throw new VisualQaError("NO_MEASUREMENTS", "visual QA requires measurements");
  const scenarioIds = [...new Set(measurements.map((measurement) => measurement.scenarioId))];
  if (scenarioIds.length !== 1) throw new VisualQaError("INVALID_INPUT", "measurements must belong to one scenario");
  for (const measurement of measurements) {
    try { assertCanonicalId(measurement.measurementId, "measurement.measurementId"); assertCanonicalId(measurement.scenarioId, "measurement.scenarioId"); assertScope(measurement.scope); } catch (error) {
      throw new VisualQaError("INVALID_INPUT", error instanceof Error ? error.message : "invalid measurement");
    }
    validateScopeMatch(profile.scope, measurement.scope);
    finite(measurement.value, "measurement.value");
    if (measurement.value < 0) throw new VisualQaError("INVALID_INPUT", "measurement value must be non-negative");
  }
  const byMetric = new Map<VisualMetric, number[]>();
  for (const measurement of measurements) {
    const bucket = byMetric.get(measurement.metric) ?? [];
    bucket.push(measurement.value); byMetric.set(measurement.metric, bucket);
  }
  let weighted = 0; let weightTotal = 0;
  const results = profile.budgets.map((budget): VisualMetricResult => {
    const values = byMetric.get(budget.metric);
    if (!values?.length) throw new VisualQaError("NO_MEASUREMENTS", `missing measurement for ${budget.metric}`);
    const value = values.reduce((sum, item) => sum + item, 0) / values.length;
    const passed = budget.direction === "MAX" ? value <= budget.threshold : value >= budget.threshold;
    const normalizedScore = budget.threshold === 0
      ? (passed ? 1 : 0)
      : Math.max(0, Math.min(1, budget.direction === "MAX" ? 1 - value / budget.threshold : value / budget.threshold));
    weighted += normalizedScore * budget.weight; weightTotal += budget.weight;
    return Object.freeze({ metric: budget.metric, value, threshold: budget.threshold, passed, normalizedScore, weight: budget.weight });
  }).sort((a, b) => lexicalCompare(a.metric, b.metric));
  return Object.freeze({ profileId: profile.profileId, scenarioId: scenarioIds[0]!, scope: Object.freeze({ ...profile.scope }), passed: results.every((result) => result.passed), score: weightTotal ? weighted / weightTotal : 0, results: Object.freeze(results) });
}

export function compareBenchmark(sample: BenchmarkSample, baseline: BenchmarkBaseline, policy: BenchmarkRegressionPolicy): BenchmarkComparison {
  try { assertCanonicalId(sample.sampleId, "sample.sampleId"); assertCanonicalId(sample.scenarioId, "sample.scenarioId"); assertScope(sample.scope); assertCanonicalId(baseline.scenarioId, "baseline.scenarioId"); } catch (error) {
    throw new VisualQaError("INVALID_INPUT", error instanceof Error ? error.message : "invalid benchmark input");
  }
  for (const [field, value] of Object.entries({ iterations: sample.iterations, durationMs: sample.durationMs, frameTimeP50Ms: sample.frameTimeP50Ms, frameTimeP95Ms: sample.frameTimeP95Ms, gpuTimeP95Ms: sample.gpuTimeP95Ms, droppedFrameRatio: sample.droppedFrameRatio, baselineFrame: baseline.frameTimeP95Ms, baselineGpu: baseline.gpuTimeP95Ms, baselineDropped: baseline.droppedFrameRatio, maxFrame: policy.maxFrameTimeRegressionRatio, maxGpu: policy.maxGpuTimeRegressionRatio, maxDrop: policy.maxDroppedFrameIncrease })) finite(value, field);
  if (sample.iterations <= 0 || sample.durationMs <= 0 || sample.frameTimeP50Ms < 0 || sample.frameTimeP95Ms < 0 || sample.gpuTimeP95Ms < 0 || sample.droppedFrameRatio < 0 || sample.droppedFrameRatio > 1) throw new VisualQaError("INVALID_INPUT", "benchmark sample values out of range");
  if (baseline.frameTimeP95Ms <= 0 || baseline.gpuTimeP95Ms <= 0 || baseline.droppedFrameRatio < 0 || baseline.droppedFrameRatio > 1) throw new VisualQaError("INVALID_INPUT", "benchmark baseline values out of range");
  if (sample.scenarioId !== baseline.scenarioId || sample.backend !== baseline.backend) throw new VisualQaError("INVALID_INPUT", "benchmark sample and baseline must match scenario/backend");
  if (policy.maxFrameTimeRegressionRatio < 0 || policy.maxGpuTimeRegressionRatio < 0 || policy.maxDroppedFrameIncrease < 0) throw new VisualQaError("INVALID_INPUT", "benchmark policy limits must be non-negative");
  const frameTimeRegressionRatio = sample.frameTimeP95Ms / baseline.frameTimeP95Ms - 1;
  const gpuTimeRegressionRatio = sample.gpuTimeP95Ms / baseline.gpuTimeP95Ms - 1;
  const droppedFrameIncrease = sample.droppedFrameRatio - baseline.droppedFrameRatio;
  return Object.freeze({ scenarioId: sample.scenarioId, backend: sample.backend, passed: frameTimeRegressionRatio <= policy.maxFrameTimeRegressionRatio && gpuTimeRegressionRatio <= policy.maxGpuTimeRegressionRatio && droppedFrameIncrease <= policy.maxDroppedFrameIncrease, frameTimeRegressionRatio, gpuTimeRegressionRatio, droppedFrameIncrease });
}
