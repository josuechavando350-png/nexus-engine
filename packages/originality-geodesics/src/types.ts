import type { GeometricFingerprint, GeometricMetrics, GeometricMetricName, MetricWeights, VisualAlgebraTerm } from "@nexus/visual-algebra";

export type OriginalityPointRole = "PROTECTED" | "CONTEXT" | "CANDIDATE";
export type OriginalityAssessmentStatus = "CLEAR" | "TOO_CLOSE" | "UNASSESSED";
export type CounterfactualSearchStatus = "ALREADY_CLEAR" | "FOUND" | "NOT_FOUND";

export type ResolvedMetricWeights = Readonly<Record<GeometricMetricName, number>>;

export interface OriginalityPolicy {
  readonly authority: "NEXUS_ORIGINALITY_POLICY_V1";
  readonly version: 1;
  readonly kNeighbors: number;
  readonly minimumProtectedDirect: number;
  readonly minimumProtectedGeodesic: number;
  readonly weights: ResolvedMetricWeights;
  readonly policyDigest: string;
}

export interface CreateOriginalityPolicyInput {
  readonly kNeighbors: number;
  readonly minimumProtectedDirect: number;
  readonly minimumProtectedGeodesic: number;
  readonly weights?: MetricWeights;
}

export interface OriginalityPoint {
  readonly authority: "NEXUS_ORIGINALITY_POINT_V1";
  readonly version: 1;
  readonly pointId: string;
  readonly role: OriginalityPointRole;
  readonly subject: string;
  readonly termDigest: string;
  readonly metrics: GeometricMetrics;
  readonly pointDigest: string;
}

export interface CreateOriginalityPointInput {
  readonly pointId: string;
  readonly role: OriginalityPointRole;
  readonly subject: string;
  readonly termDigest: string;
  readonly metrics: GeometricMetrics;
}

export interface OriginalityPointFromFingerprintInput {
  readonly pointId: string;
  readonly role: OriginalityPointRole;
  readonly fingerprint: GeometricFingerprint;
}

export interface OriginalityPointFromTermInput {
  readonly pointId: string;
  readonly role: OriginalityPointRole;
  readonly term: VisualAlgebraTerm;
}

export interface OriginalityEdge {
  readonly a: string;
  readonly b: string;
  readonly weight: number;
  readonly edgeDigest: string;
}

export interface OriginalityManifold {
  readonly authority: "NEXUS_ORIGINALITY_MANIFOLD_V1";
  readonly version: 1;
  readonly points: readonly OriginalityPoint[];
  readonly policy: OriginalityPolicy;
  readonly edges: readonly OriginalityEdge[];
  readonly manifoldDigest: string;
}

export interface BuildOriginalityManifoldInput {
  readonly points: readonly OriginalityPoint[];
  readonly policy: OriginalityPolicy;
}

export interface GeodesicPath {
  readonly reachable: boolean;
  readonly distance: number | null;
  readonly nodes: readonly string[];
}

export interface OriginalityAssessment {
  readonly authority: "NEXUS_ORIGINALITY_ASSESSMENT_V1";
  readonly version: 1;
  readonly candidate: OriginalityPoint;
  readonly manifold: OriginalityManifold;
  readonly candidateEdges: readonly OriginalityEdge[];
  readonly nearestDirectProtectedId: string;
  readonly nearestDirectProtectedDistance: number;
  readonly nearestGeodesicProtectedId: string | null;
  readonly protectedGeodesicDistance: number | null;
  readonly geodesicPath: readonly string[];
  readonly minimumProtectedDirect: number;
  readonly minimumProtectedGeodesic: number;
  readonly status: OriginalityAssessmentStatus;
  readonly assessmentDigest: string;
}

export interface AssessOriginalityInput {
  readonly candidate: OriginalityPoint;
  readonly manifold: OriginalityManifold;
}

export interface CounterfactualEvaluation {
  readonly candidate: OriginalityPoint;
  readonly assessment: OriginalityAssessment;
  readonly displacement: number;
}

export interface CounterfactualSearchResult {
  readonly authority: "NEXUS_ORIGINALITY_COUNTERFACTUAL_V1";
  readonly version: 1;
  readonly sourceAssessment: OriginalityAssessment;
  readonly evaluations: readonly CounterfactualEvaluation[];
  readonly status: CounterfactualSearchStatus;
  readonly chosenPointId: string | null;
  readonly chosenDisplacement: number | null;
  readonly searchDigest: string;
}

export interface SearchOriginalityCounterfactualInput {
  readonly source: OriginalityPoint;
  readonly alternatives: readonly OriginalityPoint[];
  readonly manifold: OriginalityManifold;
}
