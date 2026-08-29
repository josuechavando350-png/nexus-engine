import type { VerificationResult } from "@nexus/compositional-semantics";
import type { OriginalityAssessment } from "@nexus/originality-geodesics";
import type { CertifiedSynthesisResult } from "@nexus/topology";
import type { VisualAlgebraTerm } from "@nexus/visual-algebra";

export type ExperienceProofStatus = "VERIFIED" | "REJECTED";
export type ExperienceProofClaimKind =
  | "ARTIFACT"
  | "VISUAL_ALGEBRA"
  | "TOPOLOGY"
  | "COMPOSITIONAL_SEMANTICS"
  | "ORIGINALITY"
  | "SIGNED_EVIDENCE";

export interface ExperienceArtifact {
  readonly authority: "NEXUS_EXPERIENCE_ARTIFACT_V1";
  readonly version: 1;
  readonly subject: string;
  readonly mediaType: string;
  readonly sourceRevision: string;
  readonly artifactDigest: string;
  readonly descriptorDigest: string;
}

export interface EvidenceTrustAnchor {
  readonly authority: "NEXUS_EVIDENCE_TRUST_ANCHOR_V1";
  readonly version: 1;
  readonly certified: true;
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
  readonly anchorDigest: string;
}

export interface ExperienceProofClaim {
  readonly claimId: string;
  readonly kind: ExperienceProofClaimKind;
  readonly subject: string;
  readonly status: ExperienceProofStatus;
  readonly evidenceDigest: string;
  readonly dependencies: readonly string[];
}

export interface ExperienceProofBundle {
  readonly authority: "NEXUS_PROOF_CARRYING_EXPERIENCE_V2";
  readonly version: 2;
  readonly proofId: string;
  readonly subject: string;
  readonly sourceRevision: string;
  readonly formalDigest: string;
  readonly artifact: ExperienceArtifact;
  readonly visual: VisualAlgebraTerm;
  readonly topology: CertifiedSynthesisResult;
  readonly semantics: VerificationResult;
  readonly originality: OriginalityAssessment;
  readonly evidenceAnchor: EvidenceTrustAnchor;
  readonly claims: readonly ExperienceProofClaim[];
  readonly status: ExperienceProofStatus;
  readonly rootDigest: string;
}

export interface CreateExperienceProofInput {
  readonly artifact: ExperienceArtifact;
  readonly visual: VisualAlgebraTerm;
  readonly topology: CertifiedSynthesisResult;
  readonly semantics: VerificationResult;
  readonly originality: OriginalityAssessment;
  readonly evidenceAnchor: EvidenceTrustAnchor;
}

export interface CreateFormalExperienceProofInput {
  readonly artifact: ExperienceArtifact;
  readonly visual: VisualAlgebraTerm;
  readonly topology: CertifiedSynthesisResult;
  readonly semantics: VerificationResult;
  readonly originality: OriginalityAssessment;
}
