import type {
  GeometricMetricName,
  LegacyStructureFields,
  LegacyStructureProjection,
} from "./types.js";

const ALL_METRICS: readonly GeometricMetricName[] = Object.freeze([
  "gridRegularity",
  "axialSymmetry",
  "whitespace",
  "continuity",
  "overlap",
  "structuralEntropy",
  "aspectConsistency",
  "packingDensity",
]);

function assertOptionalUnitMetric(value: number | undefined, label: string): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite value in [0,1]`);
  }
}

export function fromLegacyStructure(structure: LegacyStructureFields): LegacyStructureProjection {
  assertOptionalUnitMetric(structure.gridRegularity, "gridRegularity");
  assertOptionalUnitMetric(structure.symmetry, "symmetry");
  assertOptionalUnitMetric(structure.overlap, "overlap");
  assertOptionalUnitMetric(structure.whitespace, "whitespace");
  assertOptionalUnitMetric(structure.continuity, "continuity");

  const metrics: Partial<Record<GeometricMetricName, number>> = {};
  if (structure.gridRegularity !== undefined) metrics.gridRegularity = structure.gridRegularity;
  if (structure.symmetry !== undefined) metrics.axialSymmetry = structure.symmetry;
  if (structure.overlap !== undefined) metrics.overlap = structure.overlap;
  if (structure.whitespace !== undefined) metrics.whitespace = structure.whitespace;
  if (structure.continuity !== undefined) metrics.continuity = structure.continuity;

  const availableMetrics = ALL_METRICS.filter((metric) => metrics[metric] !== undefined);
  const unavailableMetrics = ALL_METRICS.filter((metric) => metrics[metric] === undefined);

  return Object.freeze({
    source: "legacy-structure-only",
    metrics: Object.freeze(metrics),
    availableMetrics: Object.freeze(availableMetrics),
    unavailableMetrics: Object.freeze(unavailableMetrics),
    warnings: Object.freeze([
      "Legacy structure fields do not contain source geometry.",
      "No geometric primitives are synthesized or inferred by this adapter.",
      ...(unavailableMetrics.length > 0
        ? [`Unavailable metrics remain unknown: ${unavailableMetrics.join(", ")}`]
        : []),
    ]),
  });
}
