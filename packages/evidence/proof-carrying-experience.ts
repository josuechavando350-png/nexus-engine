import type { KeyLike } from "node:crypto";
import type { VerificationResult } from "@nexus/compositional-semantics";
import {
  createEvidenceTrustAnchor,
  createExperienceArtifact,
  createExperienceProof,
  validateExperienceProof,
  type ExperienceProofBundle,
} from "@nexus/proof-carrying-experience";
import type { CertifiedSynthesisResult } from "@nexus/topology";
import type { VisualAlgebraTerm } from "@nexus/visual-algebra";
import { verifySignedEvidenceBundle, type EvidenceRecord, type SignedEvidenceBundle } from "./index";
import { certifySignedEvidenceForDelivery } from "./signed-evidence-certification";

export interface SignedProofCarryingExperienceEnvelope {
  readonly authority: "NEXUS_SIGNED_PROOF_CARRYING_EXPERIENCE_V1";
  readonly version: 1;
  readonly proof: ExperienceProofBundle;
  readonly signedEvidence: SignedEvidenceBundle;
}

export function artifactEvidenceSourceId(sourceRevision: string, artifactDigest: string): string {
  return `artifact:${sourceRevision}:${artifactDigest}`;
}

function exactArtifactRecord(signedEvidence: SignedEvidenceBundle, sourceRevision: string, artifactDigest: string): EvidenceRecord {
  const sourceId = artifactEvidenceSourceId(sourceRevision, artifactDigest);
  const records = signedEvidence.bundle.records.filter((record) => record.source === "RUNTIME" && record.sourceId === sourceId);
  if (records.length !== 1) throw new Error(`expected exactly one signed artifact-binding RUNTIME record ${sourceId}`);
  const record = records[0]!;
  if (record.integrity !== "VERIFIED" || record.status !== "MEASURED") throw new Error("artifact-binding evidence must be verified measured evidence");
  return record;
}

function trustAnchor(input: {
  readonly subject: string;
  readonly sourceRevision: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly artifactDigest: string;
  readonly signedEvidence: SignedEvidenceBundle;
  readonly publicKey: KeyLike;
}) {
  const certification = certifySignedEvidenceForDelivery({
    signedEvidence: input.signedEvidence,
    publicKey: input.publicKey,
    sourceRevision: input.sourceRevision,
    tenantId: input.tenantId,
    projectId: input.projectId,
  });
  if (!certification.certified) throw new Error(`signed evidence is not delivery-certified: ${certification.findings.join("; ")}`);
  const artifactRecord = exactArtifactRecord(input.signedEvidence, input.sourceRevision, input.artifactDigest);
  return createEvidenceTrustAnchor({
    subject: input.subject,
    sourceRevision: input.sourceRevision,
    tenantId: input.tenantId,
    projectId: input.projectId,
    bundleId: input.signedEvidence.bundle.bundleId,
    keyId: input.signedEvidence.keyId,
    payloadDigest: input.signedEvidence.payloadDigest,
    artifactDigest: input.artifactDigest,
    artifactRecordId: artifactRecord.recordId,
    artifactProvenanceDigest: artifactRecord.provenanceDigest,
    verifiedGates: certification.verifiedGates,
  });
}

export function createSignedProofCarryingExperience(input: {
  readonly subject: string;
  readonly mediaType: string;
  readonly sourceRevision: string;
  readonly content: string | Uint8Array;
  readonly tenantId: string;
  readonly projectId: string;
  readonly visual: VisualAlgebraTerm;
  readonly topology: CertifiedSynthesisResult;
  readonly semantics: VerificationResult;
  readonly signedEvidence: SignedEvidenceBundle;
  readonly publicKey: KeyLike;
}): SignedProofCarryingExperienceEnvelope {
  const artifact = createExperienceArtifact({ subject: input.subject, mediaType: input.mediaType, sourceRevision: input.sourceRevision, content: input.content });
  const evidenceAnchor = trustAnchor({
    subject: input.subject,
    sourceRevision: input.sourceRevision,
    tenantId: input.tenantId,
    projectId: input.projectId,
    artifactDigest: artifact.artifactDigest,
    signedEvidence: input.signedEvidence,
    publicKey: input.publicKey,
  });
  const proof = createExperienceProof({ artifact, visual: input.visual, topology: input.topology, semantics: input.semantics, evidenceAnchor });
  if (proof.status !== "VERIFIED") throw new Error("Proof-carrying experience is REJECTED by upstream claims");
  return Object.freeze({ authority: "NEXUS_SIGNED_PROOF_CARRYING_EXPERIENCE_V1", version: 1, proof, signedEvidence: input.signedEvidence });
}

export function verifySignedProofCarryingExperience(envelope: SignedProofCarryingExperienceEnvelope, publicKey: KeyLike): true {
  if (envelope.authority !== "NEXUS_SIGNED_PROOF_CARRYING_EXPERIENCE_V1" || envelope.version !== 1) throw new Error("Unsupported signed proof-carrying experience envelope");
  verifySignedEvidenceBundle(envelope.signedEvidence, publicKey);
  const anchor = trustAnchor({
    subject: envelope.proof.subject,
    sourceRevision: envelope.proof.sourceRevision,
    tenantId: envelope.proof.evidenceAnchor.tenantId,
    projectId: envelope.proof.evidenceAnchor.projectId,
    artifactDigest: envelope.proof.artifact.artifactDigest,
    signedEvidence: envelope.signedEvidence,
    publicKey,
  });
  if (anchor.anchorDigest !== envelope.proof.evidenceAnchor.anchorDigest) throw new Error("Signed evidence trust anchor does not match proof");
  validateExperienceProof(envelope.proof);
  if (envelope.proof.status !== "VERIFIED") throw new Error("Signed proof-carrying experience is not VERIFIED");
  return true;
}
