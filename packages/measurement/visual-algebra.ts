import type { VisualAlgebraTerm } from "@nexus/visual-algebra";
import type { ConstraintEvaluation, GeometricMetricName } from "@nexus/visual-algebra";
import type { MetricSample } from "./index.js";

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

export interface VisualAlgebraMeasurementProjection {
  readonly authority: "NEXUS_VISUAL_ALGEBRA_MEASUREMENT_V1";
  readonly subject: string;
  readonly termDigest: string;
  readonly samples: readonly MetricSample[];
  readonly constraintEvaluations: readonly ConstraintEvaluation[];
  readonly constraintsPassed: boolean;
}

/**
 * Bridges immutable Visual Algebra output into the existing NEXUS measurement
 * surface without recomputing geometry or weakening provenance.
 */
export function projectVisualAlgebraMeasurement(
  term: VisualAlgebraTerm,
): VisualAlgebraMeasurementProjection {
  if (!term.subject.trim()) throw new Error("Visual Algebra term subject cannot be empty");
  if (!/^[a-f0-9]{64}$/.test(term.digest)) throw new Error("Visual Algebra term digest must be SHA-256 hex");

  const samples = METRICS.map((metric): MetricSample => {
    const value = term.metrics[metric];
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`Visual Algebra metric ${metric} must be finite and normalized to [0,1]`);
    }
    return Object.freeze({
      name: `visual_algebra.${metric}`,
      unit: "ratio",
      value,
    });
  });

  return Object.freeze({
    authority: "NEXUS_VISUAL_ALGEBRA_MEASUREMENT_V1",
    subject: term.subject,
    termDigest: term.digest,
    samples: Object.freeze(samples),
    constraintEvaluations: term.evaluations,
    constraintsPassed: term.evaluations.every((evaluation) => evaluation.pass),
  });
}
