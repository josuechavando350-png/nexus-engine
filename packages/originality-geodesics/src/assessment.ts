import { digestValue, geometricDistance } from "@nexus/visual-algebra";
import { shortestGeodesicPaths } from "./dijkstra.js";
import { createOriginalityEdge } from "./edge.js";
import { compareStableStrings } from "./order.js";
import { validateOriginalityManifold } from "./manifold.js";
import { validateOriginalityPoint } from "./point.js";
import type { AssessOriginalityInput, OriginalityAssessment, OriginalityEdge, OriginalityPoint } from "./types.js";

function attachCandidate(candidate: OriginalityPoint, manifold: AssessOriginalityInput["manifold"]): readonly OriginalityEdge[] {
  const ranked = manifold.points
    .map((point) => ({ point, distance: geometricDistance(candidate.metrics, point.metrics, manifold.policy.weights).distance }))
    .sort((left, right) => left.distance - right.distance || compareStableStrings(left.point.pointId, right.point.pointId));

  return Object.freeze(
    ranked.slice(0, manifold.policy.kNeighbors).map((item) => createOriginalityEdge(candidate.pointId, item.point.pointId, item.distance)),
  );
}

export function assessOriginality(input: AssessOriginalityInput): OriginalityAssessment {
  validateOriginalityManifold(input.manifold);
  validateOriginalityPoint(input.candidate);
  if (input.candidate.role !== "CANDIDATE") throw new Error("Originality assessment requires a CANDIDATE point");
  if (input.manifold.points.some((point) => point.pointId === input.candidate.pointId)) throw new Error("Candidate pointId collides with manifold pointId");

  const protectedPoints = input.manifold.points.filter((point) => point.role === "PROTECTED");
  const direct = protectedPoints
    .map((point) => ({ point, distance: geometricDistance(input.candidate.metrics, point.metrics, input.manifold.policy.weights).distance }))
    .sort((left, right) => left.distance - right.distance || compareStableStrings(left.point.pointId, right.point.pointId))[0]!;

  const candidateEdges = attachCandidate(input.candidate, input.manifold);
  const nodeIds = [input.candidate.pointId, ...input.manifold.points.map((point) => point.pointId)];
  const edges = [...input.manifold.edges, ...candidateEdges];
  const pathResults = shortestGeodesicPaths({
    nodeIds,
    edges,
    source: input.candidate.pointId,
    targets: protectedPoints.map((point) => point.pointId),
  });
  const pathByTarget = new Map(pathResults.map((entry) => [entry.target, entry.path] as const));
  const paths = protectedPoints
    .map((point) => ({ point, path: pathByTarget.get(point.pointId)! }))
    .filter((entry) => entry.path.reachable)
    .sort((left, right) => left.path.distance! - right.path.distance! || compareStableStrings(left.point.pointId, right.point.pointId));

  const nearestGeodesic = paths[0];
  const protectedGeodesicDistance = nearestGeodesic?.path.distance ?? null;
  const status = direct.distance === 0
    ? "TOO_CLOSE" as const
    : protectedGeodesicDistance === null
      ? "UNASSESSED" as const
      : direct.distance >= input.manifold.policy.minimumProtectedDirect && protectedGeodesicDistance >= input.manifold.policy.minimumProtectedGeodesic
        ? "CLEAR" as const
        : "TOO_CLOSE" as const;

  const base = Object.freeze({
    authority: "NEXUS_ORIGINALITY_ASSESSMENT_V1" as const,
    version: 1 as const,
    candidate: input.candidate,
    manifold: input.manifold,
    candidateEdges,
    nearestDirectProtectedId: direct.point.pointId,
    nearestDirectProtectedDistance: direct.distance,
    nearestGeodesicProtectedId: nearestGeodesic?.point.pointId ?? null,
    protectedGeodesicDistance,
    geodesicPath: Object.freeze([...(nearestGeodesic?.path.nodes ?? [])]),
    minimumProtectedDirect: input.manifold.policy.minimumProtectedDirect,
    minimumProtectedGeodesic: input.manifold.policy.minimumProtectedGeodesic,
    status,
  });
  const assessmentDigest = digestValue({
    authority: base.authority,
    version: base.version,
    candidatePointDigest: input.candidate.pointDigest,
    manifoldDigest: input.manifold.manifoldDigest,
    candidateEdgeDigests: candidateEdges.map((edge) => edge.edgeDigest),
    nearestDirectProtectedId: base.nearestDirectProtectedId,
    nearestDirectProtectedDistance: base.nearestDirectProtectedDistance,
    nearestGeodesicProtectedId: base.nearestGeodesicProtectedId,
    protectedGeodesicDistance: base.protectedGeodesicDistance,
    geodesicPath: base.geodesicPath,
    minimumProtectedDirect: base.minimumProtectedDirect,
    minimumProtectedGeodesic: base.minimumProtectedGeodesic,
    status: base.status,
  });
  return Object.freeze({ ...base, assessmentDigest });
}

export function validateOriginalityAssessment(assessment: OriginalityAssessment): void {
  if (!assessment || typeof assessment !== "object") throw new Error("Originality assessment must be an object");
  if (assessment.authority !== "NEXUS_ORIGINALITY_ASSESSMENT_V1" || assessment.version !== 1) {
    throw new Error("Unsupported originality assessment authority/version");
  }
  const rebuilt = assessOriginality({ candidate: assessment.candidate, manifold: assessment.manifold });
  if (rebuilt.assessmentDigest !== assessment.assessmentDigest || digestValue(rebuilt) !== digestValue(assessment)) {
    throw new Error("Originality assessment digest or geodesic result mismatch");
  }
}
