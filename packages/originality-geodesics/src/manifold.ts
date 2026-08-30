import { digestValue, geometricDistance } from "@nexus/visual-algebra";
import { createOriginalityEdge } from "./edge.js";
import { MAX_ORIGINALITY_MANIFOLD_POINTS } from "./limits.js";
import { compareStableStrings } from "./order.js";
import { validateOriginalityPoint } from "./point.js";
import { validateOriginalityPolicy } from "./policy.js";
import type { BuildOriginalityManifoldInput, OriginalityEdge, OriginalityManifold, OriginalityPoint } from "./types.js";

function canonicalPoints(points: readonly OriginalityPoint[]): readonly OriginalityPoint[] {
  if (!points.length) throw new Error("Originality manifold requires at least one reference/context point");
  if (points.length > MAX_ORIGINALITY_MANIFOLD_POINTS) {
    throw new Error(`Originality manifold point budget exceeded (${MAX_ORIGINALITY_MANIFOLD_POINTS})`);
  }
  const sorted = [...points].sort((a, b) => compareStableStrings(a.pointId, b.pointId));
  const ids = new Set<string>();
  let protectedCount = 0;
  for (const point of sorted) {
    validateOriginalityPoint(point);
    if (point.role === "CANDIDATE") throw new Error("Originality manifold cannot contain CANDIDATE points");
    if (ids.has(point.pointId)) throw new Error(`Duplicate originality pointId ${point.pointId}`);
    ids.add(point.pointId);
    if (point.role === "PROTECTED") protectedCount += 1;
  }
  if (!protectedCount) throw new Error("Originality manifold requires at least one PROTECTED point");
  return Object.freeze(sorted);
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function buildEdges(points: readonly OriginalityPoint[], kNeighbors: number, weights: OriginalityManifold["policy"]["weights"]): readonly OriginalityEdge[] {
  if (kNeighbors > points.length) throw new Error("kNeighbors cannot exceed manifold point count");
  if (points.length === 1) return Object.freeze([]);

  const byKey = new Map<string, OriginalityEdge>();
  const neighborsToTake = Math.min(kNeighbors, points.length - 1);
  for (const point of points) {
    const ranked = points
      .filter((other) => other.pointId !== point.pointId)
      .map((other) => ({
        point: other,
        distance: geometricDistance(point.metrics, other.metrics, weights).distance,
      }))
      .sort((left, right) => left.distance - right.distance || compareStableStrings(left.point.pointId, right.point.pointId));

    for (const item of ranked.slice(0, neighborsToTake)) {
      const key = edgeKey(point.pointId, item.point.pointId);
      if (!byKey.has(key)) byKey.set(key, createOriginalityEdge(point.pointId, item.point.pointId, item.distance));
    }
  }

  return Object.freeze([...byKey.values()].sort((left, right) => compareStableStrings(left.a, right.a) || compareStableStrings(left.b, right.b)));
}

export function buildOriginalityManifold(input: BuildOriginalityManifoldInput): OriginalityManifold {
  validateOriginalityPolicy(input.policy);
  const points = canonicalPoints(input.points);
  const edges = buildEdges(points, input.policy.kNeighbors, input.policy.weights);
  const base = Object.freeze({
    authority: "NEXUS_ORIGINALITY_MANIFOLD_V1" as const,
    version: 1 as const,
    points,
    policy: input.policy,
    edges,
  });
  const manifoldDigest = digestValue({
    authority: base.authority,
    version: base.version,
    policyDigest: input.policy.policyDigest,
    pointDigests: points.map((point) => point.pointDigest),
    edgeDigests: edges.map((edge) => edge.edgeDigest),
  });
  return Object.freeze({ ...base, manifoldDigest });
}

export function validateOriginalityManifold(manifold: OriginalityManifold): void {
  if (!manifold || typeof manifold !== "object") throw new Error("Originality manifold must be an object");
  if (manifold.authority !== "NEXUS_ORIGINALITY_MANIFOLD_V1" || manifold.version !== 1) {
    throw new Error("Unsupported originality manifold authority/version");
  }
  const rebuilt = buildOriginalityManifold({ points: manifold.points, policy: manifold.policy });
  if (rebuilt.manifoldDigest !== manifold.manifoldDigest || digestValue(rebuilt.edges) !== digestValue(manifold.edges) || digestValue(rebuilt.points) !== digestValue(manifold.points)) {
    throw new Error("Originality manifold digest/canonicalization mismatch");
  }
}
