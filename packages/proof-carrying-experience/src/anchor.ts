import { digestValue } from "@nexus/visual-algebra";
import { assertSourceRevision } from "./artifact.js";
import type { EvidenceTrustAnchor } from "./types.js";

function nonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} cannot be empty`);
}

function canonicalGates(gates: readonly string[]): readonly string[] {
  if (!gates.length) throw new Error("verifiedGates cannot be empty");
  for (const gate of gates) nonEmpty(gate, "verified gate");
  const unique = [...new Set(gates)];
  if (unique.length !== gates.length) throw new Error("verifiedGates cannot contain duplicates");
  return Object.freeze(unique.sort((a, b) => a.localeCompare(b)));
}

export function createEvidenceTrustAnchor(input: {
  readonly subject: string;
  readonly sourceRevision: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly bundleId: string;
  readonly keyId: string;
  readonly payloadDigest: string;
  readonly artifactDigest: string;
  readonly artifactDescriptorDigest: string;
  readonly artifactRecordId: string;
  readonly artifactProvenanceDigest: string;
  readonly verifiedGates: readonly string[];
}): EvidenceTrustAnchor {
  for (const [label, value] of Object.entries({ subject: input.subject, tenantId: input.tenantId, projectId: input.projectId, keyId: input.keyId })) nonEmpty(value, label);
  assertSourceRevision(input.sourceRevision);
  if (!/^bundle_[a-f0-9]{64}$/.test(input.bundleId)) throw new Error("bundleId is invalid");
  if (!/^sha256:[a-f0-9]{64}$/.test(input.payloadDigest)) throw new Error("Evidence payloadDigest must be SHA-256");
  if (!/^sha256:[a-f0-9]{64}$/.test(input.artifactDigest)) throw new Error("Evidence artifactDigest must be SHA-256");
  if (!/^[a-f0-9]{64}$/.test(input.artifactDescriptorDigest)) throw new Error("Evidence artifactDescriptorDigest must be SHA-256 hex");
  if (!/^record_[a-f0-9]{64}$/.test(input.artifactRecordId)) throw new Error("artifactRecordId is invalid");
  if (!/^prov_[a-f0-9]{64}$/.test(input.artifactProvenanceDigest)) throw new Error("artifactProvenanceDigest is invalid");
  const base = Object.freeze({
    authority: "NEXUS_EVIDENCE_TRUST_ANCHOR_V1" as const,
    version: 1 as const,
    certified: true as const,
    subject: input.subject,
    sourceRevision: input.sourceRevision,
    tenantId: input.tenantId,
    projectId: input.projectId,
    bundleId: input.bundleId,
    keyId: input.keyId.trim(),
    payloadDigest: input.payloadDigest,
    artifactDigest: input.artifactDigest,
    artifactDescriptorDigest: input.artifactDescriptorDigest,
    artifactRecordId: input.artifactRecordId,
    artifactProvenanceDigest: input.artifactProvenanceDigest,
    verifiedGates: canonicalGates(input.verifiedGates),
  });
  return Object.freeze({ ...base, anchorDigest: digestValue(base) });
}

export function validateEvidenceTrustAnchor(anchor: EvidenceTrustAnchor): void {
  if (anchor.authority !== "NEXUS_EVIDENCE_TRUST_ANCHOR_V1" || anchor.version !== 1 || anchor.certified !== true) throw new Error("Unsupported or uncertified evidence trust anchor");
  const rebuilt = createEvidenceTrustAnchor({
    subject: anchor.subject,
    sourceRevision: anchor.sourceRevision,
    tenantId: anchor.tenantId,
    projectId: anchor.projectId,
    bundleId: anchor.bundleId,
    keyId: anchor.keyId,
    payloadDigest: anchor.payloadDigest,
    artifactDigest: anchor.artifactDigest,
    artifactDescriptorDigest: anchor.artifactDescriptorDigest,
    artifactRecordId: anchor.artifactRecordId,
    artifactProvenanceDigest: anchor.artifactProvenanceDigest,
    verifiedGates: anchor.verifiedGates,
  });
  if (rebuilt.anchorDigest !== anchor.anchorDigest || rebuilt.verifiedGates.some((gate, index) => gate !== anchor.verifiedGates[index])) throw new Error("Evidence trust anchor digest/canonicalization mismatch");
}
