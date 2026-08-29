export type {
  AlgebraOperation,
  Bounds,
  ConstraintEvaluation,
  ContainerPrimitive,
  CreateTermInput,
  GeometricDistance,
  GeometricFingerprint,
  GeometricMetricName,
  GeometricMetrics,
  GeometricPrimitive,
  LegacyStructureFields,
  LegacyStructureProjection,
  LinePrimitive,
  MetricConstraint,
  MetricDistanceContribution,
  MetricWeights,
  NestInput,
  Point,
  PolygonPrimitive,
  PrimitiveInput,
  PrimitiveKind,
  PrimitiveMetadata,
  SequenceInput,
  StyleStructureFields,
  VisualAlgebraTerm,
} from "./types.js";

export {
  assertUniquePrimitiveIds,
  boundsFromPoints,
  clipBounds,
  definePrimitive,
  flattenPrimitives,
  intersectionArea,
  intersectionBounds,
  leafPrimitives,
  overlapRatio,
  primitiveArea,
  primitiveCenter,
  rectangleUnionArea,
  unionBounds,
  validateBounds,
  validatePrimitive,
} from "./primitives.js";

export {
  aspectConsistency,
  axialSymmetry,
  computeGeometricMetrics,
  continuity,
  gridRegularity,
  overlap,
  packingDensity,
  structuralEntropy,
  whitespace,
} from "./metrics.js";

export {
  canonicalJson,
  createTerm,
  digestValue,
  evaluateConstraints,
  nest,
  sequence,
  termSatisfiesConstraints,
  validateConstraint,
} from "./algebra.js";

export { geometricDistance, geometricSimilarity } from "./distance.js";

export {
  compareGeometricFingerprints,
  createGeometricFingerprint,
  enrichStructure,
  projectToStructureFields,
} from "./fingerprint.js";

export { fromLegacyStructure } from "./from-fingerprint.js";
