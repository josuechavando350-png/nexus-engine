import { validateVerificationResult } from "@nexus/compositional-semantics";
import { validateOriginalityAssessment } from "@nexus/originality-geodesics";
import { validateCertifiedSynthesisAgainstTerm } from "@nexus/topology";
import { digestValue, verifyVisualAlgebraTerm } from "@nexus/visual-algebra";
import type { VisualAlgebraTerm } from "@nexus/visual-algebra";
import { validateEvidenceTrustAnchor } from "./anchor.js";
import { artifactDigest, validateExperienceArtifact } from "./artifact.js";
import type {
  CreateExperienceProofInput,
  CreateFormalExperienceProofInput,
  ExperienceProofBundle,
  ExperienceProofClaim,
  ExperienceProofClaimKind,
  ExperienceProofStatus,
} from "./types.js";

function stableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const CLAIM_ORDER: readonly ExperienceProofClaimKind[] = Object.freeze([
  "ARTIFACT",
  "VISUAL_ALGEBRA",
  "TOPOLOGY",
  "COMPOSITIONAL_SEMANTICS",
  "ORIGINALITY",
  "SIGNED_EVIDENCE",
]);

function validateVisualTerm(term: VisualAlgebraTerm): void {
  verifyVisualAlgebraTerm(term);
}

function assertFormalLinkage(input: CreateFormalExperienceProofInput): void {
  validateExperienceArtifact(input.artifact);
  validateVisualTerm(input.visual);
  validateCertifiedSynthesisAgainstTerm(input.topology, input.visual);
  validateVerificationResult(input.semantics);
  validateOriginalityAssessment(input.originality);

  const subject = input.artifact.subject;
  if (
    input.visual.subject !== subject
    || input.topology.certificate.subject !== subject
    || input.semantics.certificate.subject !== subject
    || input.originality.candidate.subject !== subject
  ) {
    throw new Error("Formal proof subject linkage mismatch");
  }
  if (input.semantics.initialState.facts["visual.termDigest"] !== input.visual.digest) {
    throw new Error("Proof semantic state is not bound to Visual Algebra evidence");
  }
  if (input.semantics.initialState.facts["topology.certificateDigest"] !== input.topology.certificate.certificateDigest) {
    throw new Error("Proof semantic state is not bound to Topology evidence");
  }
  if (input.semantics.initialState.facts["topology.sourceTermDigest"] !== input.visual.digest) {
    throw new Error("Proof semantic state carries a mismatched Topology source term");
  }
  if (input.originality.candidate.termDigest !== input.visual.digest) {
    throw new Error("Proof originality candidate is not bound to Visual Algebra term");
  }
  if (digestValue(input.originality.candidate.metrics) !== digestValue(input.visual.metrics)) {
    throw new Error("Proof originality candidate metrics do not match Visual Algebra metrics");
  }
}

export function formalExperienceProofDigest(input: CreateFormalExperienceProofInput): string {
  assertFormalLinkage(input);
  return digestValue({
    authority: "NEXUS_FORMAL_EXPERIENCE_PROOF_V2",
    version: 2,
    subject: input.artifact.subject,
    sourceRevision: input.artifact.sourceRevision,
    artifactDescriptorDigest: input.artifact.descriptorDigest,
    visualDigest: input.visual.digest,
    topologyCertificateDigest: input.topology.certificate.certificateDigest,
    semanticCertificateDigest: input.semantics.certificate.certificateDigest,
    originalityAssessmentDigest: input.originality.assessmentDigest,
  });
}

function claim(input: Omit<ExperienceProofClaim, "claimId">): ExperienceProofClaim {
  const dependencies = Object.freeze([...input.dependencies].sort(stableCompare));
  const base = Object.freeze({ ...input, dependencies });
  return Object.freeze({ ...base, claimId: `claim_${digestValue(base)}` });
}

function assertLinkage(input: CreateExperienceProofInput): string {
  const formalDigest = formalExperienceProofDigest(input);
  validateEvidenceTrustAnchor(input.evidenceAnchor);

  if (input.evidenceAnchor.subject !== input.artifact.subject) throw new Error("Proof subject linkage mismatch");
  if (input.evidenceAnchor.sourceRevision !== input.artifact.sourceRevision) throw new Error("Proof source revision linkage mismatch");
  if (input.evidenceAnchor.artifactDigest !== input.artifact.artifactDigest) throw new Error("Proof artifact/evidence digest linkage mismatch");
  if (input.evidenceAnchor.artifactDescriptorDigest !== input.artifact.descriptorDigest) throw new Error("Proof artifact descriptor/evidence linkage mismatch");
  if (input.evidenceAnchor.formalDigest !== formalDigest) throw new Error("Signed evidence is not bound to the carried formal Motor 1-5 proof");
  return formalDigest;
}

