import { validateVerificationResult } from "@nexus/compositional-semantics";
import type { VerificationResult } from "@nexus/compositional-semantics";
import type { MetricSample } from "./index.js";

export interface CompositionalSemanticsMeasurementProjection {
  readonly authority: "NEXUS_COMPOSITIONAL_SEMANTICS_MEASUREMENT_V1";
  readonly subject: string;
  readonly status: VerificationResult["status"];
  readonly compositionDigest: string;
  readonly finalStateDigest: string;
  readonly certificateDigest: string;
  readonly samples: readonly MetricSample[];
}

export function projectCompositionalSemanticsMeasurement(
  result: VerificationResult,
): CompositionalSemanticsMeasurementProjection {
  validateVerificationResult(result);

  const values = [
    ["semantics.verified", "boolean", result.status === "VERIFIED" ? 1 : 0],
    ["semantics.issueCount", "count", result.issues.length],
    ["semantics.traceCount", "count", result.trace.length],
    ["semantics.factCount", "count", Object.keys(result.finalState.facts).length],
    ["semantics.metricCount", "count", Object.keys(result.finalState.metrics).length],
  ] as const;

  const samples = values.map(([name, unit, value]): MetricSample => {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
    return Object.freeze({ name, unit, value });
  });

  return Object.freeze({
    authority: "NEXUS_COMPOSITIONAL_SEMANTICS_MEASUREMENT_V1",
    subject: result.certificate.subject,
    status: result.status,
    compositionDigest: result.compositionDigest,
    finalStateDigest: result.finalState.digest,
    certificateDigest: result.certificate.certificateDigest,
    samples: Object.freeze(samples),
  });
}
