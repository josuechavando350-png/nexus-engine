import type { Bounds, GeometricPrimitive, PrimitiveKind } from "@nexus/visual-algebra";

export interface TopologyPoint { readonly x: number; readonly y: number; }
export interface FiltrationVertex {
  readonly id: string;
  readonly sourcePrimitiveId: string;
  readonly primitiveKind: Exclude<PrimitiveKind, "container">;
  readonly point: TopologyPoint;
}
export interface TopologicalRelation { readonly sourceId: string; readonly targetId: string; readonly filtration: number; }
export type SimplexDimension = 0 | 1 | 2;
export interface FilteredSimplex {
  readonly id: string;
  readonly vertices: readonly string[];
  readonly dimension: SimplexDimension;
  readonly filtration: number;
}
export interface FiltrationComplex {
  readonly authority: "NEXUS_FILTERED_FLAG_COMPLEX_V1";
  readonly sourceTermDigest?: string;
  readonly canvasBounds: Bounds;
  readonly maxFiltration: number;
  readonly maxHomologyDimension: 0 | 1;
  readonly maxSimplexDimension: 1 | 2;
  readonly vertices: readonly FiltrationVertex[];
  readonly simplices: readonly FilteredSimplex[];
  readonly digest: string;
}
export interface BuildComplexInput {
  readonly primitives: readonly GeometricPrimitive[];
  readonly canvasBounds: Bounds;
  readonly sourceTermDigest?: string;
  readonly relations?: readonly TopologicalRelation[];
  readonly maxFiltration?: number;
  readonly maxHomologyDimension?: 0 | 1;
}
export interface PersistenceInterval {
  readonly dimension: 0 | 1;
  readonly birth: number;
  readonly death: number | null;
  readonly birthSimplexId: string;
  readonly deathSimplexId?: string;
  readonly persistence: number | null;
}
export interface PersistenceDiagram {
  readonly authority: "NEXUS_PERSISTENCE_DIAGRAM_V1";
  readonly sourceComplexDigest: string;
  readonly maxDimension: 0 | 1;
  readonly filtrationLimit: number;
  readonly intervals: readonly PersistenceInterval[];
  readonly digest: string;
}
export interface BottleneckDimensionResult {
  readonly dimension: 0 | 1;
  readonly finiteDistance: number;
  readonly essentialDistance: number;
  readonly distance: number;
}
export interface BottleneckDistanceResult { readonly distance: number; readonly dimensions: readonly BottleneckDimensionResult[]; }
export interface PersistenceDimensionSummary {
  readonly dimension: 0 | 1;
  readonly intervalCount: number;
  readonly essentialCount: number;
  readonly positiveLifetimeCount: number;
  readonly totalPersistence: number;
  readonly maxPersistence: number;
  readonly entropy: number;
}
export interface TopologicalFingerprint {
  readonly authority: "NEXUS_TOPOLOGICAL_FINGERPRINT_V1";
  readonly sourceComplexDigest: string;
  readonly sourceDiagramDigest: string;
  readonly componentCount: number;
  readonly cycleCount: number;
  readonly totalPersistence: number;
  readonly maxPersistence: number;
  readonly entropy: number;
  readonly H0: PersistenceDimensionSummary;
  readonly H1: PersistenceDimensionSummary;
  readonly digest: string;
}
export type TopologyConstraintSeverity = "required" | "recommended";
export type TopologyConstraintKind =
  | "min_bottleneck_distance" | "max_bottleneck_distance"
  | "min_total_persistence" | "max_total_persistence"
  | "min_cycle_count" | "max_cycle_count"
  | "min_component_count" | "max_component_count";
export interface TopologyConstraint {
  readonly id: string;
  readonly kind: TopologyConstraintKind;
  readonly value: number;
  readonly severity: TopologyConstraintSeverity;
  readonly dimension?: 0 | 1;
}
export type TopologyConstraintStatus = "PASS" | "FAIL" | "NOT_TESTED";
export interface TopologyConstraintEvaluation {
  readonly constraint: TopologyConstraint;
  readonly status: TopologyConstraintStatus;
  readonly actual: number | null;
  readonly expected: number;
  readonly reason: string;
}
export type CertifiedSynthesisStatus = "CERTIFIED" | "REJECTED" | "NOT_TESTED";
export interface TopologyReference { readonly id: string; readonly diagram: PersistenceDiagram; }
export interface TopologyCertificate {
  readonly authority: "NEXUS_TOPOLOGY_CERTIFICATE_V1";
  readonly version: 1;
  readonly planId: string;
  readonly subject: string;
  readonly status: CertifiedSynthesisStatus;
  readonly sourceTermDigest?: string;
  readonly complexDigest: string;
  readonly diagramDigest: string;
  readonly fingerprintDigest: string;
  readonly referenceSetDigest: string;
  readonly evaluations: readonly TopologyConstraintEvaluation[];
  readonly certificateDigest: string;
}
export interface CertifiedSynthesisResult {
  readonly status: CertifiedSynthesisStatus;
  readonly complex: FiltrationComplex;
  readonly diagram: PersistenceDiagram;
  readonly fingerprint: TopologicalFingerprint;
  readonly nearestReferenceId?: string;
  readonly nearestBottleneckDistance?: number;
  readonly evaluations: readonly TopologyConstraintEvaluation[];
  readonly certificate: TopologyCertificate;
}
export interface CertifiedSynthesisInput {
  readonly planId: string;
  readonly subject: string;
  readonly primitives: readonly GeometricPrimitive[];
  readonly canvasBounds: Bounds;
  readonly sourceTermDigest?: string;
  readonly relations?: readonly TopologicalRelation[];
  readonly referenceDiagrams?: readonly TopologyReference[];
  readonly constraints?: readonly TopologyConstraint[];
  readonly maxFiltration?: number;
  readonly maxHomologyDimension?: 0 | 1;
}
