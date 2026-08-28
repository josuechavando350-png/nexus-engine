export type PrimitiveKind =
  | "rectangle"
  | "ellipse"
  | "line"
  | "polygon"
  | "text"
  | "image"
  | "container";

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type PrimitiveMetadata = Readonly<Record<string, string | number | boolean | null>>;

interface PrimitiveBase {
  readonly id: string;
  readonly kind: PrimitiveKind;
  readonly bounds: Bounds;
  readonly metadata?: PrimitiveMetadata;
}

export interface BoxPrimitive extends PrimitiveBase {
  readonly kind: "rectangle" | "ellipse" | "text" | "image";
}

export interface LinePrimitive extends PrimitiveBase {
  readonly kind: "line";
  readonly start: Point;
  readonly end: Point;
}

export interface PolygonPrimitive extends PrimitiveBase {
  readonly kind: "polygon";
  readonly points: readonly Point[];
}

export interface ContainerPrimitive extends PrimitiveBase {
  readonly kind: "container";
  readonly children: readonly GeometricPrimitive[];
}

export type GeometricPrimitive = BoxPrimitive | LinePrimitive | PolygonPrimitive | ContainerPrimitive;

export type PrimitiveInput =
  | {
      readonly id: string;
      readonly kind: "rectangle" | "ellipse" | "text" | "image";
      readonly bounds: Bounds;
      readonly metadata?: PrimitiveMetadata;
    }
  | {
      readonly id: string;
      readonly kind: "line";
      readonly start: Point;
      readonly end: Point;
      readonly metadata?: PrimitiveMetadata;
    }
  | {
      readonly id: string;
      readonly kind: "polygon";
      readonly points: readonly Point[];
      readonly metadata?: PrimitiveMetadata;
    }
  | {
      readonly id: string;
      readonly kind: "container";
      readonly bounds?: Bounds;
      readonly children: readonly (GeometricPrimitive | PrimitiveInput)[];
      readonly metadata?: PrimitiveMetadata;
    };

export interface GeometricMetrics {
  readonly gridRegularity: number;
  readonly axialSymmetry: number;
  readonly whitespace: number;
  readonly continuity: number;
  readonly overlap: number;
  readonly structuralEntropy: number;
  readonly aspectConsistency: number;
  readonly packingDensity: number;
}

export type GeometricMetricName = keyof GeometricMetrics;

export interface MetricConstraint {
  readonly id: string;
  readonly metric: GeometricMetricName;
  readonly min?: number;
  readonly max?: number;
}

export interface ConstraintEvaluation {
  readonly constraint: MetricConstraint;
  readonly actual: number;
  readonly expected: Readonly<{ min?: number; max?: number }>;
  readonly pass: boolean;
  readonly reason: string;
}

export type AlgebraOperation = "atomic" | "sequence" | "nest";

export interface VisualAlgebraTerm {
  readonly subject: string;
  readonly operation: AlgebraOperation;
  readonly canvasBounds: Bounds;
  readonly primitives: readonly GeometricPrimitive[];
  readonly metrics: GeometricMetrics;
  readonly constraints: readonly MetricConstraint[];
  readonly evaluations: readonly ConstraintEvaluation[];
  readonly digest: string;
}

export interface CreateTermInput {
  readonly subject: string;
  readonly primitives: readonly (GeometricPrimitive | PrimitiveInput)[];
  readonly canvasBounds?: Bounds;
  readonly constraints?: readonly MetricConstraint[];
}

export interface SequenceInput {
  readonly subject: string;
  readonly terms: readonly VisualAlgebraTerm[];
  readonly canvasBounds?: Bounds;
  readonly constraints?: readonly MetricConstraint[];
}

export interface NestInput {
  readonly subject: string;
  readonly container: GeometricPrimitive | PrimitiveInput;
  readonly terms: readonly VisualAlgebraTerm[];
  readonly canvasBounds?: Bounds;
  readonly constraints?: readonly MetricConstraint[];
}

export type MetricWeights = Partial<Record<GeometricMetricName, number>>;

export interface MetricDistanceContribution {
  readonly metric: GeometricMetricName;
  readonly left: number;
  readonly right: number;
  readonly weight: number;
  readonly absoluteDelta: number;
  readonly weightedSquaredDelta: number;
}

export interface GeometricDistance {
  readonly distance: number;
  readonly contributions: readonly MetricDistanceContribution[];
}

/**
 * Structural compatibility surface for a future canonical NEXUS style fingerprint.
 * The current repository has no StyleFingerprintV2 contract, so this package does
 * not fabricate one or claim that the projection is already consumed by it.
 */
export interface StyleStructureFields {
  readonly gridRegularity: number;
  readonly symmetry: number;
  readonly overlap: number;
  readonly whitespace: number;
  readonly continuity: number;
}

export interface GeometricFingerprint {
  readonly authority: "NEXUS_VISUAL_ALGEBRA_V1";
  readonly subject: string;
  readonly termDigest: string;
  readonly metrics: GeometricMetrics;
  readonly structure: StyleStructureFields;
}

export interface LegacyStructureFields {
  readonly gridRegularity?: number;
  readonly symmetry?: number;
  readonly overlap?: number;
  readonly whitespace?: number;
  readonly continuity?: number;
}

export interface LegacyStructureProjection {
  readonly source: "legacy-structure-only";
  readonly metrics: Readonly<Partial<GeometricMetrics>>;
  readonly availableMetrics: readonly GeometricMetricName[];
  readonly unavailableMetrics: readonly GeometricMetricName[];
  readonly warnings: readonly string[];
}
