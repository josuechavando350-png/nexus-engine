import { validateCertifiedSynthesisResult } from "@nexus/topology";
import type { CertifiedSynthesisResult } from "@nexus/topology";
import type { MetricSample } from "./index.js";

export interface TopologyMeasurementProjection {
  readonly authority: "NEXUS_TOPOLOGY_MEASUREMENT_V1";
  readonly subject: string;
  readonly status: CertifiedSynthesisResult["status"];
  readonly complexDigest: string;
  readonly diagramDigest: string;
  readonly fingerprintDigest: string;
  readonly certificateDigest: string;
  readonly samples: readonly MetricSample[];
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be SHA-256 hex`);
}

export function projectTopologyMeasurement(result: CertifiedSynthesisResult): TopologyMeasurementProjection {
  validateCertifiedSynthesisResult(result);
  assertSha256(result.complex.digest, "complex digest");
  assertSha256(result.diagram.digest, "diagram digest");
  assertSha256(result.fingerprint.digest, "fingerprint digest");
  assertSha256(result.certificate.certificateDigest, "certificate digest");

  const values = [
    ["topology.componentCount", "count", result.fingerprint.componentCount],
    ["topology.cycleCount", "count", result.fingerprint.cycleCount],
    ["topology.totalPersistence", "normalized_filtration_sum", result.fingerprint.totalPersistence],
    ["topology.maxPersistence", "ratio", result.fingerprint.maxPersistence],
    ["topology.entropy", "ratio", result.fingerprint.entropy],
    ["topology.H0.entropy", "ratio", result.fingerprint.H0.entropy],
    ["topology.H1.entropy", "ratio", result.fingerprint.H1.entropy],
  ] as const;

  const samples = values.map(([name, unit, value]): MetricSample => {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
    return Object.freeze({ name, unit, value });
  });

  return Object.freeze({
    authority: "NEXUS_TOPOLOGY_MEASUREMENT_V1",
    subject: result.certificate.subject,
    status: result.status,
    complexDigest: result.complex.digest,
    diagramDigest: result.diagram.digest,
    fingerprintDigest: result.fingerprint.digest,
    certificateDigest: result.certificate.certificateDigest,
    samples: Object.freeze(samples),
  });
}
