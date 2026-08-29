import { validateOriginalityAssessment } from "@nexus/originality-geodesics";
import type { OriginalityAssessment } from "@nexus/originality-geodesics";
import type { MetricSample } from "./index.js";

export interface OriginalityMeasurementProjection {
  readonly authority: "NEXUS_ORIGINALITY_MEASUREMENT_V1";
  readonly subject: string;
  readonly status: OriginalityAssessment["status"];
  readonly assessmentDigest: string;
  readonly manifoldDigest: string;
  readonly samples: readonly MetricSample[];
}

export function projectOriginalityMeasurement(assessment: OriginalityAssessment): OriginalityMeasurementProjection {
  validateOriginalityAssessment(assessment);
  const values: Array<readonly [string, string, number]> = [
    ["originality.directProtectedDistance", "ratio", assessment.nearestDirectProtectedDistance],
    ["originality.minimumProtectedDirect", "ratio", assessment.minimumProtectedDirect],
    ["originality.minimumProtectedGeodesic", "geodesic_distance", assessment.minimumProtectedGeodesic],
    ["originality.protectedReachable", "boolean", assessment.protectedGeodesicDistance === null ? 0 : 1],
    ["originality.clear", "boolean", assessment.status === "CLEAR" ? 1 : 0],
  ];
  if (assessment.protectedGeodesicDistance !== null) {
    values.push(["originality.protectedGeodesicDistance", "geodesic_distance", assessment.protectedGeodesicDistance]);
  }

  const samples = values.map(([name, unit, value]): MetricSample => {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
    return Object.freeze({ name, unit, value });
  });

  return Object.freeze({
    authority: "NEXUS_ORIGINALITY_MEASUREMENT_V1",
    subject: assessment.candidate.subject,
    status: assessment.status,
    assessmentDigest: assessment.assessmentDigest,
    manifoldDigest: assessment.manifold.manifoldDigest,
    samples: Object.freeze(samples),
  });
}
