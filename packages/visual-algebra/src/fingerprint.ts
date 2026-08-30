import { verifyVisualAlgebraTerm } from "./algebra.js";
import { geometricSimilarity } from "./distance.js";
import type {
  GeometricFingerprint,
  GeometricMetrics,
  MetricWeights,
  StyleStructureFields,
  VisualAlgebraTerm,
} from "./types.js";

export function projectToStructureFields(metrics: GeometricMetrics): StyleStructureFields {
  return Object.freeze({
    gridRegularity: metrics.gridRegularity,
    symmetry: metrics.axialSymmetry,
    overlap: metrics.overlap,
    whitespace: metrics.whitespace,
    continuity: metrics.continuity,
  });
}

export function enrichStructure<T extends Readonly<Record<string, unknown>>>(
  existing: T,
  metrics: GeometricMetrics,
): T & StyleStructureFields {
  return Object.freeze({
    ...existing,
    ...projectToStructureFields(metrics),
  }) as T & StyleStructureFields;
}

export function createGeometricFingerprint(term: VisualAlgebraTerm): GeometricFingerprint {
  verifyVisualAlgebraTerm(term);
  return Object.freeze({
    authority: "NEXUS_VISUAL_ALGEBRA_V1",
    subject: term.subject,
    termDigest: term.digest,
    metrics: term.metrics,
    structure: projectToStructureFields(term.metrics),
  });
}

export function compareGeometricFingerprints(
  left: GeometricFingerprint,
  right: GeometricFingerprint,
  weights: MetricWeights = {},
): number {
  return geometricSimilarity(left.metrics, right.metrics, weights);
}
