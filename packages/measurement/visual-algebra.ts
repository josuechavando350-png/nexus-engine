import { createTerm, verifyVisualAlgebraTerm } from "@nexus/visual-algebra";
import type {
  ConstraintEvaluation,
  GeometricMetricName,
  PrimitiveInput,
  VisualAlgebraTerm,
} from "@nexus/visual-algebra";
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

export type SaliencyVisualEvidenceType = "MODEL_PREDICTION" | "HUMAN_OBSERVATION";

export interface SaliencyVisualRegionInput {
  readonly id: string;
  readonly rank: number;
  readonly score: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SaliencyVisualAlgebraInput {
  readonly subject: string;
  readonly evidenceType: SaliencyVisualEvidenceType;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly regions: readonly SaliencyVisualRegionInput[];
}

function finitePositive(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} must be finite and > 0`);
  return value;
}

function finiteNonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be finite and >= 0`);
  return value;
}

/**
 * Converts bounded saliency regions into the canonical Visual Algebra surface.
 * The source evidence type is retained in primitive metadata; this function never
 * upgrades model predictions into human observations.
 */
export function createSaliencyVisualAlgebraTerm(input: SaliencyVisualAlgebraInput): VisualAlgebraTerm {
  const subject = input.subject.trim();
  if (!subject || subject.length > 256) throw new Error("saliency Visual Algebra subject must be between 1 and 256 characters");
  const canvasWidth = finitePositive(input.canvasWidth, "canvasWidth");
  const canvasHeight = finitePositive(input.canvasHeight, "canvasHeight");
  if (canvasWidth > 100_000 || canvasHeight > 100_000) throw new Error("saliency Visual Algebra canvas exceeds 100000px");
  if (input.regions.length === 0 || input.regions.length > 64) throw new Error("saliency Visual Algebra requires 1 to 64 regions");

  const seen = new Set<string>();
  const primitives: PrimitiveInput[] = input.regions.map((region) => {
    const id = region.id.trim();
    if (!id || id.length > 128) throw new Error("saliency region id must be between 1 and 128 characters");
    if (seen.has(id)) throw new Error(`duplicate saliency region id ${id}`);
    seen.add(id);
    if (!Number.isSafeInteger(region.rank) || region.rank < 1 || region.rank > 64) throw new Error("saliency region rank must be an integer from 1 to 64");
    const score = finiteNonNegative(region.score, "saliency region score");
    if (score > 1) throw new Error("saliency region score must be <= 1");
    const x = finiteNonNegative(region.x, "saliency region x");
    const y = finiteNonNegative(region.y, "saliency region y");
    const width = finitePositive(region.width, "saliency region width");
    const height = finitePositive(region.height, "saliency region height");
    if (x + width > canvasWidth + 1e-9 || y + height > canvasHeight + 1e-9) throw new Error("saliency region exceeds canvas bounds");
    return Object.freeze({
      id,
      kind: "rectangle" as const,
      bounds: Object.freeze({ x, y, width, height }),
      metadata: Object.freeze({
        saliencyEvidenceType: input.evidenceType,
        saliencyRank: region.rank,
        saliencyScore: score,
      }),
    });
  });

  return createTerm({
    subject: `${subject}:saliency`,
    canvasBounds: Object.freeze({ x: 0, y: 0, width: canvasWidth, height: canvasHeight }),
    primitives: Object.freeze(primitives),
  });
}

/**
 * Bridges immutable Visual Algebra output into the existing NEXUS measurement
 * surface without recomputing geometry or weakening provenance.
 */
export function projectVisualAlgebraMeasurement(
  term: VisualAlgebraTerm,
): VisualAlgebraMeasurementProjection {
  verifyVisualAlgebraTerm(term);

  const samples = METRICS.map((metric): MetricSample => {
    const value = term.metrics[metric];
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
