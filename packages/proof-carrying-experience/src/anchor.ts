import { digestValue } from "@nexus/visual-algebra";
import { assertSourceRevision } from "./artifact.js";
import type { EvidenceTrustAnchor } from "./types.js";

const BASELINE_GATES = Object.freeze([
  "accessibility",
  "browser",
  "build",
  "creative",
  "red-team",
  "repair",
  "visual",
] as const);

function nonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} cannot be empty`);
}

function canonicalGates(gates: readonly string[]): readonly string[] {
  if (!gates.length) throw new Error("verifiedGates cannot be empty");
  for (const gate of gates) nonEmpty(gate, "verified gate");
  const unique = [...new Set(gates)].sort((a, b) => a.localeCompare(b));
  if (unique.length !== gates.length) throw new Error("verifiedGates cannot contain duplicates");
  if (unique.length !== BASELINE_GATES.length || unique.some((gate, index) => gate !== BASELINE_GATES[index])) {
    throw new Error("verifiedGates must contain the complete signed delivery baseline");
  }
  return Object.freeze(unique);
}

function validateAuthenticationEvidence(signingKeyFingerprint: string | undefined, signatureDigest: string | undefined): void {
  const hasFingerprint = signingKeyFingerprint !== undefined;
  const hasSignatureDigest = signatureDigest !== undefined;
  if (hasFingerprint !== hasSignatureDigest) {
    throw new Error("Evidence trust anchor authentication evidence must be complete");
  }
  if (!hasFingerprint) return;
  if (!/^sha256:[a-f0-9]{64}$/.test(signingKeyFingerprint!)) {
    throw new Error("signingKeyFingerprint must be SHA-256");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(signatureDigest!)) {
    throw new Error("signatureDigest must be SHA-256");
  }
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
  readonly formalDigest: string;
  readonly proofRecordId: string;
  readonly proofProvenanceDigest: string;
  readonly verifiedGates: readonly string[];
  readonly signingKeyFingerprint?: string;
  readonly signatureDigest?: string;
}): EvidenceTrustAnchor {
  for (const [label, value] of Object.entries({ subject: input.subject, tenantId: input.tenantId, projectId: input.projectId, keyId: input.keyId })) nonEmpty(value, label);
  assertSourceRevision(input.sourceRevision);
  if (!/^bundle_[a-f0-9]{64}$/.test(input.bundleId)) throw new Error("bundleId is invalid");
  if (!/^sha256:[a-f0-9]{64}$/.test(input.payloadDigest)) throw new Error("Evidence payloadDigest must be SHA-256");
  if (!/^sha256:[a-f0-9]{64}$/.test(input.artifactDigest)) throw new Error("Evidence artifactDigest must be SHA-256");
  if (!/^[a-f0-9]{64}$/.test(input.artifactDescriptorDigest)) throw new Error("Evidence artifactDescriptorDigest must be SHA-256 hex");
  if (!/^[a-f0-9]{64}$/.test(input.formalDigest)) throw new Error("Evidence formalDigest must be SHA-256 hex");
  if (!/^record_[a-f0-9]{64}$/.test(input.proofRecordId)) throw new Error("proofRecordId is invalid");
  if (!/^prov_[a-f0-9]{64}$/.test(input.proofProvenanceDigest)) throw new Error("proofProvenanceDigest is invalid");
  validateAuthenticationEvidence(input.signingKeyFingerprint, input.signatureDigest);
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
    formalDigest: input.formalDigest,
    proofRecordId: input.proofRecordId,
    proofProvenanceDigest: input.proofProvenanceDigest,
    verifiedGates: canonicalGates(input.verifiedGates),
    ...(input.signingKeyFingerprint ? { signingKeyFingerprint: input.signingKeyFingerprint } : {}),
    ...(input.signatureDigest ? { signatureDigest: input.signatureDigest } : {}),
  });
  return Object.freeze({ ...base, anchorDigest: digestValue(base) });
}

export function validateEvidenceTrustAnchor(anchor: EvidenceTrustAnchor): void {
  if (!anchor || typeof anchor !== "object") throw new Error("Evidence trust anchor must be an object");
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
    formalDigest: anchor.formalDigest,
    proofRecordId: anchor.proofRecordId,
    proofProvenanceDigest: anchor.proofProvenanceDigest,
    verifiedGates: anchor.verifiedGates,
    signingKeyFingerprint: anchor.signingKeyFingerprint,
    signatureDigest: anchor.signatureDigest,
  });
  if (rebuilt.anchorDigest !== anchor.anchorDigest || rebuilt.verifiedGates.some((gate, index) => gate !== anchor.verifiedGates[index])) throw new Error("Evidence trust anchor digest/canonicalization mismatch");
}

export function validateEvidenceTrustAnchorAuthenticationBinding(anchor: EvidenceTrustAnchor): void {
  validateEvidenceTrustAnchor(anchor);
  if (!anchor.signingKeyFingerprint || !anchor.signatureDigest) {
    throw new Error("Evidence trust anchor lacks signing-key/signature binding metadata");
  }
}
