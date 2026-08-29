import { describe, expect, test } from "vitest";
import {
  assessOriginality,
  buildOriginalityManifold,
  createOriginalityPoint,
  createOriginalityPolicy,
} from "@nexus/originality-geodesics";
import type { GeometricMetrics } from "@nexus/visual-algebra";
import { projectOriginalityMeasurement } from "./originality-geodesics";

const metrics = (value: number): GeometricMetrics => ({
  gridRegularity: value, axialSymmetry: value, whitespace: value, continuity: value,
  overlap: value, structuralEntropy: value, aspectConsistency: value, packingDensity: value,
});

function point(pointId: string, role: "PROTECTED" | "CONTEXT" | "CANDIDATE", value: number, char: string) {
  return createOriginalityPoint({ pointId, role, subject: pointId === "candidate" ? "client/home" : pointId, termDigest: char.repeat(64), metrics: metrics(value) });
}

describe("originality measurement projection", () => {
  test("projects validated originality evidence", () => {
    const manifold = buildOriginalityManifold({
      points: [point("protected", "PROTECTED", 0, "a")],
      policy: createOriginalityPolicy({ kNeighbors: 1, minimumProtectedDirect: 0.2, minimumProtectedGeodesic: 0.2 }),
    });
    const assessment = assessOriginality({ candidate: point("candidate", "CANDIDATE", 0.7, "b"), manifold });
    const projection = projectOriginalityMeasurement(assessment);
    expect(projection.authority).toBe("NEXUS_ORIGINALITY_MEASUREMENT_V1");
    expect(projection.status).toBe("CLEAR");
    expect(projection.assessmentDigest).toBe(assessment.assessmentDigest);
    expect(projection.samples.find((sample) => sample.name === "originality.clear")?.value).toBe(1);
    expect(projection.samples.find((sample) => sample.name === "originality.protectedGeodesicDistance")?.value).toBeCloseTo(0.7);
  });

  test("does not invent a geodesic sample for UNASSESSED evidence", () => {
    const manifold = buildOriginalityManifold({
      points: [point("protected", "PROTECTED", 0, "a"), point("pctx", "CONTEXT", 0.01, "b"), point("c0", "CONTEXT", 0.8, "c"), point("c1", "CONTEXT", 0.81, "d")],
      policy: createOriginalityPolicy({ kNeighbors: 1, minimumProtectedDirect: 0.2, minimumProtectedGeodesic: 0.2 }),
    });
    const assessment = assessOriginality({ candidate: point("candidate", "CANDIDATE", 0.82, "e"), manifold });
    const projection = projectOriginalityMeasurement(assessment);
    expect(assessment.status).toBe("UNASSESSED");
    expect(projection.samples.some((sample) => sample.name === "originality.protectedGeodesicDistance")).toBe(false);
    expect(projection.samples.find((sample) => sample.name === "originality.protectedReachable")?.value).toBe(0);
  });
});
