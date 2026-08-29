import { describe, expect, test } from "vitest";
import { createGeometricFingerprint, createTerm, definePrimitive, digestValue } from "@nexus/visual-algebra";
import {
  assessOriginality,
  buildOriginalityManifold,
  createOriginalityPoint,
  createOriginalityPolicy,
  originalityPointFromFingerprint,
  originalityPointFromTerm,
  searchOriginalityCounterfactual,
  shortestGeodesicPath,
  validateOriginalityAssessment,
  validateOriginalityCounterfactual,
  validateOriginalityManifold,
} from "../index.js";
import type { GeometricMetrics } from "@nexus/visual-algebra";
import type { OriginalityPoint, OriginalityPointRole } from "../types.js";

const digest = (char: string) => char.repeat(64).slice(0, 64);
const metrics = (value: number): GeometricMetrics => ({
  gridRegularity: value,
  axialSymmetry: value,
  whitespace: value,
  continuity: value,
  overlap: value,
  structuralEntropy: value,
  aspectConsistency: value,
  packingDensity: value,
});
const point = (
  pointId: string,
  role: OriginalityPointRole,
  value: number,
  char = "a",
  subject = pointId,
): OriginalityPoint =>
  createOriginalityPoint({ pointId, role, subject, termDigest: digest(char), metrics: metrics(value) });

function chainPolicy() {
  return createOriginalityPolicy({
    kNeighbors: 1,
    minimumProtectedDirect: 0.3,
    minimumProtectedGeodesic: 0.65,
  });
}

function chainManifold() {
  const policy = chainPolicy();
  return buildOriginalityManifold({
    policy,
    points: [
      point("p0", "PROTECTED", 0, "a"),
      point("c1", "CONTEXT", 0.2, "b"),
      point("c2", "CONTEXT", 0.45, "c"),
      point("p1", "PROTECTED", 1, "d"),
    ],
  });
}

