import { describe, expect, test } from "vitest";
import type { GeometricMetrics } from "@nexus/visual-algebra";
import {
  assessOriginality,
  buildOriginalityManifold,
  createOriginalityPoint,
  createOriginalityPolicy,
  searchOriginalityCounterfactual,
} from "../index.js";

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

function point(pointId: string, role: "PROTECTED" | "CONTEXT" | "CANDIDATE", value: number, subject: string) {
  return createOriginalityPoint({
    pointId,
    role,
    subject,
    termDigest: "a".repeat(64),
    metrics: metrics(value),
  });
}

describe("originality hardening", () => {
  test("exact protected match is TOO_CLOSE even when policy thresholds are zero", () => {
    const policy = createOriginalityPolicy({
      kNeighbors: 1,
      minimumProtectedDirect: 0,
      minimumProtectedGeodesic: 0,
    });
    const manifold = buildOriginalityManifold({
      policy,
      points: [
        point("protected", "PROTECTED", 0.25, "reference/protected"),
        point("context", "CONTEXT", 0.75, "reference/context"),
      ],
    });

    const result = assessOriginality({
      candidate: point("candidate", "CANDIDATE", 0.25, "client/home"),
      manifold,
    });

    expect(result.nearestDirectProtectedDistance).toBe(0);
    expect(result.status).toBe("TOO_CLOSE");
  });

  test("counterfactual alternatives must remain within the source subject", () => {
    const policy = createOriginalityPolicy({
      kNeighbors: 1,
      minimumProtectedDirect: 0.2,
      minimumProtectedGeodesic: 0.2,
    });
    const manifold = buildOriginalityManifold({
      policy,
      points: [
        point("protected", "PROTECTED", 0, "reference/protected"),
        point("context", "CONTEXT", 0.5, "reference/context"),
      ],
    });

    expect(() => searchOriginalityCounterfactual({
      source: point("source", "CANDIDATE", 0.1, "client/home"),
      alternatives: [point("other", "CANDIDATE", 0.8, "other-client/home")],
      manifold,
    })).toThrow(/share the source subject/);
  });
});
