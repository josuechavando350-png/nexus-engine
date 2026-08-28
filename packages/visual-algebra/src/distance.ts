import type {
  GeometricDistance,
  GeometricMetricName,
  GeometricMetrics,
  MetricWeights,
} from "./types.js";

const METRICS: readonly GeometricMetricName[] = Object.freeze([
  "gridRegularity",
  "axialSymmetry",
  "whitespace",
  "continuity",
  "overlap",
  "structuralEntropy",
  "aspectConsistency",
  "packingDensity",
]);

export function geometricDistance(
  left: GeometricMetrics,
  right: GeometricMetrics,
  weights: MetricWeights = {},
): GeometricDistance {
  let weightSum = 0;
  let weightedSquaredSum = 0;

  const contributions = METRICS.map((metric) => {
    const leftValue = left[metric];
    const rightValue = right[metric];

    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
      throw new Error(`Metric ${metric} must be finite on both fingerprints`);
    }

    if (leftValue < 0 || leftValue > 1 || rightValue < 0 || rightValue > 1) {
      throw new Error(`Metric ${metric} must be normalized to [0,1] on both fingerprints`);
    }

    const weight = weights[metric] ?? 1;
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(`Weight for ${metric} must be a finite non-negative number`);
    }

    const absoluteDelta = Math.abs(leftValue - rightValue);
    const weightedSquaredDelta = weight * absoluteDelta * absoluteDelta;
    weightSum += weight;
    weightedSquaredSum += weightedSquaredDelta;

    return Object.freeze({
      metric,
      left: leftValue,
      right: rightValue,
      weight,
      absoluteDelta,
      weightedSquaredDelta,
    });
  });

  if (weightSum <= 0) throw new Error("At least one metric weight must be positive");

  return Object.freeze({
    distance: Math.sqrt(weightedSquaredSum / weightSum),
    contributions: Object.freeze(contributions),
  });
}

export function geometricSimilarity(
  left: GeometricMetrics,
  right: GeometricMetrics,
  weights: MetricWeights = {},
): number {
  return Math.max(0, Math.min(1, 1 - geometricDistance(left, right, weights).distance));
}
