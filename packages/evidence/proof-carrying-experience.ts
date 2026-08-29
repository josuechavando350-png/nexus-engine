import type { KeyLike } from "node:crypto";
import type { VerificationResult } from "@nexus/compositional-semantics";
import {
  createEvidenceTrustAnchor,
  createExperienceArtifact,
  createExperienceProof,
  formalExperienceProofDigest,
  validateExperienceProof,
  type ExperienceArtifact,
  type ExperienceProofBundle,
} from "@nexus/proof-carrying-experience";
import type { CertifiedSynthesisResult } from "@nexus/topology";
import type { VisualAlgebraTerm } from "@nexus/visual-algebra";
import type { MeasurementScope } from "../measurement/index";
import {
  createEvidenceRecord,
  verifySignedEvidenceBundle,
  type EvidenceRecord,
  type SignedEvidenceBundle,
} from "./index";
import { certifySignedEvidenceForDelivery } from "./signed-evidence-certification";

export interface SignedProofCarryingExperienceEnvelope {
  readonly authority: "NEXUS_SIGNED_PROOF_CARRYING_EXPERIENCE_V1";
  readonly version: 1;
  readonly proof: ExperienceProofBundle;
  readonly signedEvidence: SignedEvidenceBundle;
}

export function proofEvidenceSourceId(sourceRevision: string, artifactDescriptorDigest: string, formalDigest: string): string {
  if (!/^[a-f0-9]{40}$/.test(sourceRevision)) throw new Error("proof evidence sourceRevision must be a full lowercase git SHA-1");
  if (!/^[a-f0-9]{64}$/.test(artifactDescriptorDigest)) throw new Error("proof evidence descriptor digest must be SHA-256 hex");
  if (!/^[a-f0-9]{64}$/.test(formalDigest)) throw new Error("proof evidence formal digest must be SHA-256 hex");
  return `proof:${sourceRevision}:${artifactDescriptorDigest}:${formalDigest}`;
}

export function createProofBindingEvidenceRecord(input: {
  readonly runId: string;
  readonly scope: MeasurementScope;
  readonly sourceRevision: string;
  readonly artifact: ExperienceArtifact;
  readonly formalDigest: string;
  readonly capturedAt: string;
}): EvidenceRecord {
  if (input.artifact.sourceRevision !== input.sourceRevision) throw new Error("proof-binding artifact sourceRevision mismatch");
  return createEvidenceRecord({
    runId: input.runId,
    scope: input.scope,
    source: "RUNTIME",
    sourceId: proofEvidenceSourceId(input.sourceRevision, input.artifact.descriptorDigest, input.formalDigest),
    status: "MEASURED",
    samples: Object.freeze([{ name: "proof.binding", unit: "boolean", value: 1 }]),
    capturedAt: input.capturedAt,
    integrity: "VERIFIED",
  });
}

function exactProofRecord(signedEvidence: SignedEvidenceBundle, sourceRevision: string, artifactDescriptorDigest: string, formalDigest: string): EvidenceRecord {
  if (!signedEvidence.bundle.requiredSources.includes("RUNTIME")) throw new Error("signed proof evidence must require RUNTIME source");
  const sourceId = proofEvidenceSourceId(sourceRevision, artifactDescriptorDigest, formalDigest);
  const records = signedEvidence.bundle.records.filter((record) => record.source === "RUNTIME" && record.sourceId === sourceId);
  if (records.length !== 1) throw new Error(`expected exactly one signed proof-binding RUNTIME record ${sourceId}`);
  const record = records[0]!;
  if (record.integrity !== "VERIFIED" || record.status !== "MEASURED") throw new Error("proof-binding evidence must be verified measured evidence");
  if (record.samples.length !== 1 || record.samples[0]?.name !== "proof.binding" || record.samples[0].unit !== "boolean" || record.samples[0].value !== 1) {
    throw new Error("proof-binding evidence samples are not canonical");
  }
  return record;
}

function trustAnchor(input: {
  readonly subject: string;
  readonly sourceRevision: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly artifact: ExperienceArtifact;
  readonly formalDigest: string;
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
  const proofRecord = exactProofRecord(input.signedEvidence, input.sourceRevision, input.artifact.descriptorDigest, input.formalDigest);
  return createEvidenceTrustAnchor({
    subject: input.subject,
    sourceRevision: input.sourceRevision,
    tenantId: input.tenantId,
    projectId: input.projectId,
    bundleId: input.signedEvidence.bundle.bundleId,
    keyId: input.signedEvidence.keyId,
    payloadDigest: input.signedEvidence.payloadDigest,
    artifactDigest: input.artifact.artifactDigest,
    artifactDescriptorDigest: input.artifact.descriptorDigest,
    formalDigest: input.formalDigest,
    proofRecordId: proofRecord.recordId,
    proofProvenanceDigest: proofRecord.provenanceDigest,
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
  const formalDigest = formalExperienceProofDigest({ artifact, visual: input.visual, topology: input.topology, semantics: input.semantics });
  const evidenceAnchor = trustAnchor({
    subject: input.subject,
    sourceRevision: input.sourceRevision,
    tenantId: input.tenantId,
    projectId: input.projectId,
    artifact,
    formalDigest,
    signedEvidence: input.signedEvidence,
    publicKey: input.publicKey,
  });
  const proof = createExperienceProof({ artifact, visual: input.visual, topology: input.topology, semantics: input.semantics, evidenceAnchor });
  if (proof.status !== "VERIFIED") throw new Error("Proof-carrying experience is REJECTED by upstream claims");
  return Object.freeze({ authority: "NEXUS_SIGNED_PROOF_CARRYING_EXPERIENCE_V1", version: 1, proof, signedEvidence: input.signedEvidence });
}

export function verifySignedProofCarryingExperience(envelope: SignedProofCarryingExperienceEnvelope, publicKey: KeyLike, content: string | Uint8Array): true {
  if (envelope.authority !== "NEXUS_SIGNED_PROOF_CARRYING_EXPERIENCE_V1" || envelope.version !== 1) throw new Error("Unsupported signed proof-carrying experience envelope");
  verifySignedEvidenceBundle(envelope.signedEvidence, publicKey);
  const actualArtifact = createExperienceArtifact({
    subject: envelope.proof.artifact.subject,
    mediaType: envelope.proof.artifact.mediaType,
    sourceRevision: envelope.proof.artifact.sourceRevision,
    content,
  });
  if (actualArtifact.artifactDigest !== envelope.proof.artifact.artifactDigest || actualArtifact.descriptorDigest !== envelope.proof.artifact.descriptorDigest) {
    throw new Error("Actual delivered artifact content does not match the proof descriptor");
  }
  const formalDigest = formalExperienceProofDigest({ artifact: envelope.proof.artifact, visual: envelope.proof.visual, topology: envelope.proof.topology, semantics: envelope.proof.semantics });
  const anchor = trustAnchor({
    subject: envelope.proof.subject,
    sourceRevision: envelope.proof.sourceRevision,
    tenantId: envelope.proof.evidenceAnchor.tenantId,
    projectId: envelope.proof.evidenceAnchor.projectId,
    artifact: envelope.proof.artifact,
    formalDigest,
    signedEvidence: envelope.signedEvidence,
    publicKey,
  });
  if (anchor.anchorDigest !== envelope.proof.evidenceAnchor.anchorDigest) throw new Error("Signed evidence trust anchor does not match proof");
  validateExperienceProof(envelope.proof);
  if (envelope.proof.status !== "VERIFIED") throw new Error("Signed proof-carrying experience is not VERIFIED");
  return true;
}
