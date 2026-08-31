export type {
  CreateExperienceProofInput,
  CreateFormalExperienceProofInput,
  EvidenceTrustAnchor,
  ExperienceArtifact,
  ExperienceProofAuthentication,
  ExperienceProofBundle,
  ExperienceProofClaim,
  ExperienceProofClaimKind,
  ExperienceProofStatus,
} from "./types.js";
export { artifactDigest, assertSourceRevision, createExperienceArtifact, validateExperienceArtifact } from "./artifact.js";
export {
  createEvidenceTrustAnchor,
  validateEvidenceTrustAnchor,
  validateEvidenceTrustAnchorAuthenticationBinding,
} from "./anchor.js";
export {
  createExperienceProof,
  formalExperienceProofDigest,
  validateExperienceProof,
  validateExperienceProofAgainstContent,
} from "./proof.js";
export type {
  ReplayGuard,
  ZkConsentEvidence,
  ZkConsentRequest,
  ZkConsentStatus,
  ZkConsentVerifierOptions,
} from "./zk-consent.js";
export { SnarkjsGroth16ConsentVerifier, requireVerifiedZkConsent, zkConsentBindingSignal } from "./zk-consent.js";
