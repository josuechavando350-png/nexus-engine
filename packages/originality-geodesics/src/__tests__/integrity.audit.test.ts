import { describe, expect, test } from "vitest";
import { createTerm, definePrimitive } from "@nexus/visual-algebra";
import type { GeometricMetrics, VisualAlgebraTerm } from "@nexus/visual-algebra";
import {
  MAX_ORIGINALITY_COUNTERFACTUAL_ALTERNATIVES,
  MAX_ORIGINALITY_K_NEIGHBORS,
  MAX_ORIGINALITY_MANIFOLD_POINTS,
  buildOriginalityManifold,
  createOriginalityEdge,
  createOriginalityPoint,
  createOriginalityPolicy,
  originalityPointFromTerm,
  searchOriginalityCounterfactual,
  searchVerifiedOriginalityCounterfactual,
  shortestGeodesicPath,
  shortestGeodesicPaths,
  validateVerifiedOriginalityCounterfactual,
} from "../index.js";

const canonicalMetrics = (value: number): GeometricMetrics => ({
  gridRegularity: value,
  axialSymmetry: value,
  whitespace: value,
  continuity: value,
  overlap: value,
  structuralEntropy: value,
  aspectConsistency: value,
  packingDensity: value,
});

function declaredPoint(pointId: string, role: "PROTECTED" | "CONTEXT" | "CANDIDATE", value: number, subject = pointId) {
  return createOriginalityPoint({
    pointId,
    role,
    subject,
    termDigest: "a".repeat(64),
    metrics: canonicalMetrics(value),
  });
}

function sourceTerm(): VisualAlgebraTerm {
  return createTerm({
    subject: "client/home",
    canvasBounds: { x: 0, y: 0, width: 100, height: 100 },
    primitives: [definePrimitive({ id: "source-box", kind: "rectangle", bounds: { x: 10, y: 10, width: 70, height: 70 } })],
  });
}

function alternativeTerm(): VisualAlgebraTerm {
  return createTerm({
    subject: "client/home",
    canvasBounds: { x: 0, y: 0, width: 100, height: 100 },
    primitives: [
      definePrimitive({ id: "left", kind: "rectangle", bounds: { x: 5, y: 5, width: 10, height: 15 } }),
      definePrimitive({ id: "right", kind: "rectangle", bounds: { x: 80, y: 75, width: 15, height: 10 } }),
    ],
  });
}

function termBackedManifold(term: VisualAlgebraTerm) {
  return buildOriginalityManifold({
    policy: createOriginalityPolicy({
      kNeighbors: 1,
      minimumProtectedDirect: 0.000001,
      minimumProtectedGeodesic: 0.000001,
    }),
    points: [originalityPointFromTerm({ pointId: "protected", role: "PROTECTED", term })],
  });
}

describe("Originality Geodesics integrity audit", () => {
  test("rejects non-canonical metric objects instead of hashing ignored dimensions", () => {
    const withExtraDimension = { ...canonicalMetrics(0.5), attackerDimension: 0.75 } as unknown as GeometricMetrics;
    expect(() => createOriginalityPoint({
      pointId: "candidate",
      role: "CANDIDATE",
      subject: "client/home",
      termDigest: "a".repeat(64),
      metrics: withExtraDimension,
    })).toThrow(/exactly the eight canonical/);
  });

  test("public Dijkstra rejects a forged edge digest", () => {
    const edge = createOriginalityEdge("a", "b", 0.25);
    const forged = { ...edge, edgeDigest: "f".repeat(64) };
    expect(() => shortestGeodesicPath({ nodeIds: ["a", "b"], edges: [forged], source: "a", target: "b" })).toThrow(/edge digest\/canonicalization/);
  });

  test("multi-target geodesic traversal preserves deterministic shortest paths", () => {
    const edges = [
      createOriginalityEdge("a", "b", 0.2),
      createOriginalityEdge("b", "c", 0.3),
      createOriginalityEdge("a", "c", 0.8),
    ];
    const results = shortestGeodesicPaths({ nodeIds: ["a", "b", "c"], edges, source: "a", targets: ["b", "c"] });
    expect(results[0]).toEqual({ target: "b", path: { reachable: true, distance: 0.2, nodes: ["a", "b"] } });
    expect(results[1]).toEqual({ target: "c", path: { reachable: true, distance: 0.5, nodes: ["a", "b", "c"] } });
  });

  test("fails closed above explicit manifold, neighborhood and counterfactual budgets", () => {
    expect(() => createOriginalityPolicy({
      kNeighbors: MAX_ORIGINALITY_K_NEIGHBORS + 1,
      minimumProtectedDirect: 0.1,
      minimumProtectedGeodesic: 0.1,
    })).toThrow(/cannot exceed/);

    const policy = createOriginalityPolicy({ kNeighbors: 1, minimumProtectedDirect: 0.1, minimumProtectedGeodesic: 0.1 });
    const tooManyPoints = Array.from({ length: MAX_ORIGINALITY_MANIFOLD_POINTS + 1 }, (_, index) =>
      declaredPoint(`p${index}`, index === 0 ? "PROTECTED" : "CONTEXT", index / (MAX_ORIGINALITY_MANIFOLD_POINTS + 1)));
    expect(() => buildOriginalityManifold({ policy, points: tooManyPoints })).toThrow(/point budget exceeded/);

    const manifold = buildOriginalityManifold({ policy, points: [declaredPoint("protected", "PROTECTED", 0), declaredPoint("context", "CONTEXT", 1)] });
    const source = declaredPoint("source", "CANDIDATE", 0.1, "client/home");
    const tooManyAlternatives = Array.from({ length: MAX_ORIGINALITY_COUNTERFACTUAL_ALTERNATIVES + 1 }, (_, index) =>
      declaredPoint(`alt${index}`, "CANDIDATE", 0.2 + index / 1000, "client/home"));
    expect(() => searchOriginalityCounterfactual({ source, alternatives: tooManyAlternatives, manifold })).toThrow(/alternative budget exceeded/);
  });

  test("term-backed counterfactuals replay Visual Algebra before claiming a verified search", () => {
    const source = sourceTerm();
    const alternative = alternativeTerm();
    const manifold = termBackedManifold(source);
    const result = searchVerifiedOriginalityCounterfactual({
      source: { pointId: "source", term: source },
      alternatives: [{ pointId: "alternative", term: alternative }],
      manifold,
    });

    expect(result.pointSearch.sourceAssessment.status).toBe("TOO_CLOSE");
    expect(result.pointSearch.status).toBe("FOUND");
    expect(result.pointSearch.chosenPointId).toBe("alternative");
    expect(() => validateVerifiedOriginalityCounterfactual(result)).not.toThrow();
  });

  test("term-backed counterfactual verification rejects geometry/metric forgery", () => {
    const source = sourceTerm();
    const alternative = alternativeTerm();
    const forgedAlternative = {
      ...alternative,
      metrics: { ...alternative.metrics, whitespace: alternative.metrics.whitespace === 0 ? 1 : 0 },
    } as VisualAlgebraTerm;
    const manifold = termBackedManifold(source);
    expect(() => searchVerifiedOriginalityCounterfactual({
      source: { pointId: "source", term: source },
      alternatives: [{ pointId: "forged", term: forgedAlternative }],
      manifold,
    })).toThrow(/metrics do not match source geometry|term digest mismatch/);
  });
});