function makeClaims(input: CreateExperienceProofInput): readonly ExperienceProofClaim[] {
  const artifact = claim({ kind: "ARTIFACT", subject: input.artifact.subject, status: "VERIFIED", evidenceDigest: input.artifact.descriptorDigest, dependencies: [] });
  const visualStatus: ExperienceProofStatus = input.visual.evaluations.every((evaluation) => evaluation.pass) ? "VERIFIED" : "REJECTED";
  const visual = claim({ kind: "VISUAL_ALGEBRA", subject: input.artifact.subject, status: visualStatus, evidenceDigest: input.visual.digest, dependencies: [] });
  const topologyStatus: ExperienceProofStatus = input.topology.status === "CERTIFIED" ? "VERIFIED" : "REJECTED";
  const topology = claim({ kind: "TOPOLOGY", subject: input.artifact.subject, status: topologyStatus, evidenceDigest: input.topology.certificate.certificateDigest, dependencies: [visual.claimId] });
  const semanticStatus: ExperienceProofStatus = input.semantics.status === "VERIFIED" ? "VERIFIED" : "REJECTED";
  const semantics = claim({ kind: "COMPOSITIONAL_SEMANTICS", subject: input.artifact.subject, status: semanticStatus, evidenceDigest: input.semantics.certificate.certificateDigest, dependencies: [visual.claimId, topology.claimId] });
  const originalityStatus: ExperienceProofStatus = input.originality.status === "CLEAR" ? "VERIFIED" : "REJECTED";
  const originality = claim({ kind: "ORIGINALITY", subject: input.artifact.subject, status: originalityStatus, evidenceDigest: input.originality.assessmentDigest, dependencies: [visual.claimId] });
  const evidence = claim({ kind: "SIGNED_EVIDENCE", subject: input.artifact.subject, status: "VERIFIED", evidenceDigest: input.evidenceAnchor.anchorDigest, dependencies: [artifact.claimId, visual.claimId, topology.claimId, semantics.claimId, originality.claimId] });
  const byKind = new Map<ExperienceProofClaimKind, ExperienceProofClaim>([
    [artifact.kind, artifact],
    [visual.kind, visual],
    [topology.kind, topology],
    [semantics.kind, semantics],
    [originality.kind, originality],
    [evidence.kind, evidence],
  ]);
  return Object.freeze(CLAIM_ORDER.map((kind) => byKind.get(kind)!));
}

function validateClaimGraph(claims: readonly ExperienceProofClaim[]): void {
  if (claims.length !== CLAIM_ORDER.length) throw new Error("Proof claim set is incomplete");
  const ids = new Set<string>();
  const kinds = new Set<ExperienceProofClaimKind>();
  for (const item of claims) {
    if (!/^claim_[a-f0-9]{64}$/.test(item.claimId)) throw new Error("Invalid proof claim id");
    if (ids.has(item.claimId)) throw new Error("Duplicate proof claim id");
    if (kinds.has(item.kind)) throw new Error(`Duplicate proof claim kind ${item.kind}`);
    ids.add(item.claimId);
    kinds.add(item.kind);
  }
  for (const kind of CLAIM_ORDER) if (!kinds.has(kind)) throw new Error(`Missing proof claim kind ${kind}`);
  for (const item of claims) {
    for (const dependency of item.dependencies) {
      if (!ids.has(dependency)) throw new Error(`Unknown proof claim dependency ${dependency}`);
    }
  }
}

export function createExperienceProof(input: CreateExperienceProofInput): ExperienceProofBundle {
  const formalDigest = assertLinkage(input);
  const claims = makeClaims(input);
  validateClaimGraph(claims);
  const status: ExperienceProofStatus = claims.every((item) => item.status === "VERIFIED") ? "VERIFIED" : "REJECTED";
  const authentication = "STRUCTURAL_ONLY" as const;
  const rootBase = Object.freeze({
    authority: "NEXUS_PROOF_CARRYING_EXPERIENCE_V2" as const,
    version: 2 as const,
    authentication,
    subject: input.artifact.subject,
    sourceRevision: input.artifact.sourceRevision,
    formalDigest,
    evidenceAnchorDigest: input.evidenceAnchor.anchorDigest,
    claims: claims.map((item) => item.claimId),
    status,
  });
  const rootDigest = digestValue(rootBase);
  return Object.freeze({
    authority: "NEXUS_PROOF_CARRYING_EXPERIENCE_V2",
    version: 2,
    authentication,
    proofId: `proof_${rootDigest}`,
    subject: input.artifact.subject,
    sourceRevision: input.artifact.sourceRevision,
    formalDigest,
    artifact: input.artifact,
    visual: input.visual,
    topology: input.topology,
    semantics: input.semantics,
    originality: input.originality,
    evidenceAnchor: input.evidenceAnchor,
    claims,
    status,
    rootDigest,
  });
}

export function validateExperienceProof(proof: ExperienceProofBundle): true {
  if (!proof || typeof proof !== "object") throw new Error("Proof-carrying experience must be an object");
  if (proof.authority !== "NEXUS_PROOF_CARRYING_EXPERIENCE_V2" || proof.version !== 2) {
    throw new Error("Unsupported proof-carrying experience authority/version");
  }
  if (proof.authentication !== "STRUCTURAL_ONLY") {
    throw new Error("Proof-carrying experience authentication marker is invalid");
  }
  const rebuilt = createExperienceProof({
    artifact: proof.artifact,
    visual: proof.visual,
    topology: proof.topology,
    semantics: proof.semantics,
    originality: proof.originality,
    evidenceAnchor: proof.evidenceAnchor,
  });
  if (
    rebuilt.proofId !== proof.proofId
    || rebuilt.rootDigest !== proof.rootDigest
    || rebuilt.formalDigest !== proof.formalDigest
    || rebuilt.status !== proof.status
    || digestValue(rebuilt.claims) !== digestValue(proof.claims)
  ) {
    throw new Error("Proof-carrying experience digest or claim linkage mismatch");
  }
  if (proof.subject !== rebuilt.subject || proof.sourceRevision !== rebuilt.sourceRevision) {
    throw new Error("Proof-carrying experience subject/revision mismatch");
  }
  return true;
}

export function validateExperienceProofAgainstContent(
  proof: ExperienceProofBundle,
  content: string | Uint8Array,
): true {
  validateExperienceProof(proof);
  if (artifactDigest(content) !== proof.artifact.artifactDigest) {
    throw new Error("Actual delivered artifact content does not match the proof artifact digest");
  }
  return true;
}