describe("originality geodesics", () => {
  test("creates deterministic policy and rejects invalid thresholds/weights", () => {
    const first = chainPolicy();
    const second = createOriginalityPolicy({ kNeighbors: 1, minimumProtectedDirect: 0.3, minimumProtectedGeodesic: 0.65 });
    expect(first.policyDigest).toBe(second.policyDigest);
    expect(() => createOriginalityPolicy({ kNeighbors: 0, minimumProtectedDirect: 0.2, minimumProtectedGeodesic: 0.2 })).toThrow(/positive integer/);
    expect(() => createOriginalityPolicy({ kNeighbors: 1, minimumProtectedDirect: 1.1, minimumProtectedGeodesic: 0.2 })).toThrow(/\[0,1\]/);
    expect(() => createOriginalityPolicy({ kNeighbors: 1, minimumProtectedDirect: 0.2, minimumProtectedGeodesic: -1 })).toThrow(/non-negative/);
    expect(() => createOriginalityPolicy({ kNeighbors: 1, minimumProtectedDirect: 0.2, minimumProtectedGeodesic: 0.2, weights: { overlap: Number.NaN } })).toThrow(/finite/);
    expect(() => createOriginalityPolicy({ kNeighbors: 1, minimumProtectedDirect: 0.2, minimumProtectedGeodesic: 0.2, weights: { gridRegularity: 0, axialSymmetry: 0, whitespace: 0, continuity: 0, overlap: 0, structuralEntropy: 0, aspectConsistency: 0, packingDensity: 0 } })).toThrow(/positive/);
  });

  test("canonicalizes kNN manifold independent of input permutation", () => {
    const a = chainManifold();
    const b = buildOriginalityManifold({ policy: a.policy, points: [...a.points].reverse() });
    expect(a.manifoldDigest).toBe(b.manifoldDigest);
    expect(a.edges.map((edge) => [edge.a, edge.b, edge.weight])).toEqual([
      ["c1", "c2", 0.25],
      ["c1", "p0", 0.2],
      ["c2", "p1", 0.55],
    ]);
    expect(() => buildOriginalityManifold({ policy: createOriginalityPolicy({ kNeighbors: 5, minimumProtectedDirect: 0.2, minimumProtectedGeodesic: 0.2 }), points: a.points })).toThrow(/cannot exceed/);
  });

  test("computes deterministic Dijkstra shortest path", () => {
    const path = shortestGeodesicPath({
      nodeIds: ["c", "a", "b"],
      edges: [
        { a: "a", b: "b", weight: 0.3, edgeDigest: digest("a") },
        { a: "b", b: "c", weight: 0.2, edgeDigest: digest("b") },
        { a: "a", b: "c", weight: 0.8, edgeDigest: digest("c") },
      ],
      source: "a",
      target: "c",
    });
    expect(path).toEqual({ reachable: true, distance: 0.5, nodes: ["a", "b", "c"] });
  });

  test("uses both direct and geodesic protected thresholds", () => {
    const manifold = chainManifold();
    const assessment = assessOriginality({ candidate: point("candidate", "CANDIDATE", 0.6, "e"), manifold });
    expect(assessment.nearestDirectProtectedId).toBe("p1");
    expect(assessment.nearestDirectProtectedDistance).toBeCloseTo(0.4);
    expect(assessment.nearestGeodesicProtectedId).toBe("p0");
    expect(assessment.protectedGeodesicDistance).toBeCloseTo(0.6);
    expect(assessment.geodesicPath).toEqual(["candidate", "c2", "c1", "p0"]);
    expect(assessment.status).toBe("TOO_CLOSE");
    expect(() => validateOriginalityAssessment(assessment)).not.toThrow();
  });

  test("direct guard prevents a long manifold route from hiding protected proximity", () => {
    const manifold = buildOriginalityManifold({
      policy: createOriginalityPolicy({ kNeighbors: 1, minimumProtectedDirect: 0.1, minimumProtectedGeodesic: 0.2 }),
      points: [point("protected", "PROTECTED", 0, "a"), point("near-context", "CONTEXT", 0.04, "b"), point("far-context", "CONTEXT", 0.8, "c")],
    });
    const assessment = assessOriginality({ candidate: point("candidate", "CANDIDATE", 0.08, "d"), manifold });
    expect(assessment.nearestDirectProtectedDistance).toBeCloseTo(0.08);
    expect(assessment.status).toBe("TOO_CLOSE");
  });

  test("fails closed as UNASSESSED when the candidate component cannot reach protected references", () => {
    const manifold = buildOriginalityManifold({
      policy: createOriginalityPolicy({ kNeighbors: 1, minimumProtectedDirect: 0.2, minimumProtectedGeodesic: 0.2 }),
      points: [
        point("p0", "PROTECTED", 0, "a"), point("pctx", "CONTEXT", 0.01, "b"),
        point("c0", "CONTEXT", 0.8, "c"), point("c1", "CONTEXT", 0.81, "d"),
      ],
    });
    const assessment = assessOriginality({ candidate: point("candidate", "CANDIDATE", 0.82, "e"), manifold });
    expect(assessment.protectedGeodesicDistance).toBeNull();
    expect(assessment.nearestGeodesicProtectedId).toBeNull();
    expect(assessment.geodesicPath).toEqual([]);
    expect(assessment.status).toBe("UNASSESSED");
  });

  test("exact protected match is never clear", () => {
    const manifold = chainManifold();
    const assessment = assessOriginality({ candidate: point("candidate", "CANDIDATE", 0, "e"), manifold });
    expect(assessment.nearestDirectProtectedDistance).toBe(0);
    expect(assessment.protectedGeodesicDistance).toBe(0);
    expect(assessment.status).toBe("TOO_CLOSE");
  });

  test("counterfactual search chooses smallest caller-provided clear displacement", () => {
    const manifold = chainManifold();
    const subject = "client/home";
    const source = point("source", "CANDIDATE", 0.6, "e", subject);
    const farther = point("farther", "CANDIDATE", 0.7, "f", subject);
    const closer = point("closer", "CANDIDATE", 0.65, "1", subject);
    const result = searchOriginalityCounterfactual({ source, alternatives: [farther, closer], manifold });
    expect(result.sourceAssessment.status).toBe("TOO_CLOSE");
    expect(result.status).toBe("FOUND");
    expect(result.chosenPointId).toBe("closer");
    expect(result.chosenDisplacement).toBeCloseTo(0.05);
    expect(result.evaluations.find((entry) => entry.candidate.pointId === "closer")?.assessment.status).toBe("CLEAR");
    expect(() => validateOriginalityCounterfactual(result)).not.toThrow();
  });

  test("counterfactual search does not invent a solution", () => {
    const manifold = chainManifold();
    const subject = "client/home";
    const result = searchOriginalityCounterfactual({
      source: point("source", "CANDIDATE", 0.6, "e", subject),
      alternatives: [
        point("near-a", "CANDIDATE", 0.58, "f", subject),
        point("near-b", "CANDIDATE", 0.62, "1", subject),
      ],
      manifold,
    });
    expect(result.status).toBe("NOT_FOUND");
    expect(result.chosenPointId).toBeNull();
  });

  test("returns ALREADY_CLEAR without fabricating a counterfactual", () => {
    const manifold = chainManifold();
    const subject = "client/home";
    const result = searchOriginalityCounterfactual({
      source: point("source", "CANDIDATE", 0.65, "e", subject),
      alternatives: [point("other", "CANDIDATE", 0.7, "f", subject)],
      manifold,
    });
    expect(result.status).toBe("ALREADY_CLEAR");
    expect(result.chosenPointId).toBeNull();
  });

  test("detects assessment tampering", () => {
    const assessment = assessOriginality({ candidate: point("candidate", "CANDIDATE", 0.6, "e"), manifold: chainManifold() });
    const tampered = { ...assessment, status: "CLEAR" as const };
    expect(() => validateOriginalityAssessment(tampered)).toThrow(/digest or geodesic/);
  });

  test("binds points to valid Visual Algebra term digests", () => {
    const term = createTerm({
      subject: "client/home",
      canvasBounds: { x: 0, y: 0, width: 100, height: 100 },
      primitives: [definePrimitive({ id: "a", kind: "rectangle", bounds: { x: 10, y: 10, width: 20, height: 20 } })],
    });
    const p = originalityPointFromTerm({ pointId: "candidate", role: "CANDIDATE", term });
    expect(p.termDigest).toBe(term.digest);
    const reference = originalityPointFromFingerprint({ pointId: "reference", role: "PROTECTED", fingerprint: createGeometricFingerprint(term) });
    expect(reference.metrics).toEqual(term.metrics);
    const forged = { ...term, digest: digestValue({ forged: true }) };
    expect(() => originalityPointFromTerm({ pointId: "bad", role: "CANDIDATE", term: forged })).toThrow(/term digest mismatch/);
  });

  test("rejects malformed manifolds and candidate collisions", () => {
    const policy = chainPolicy();
    expect(() => buildOriginalityManifold({ policy, points: [point("context", "CONTEXT", 0.5, "a")] })).toThrow(/PROTECTED/);
    const manifold = chainManifold();
    expect(() => assessOriginality({ candidate: point("p0", "CANDIDATE", 0.6, "e"), manifold })).toThrow(/collides/);
    const tampered = { ...manifold, edges: [] };
    expect(() => validateOriginalityManifold(tampered)).toThrow(/digest\/canonicalization/);
  });
});
