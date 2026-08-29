import { validateVerificationResult } from "@nexus/compositional-semantics";
import { validateCertifiedSynthesisResult } from "@nexus/topology";
import { digestValue } from "@nexus/visual-algebra";
import type { VisualAlgebraTerm } from "@nexus/visual-algebra";
import { validateEvidenceTrustAnchor } from "./anchor.js";
import { validateExperienceArtifact } from "./artifact.js";
import type { CreateExperienceProofInput, ExperienceProofBundle, ExperienceProofClaim, ExperienceProofClaimKind, ExperienceProofStatus } from "./types.js";

const CLAIM_ORDER: readonly ExperienceProofClaimKind[] = Object.freeze(["ARTIFACT", "VISUAL_ALGEBRA", "TOPOLOGY", "COMPOSITIONAL_SEMANTICS", "SIGNED_EVIDENCE"]);

function validateVisualTerm(term: VisualAlgebraTerm): void {
  if (!term.subject.trim()) throw new Error("Visual Algebra term subject cannot be empty");
  for (const evaluation of term.evaluations) if (typeof evaluation.pass !== "boolean") throw new Error("Visual Algebra constraint evaluation pass must be boolean");
  const expectedDigest = digestValue({
    authority: "NEXUS_VISUAL_ALGEBRA_TERM_V1",
    subject: term.subject,
    operation: term.operation,
    canvasBounds: term.canvasBounds,
    primitives: term.primitives,
    metrics: term.metrics,
    constraints: term.constraints,
    evaluations: term.evaluations,
  });
  if (expectedDigest !== term.digest) throw new Error("Visual Algebra term digest mismatch");
}

function claim(input: Omit<ExperienceProofClaim, "claimId">): ExperienceProofClaim {
  const dependencies = Object.freeze([...input.dependencies].sort((a, b) => a.localeCompare(b)));
  const base = Object.freeze({ ...input, dependencies });
  return Object.freeze({ ...base, claimId: `claim_${digestValue(base)}` });
}

function assertLinkage(input: CreateExperienceProofInput): void {
  validateExperienceArtifact(input.artifact);
  validateVisualTerm(input.visual);
  validateCertifiedSynthesisResult(input.topology);
  validateVerificationResult(input.semantics);
  validateEvidenceTrustAnchor(input.evidenceAnchor);

  const subject = input.artifact.subject;
  if (input.visual.subject !== subject || input.topology.certificate.subject !== subject || input.semantics.certificate.subject !== subject || input.evidenceAnchor.subject !== subject) {
    throw new Error("Proof subject linkage mismatch");
  }
  if (input.evidenceAnchor.sourceRevision !== input.artifact.sourceRevision) throw new Error("Proof source revision linkage mismatch");
  if (input.evidenceAnchor.artifactDigest !== input.artifact.artifactDigest) throw new Error("Proof artifact/evidence digest linkage mismatch");
  if (input.topology.certificate.sourceTermDigest !== input.visual.digest) throw new Error("Proof Visual Algebra / Topology provenance mismatch");
  if (input.semantics.initialState.facts["visual.termDigest"] !== input.visual.digest) throw new Error("Proof semantic state is not bound to Visual Algebra evidence");
  if (input.semantics.initialState.facts["topology.certificateDigest"] !== input.topology.certificate.certificateDigest) throw new Error("Proof semantic state is not bound to Topology evidence");
}

function makeClaims(input: CreateExperienceProofInput): readonly ExperienceProofClaim[] {
  const artifact = claim({ kind: "ARTIFACT", subject: input.artifact.subject, status: "VERIFIED", evidenceDigest: input.artifact.descriptorDigest, dependencies: [] });
  const visualStatus: ExperienceProofStatus = input.visual.evaluations.every((evaluation) => evaluation.pass) ? "VERIFIED" : "REJECTED";
  const visual = claim({ kind: "VISUAL_ALGEBRA", subject: input.artifact.subject, status: visualStatus, evidenceDigest: input.visual.digest, dependencies: [] });
  const topologyStatus: ExperienceProofStatus = input.topology.status === "CERTIFIED" ? "VERIFIED" : "REJECTED";
  const topology = claim({ kind: "TOPOLOGY", subject: input.artifact.subject, status: topologyStatus, evidenceDigest: input.topology.certificate.certificateDigest, dependencies: [visual.claimId] });
  const semanticStatus: ExperienceProofStatus = input.semantics.status === "VERIFIED" ? "VERIFIED" : "REJECTED";
  const semantics = claim({ kind: "COMPOSITIONAL_SEMANTICS", subject: input.artifact.subject, status: semanticStatus, evidenceDigest: input.semantics.certificate.certificateDigest, dependencies: [visual.claimId, topology.claimId] });
  const evidence = claim({ kind: "SIGNED_EVIDENCE", subject: input.artifact.subject, status: "VERIFIED", evidenceDigest: input.evidenceAnchor.anchorDigest, dependencies: [artifact.claimId] });
  const byKind = new Map<ExperienceProofClaimKind, ExperienceProofClaim>([[artifact.kind, artifact], [visual.kind, visual], [topology.kind, topology], [semantics.kind, semantics], [evidence.kind, evidence]]);
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
    ids.add(item.claimId); kinds.add(item.kind);
  }
  for (const kind of CLAIM_ORDER) if (!kinds.has(kind)) throw new Error(`Missing proof claim kind ${kind}`);
  for (const item of claims) for (const dependency of item.dependencies) if (!ids.has(dependency)) throw new Error(`Unknown proof claim dependency ${dependency}`);
}

export function createExperienceProof(input: CreateExperienceProofInput): ExperienceProofBundle {
  assertLinkage(input);
  const claims = makeClaims(input);
  validateClaimGraph(claims);
  const status: ExperienceProofStatus = claims.every((item) => item.status === "VERIFIED") ? "VERIFIED" : "REJECTED";
  const rootBase = Object.freeze({
    authority: "NEXUS_PROOF_CARRYING_EXPERIENCE_V1" as const,
    version: 1 as const,
    subject: input.artifact.subject,
    sourceRevision: input.artifact.sourceRevision,
    artifactDescriptorDigest: input.artifact.descriptorDigest,
    visualDigest: input.visual.digest,
    topologyCertificateDigest: input.topology.certificate.certificateDigest,
    semanticCertificateDigest: input.semantics.certificate.certificateDigest,
    evidenceAnchorDigest: input.evidenceAnchor.anchorDigest,
    claims: claims.map((item) => item.claimId),
    status,
  });
  const rootDigest = digestValue(rootBase);
  return Object.freeze({
    authority: "NEXUS_PROOF_CARRYING_EXPERIENCE_V1",
    version: 1,
    proofId: `proof_${rootDigest}`,
    subject: input.artifact.subject,
    sourceRevision: input.artifact.sourceRevision,
    artifact: input.artifact,
    visual: input.visual,
    topology: input.topology,
    semantics: input.semantics,
    evidenceAnchor: input.evidenceAnchor,
    claims,
    status,
    rootDigest,
  });
}

export function validateExperienceProof(proof: ExperienceProofBundle): true {
  if (proof.authority !== "NEXUS_PROOF_CARRYING_EXPERIENCE_V1" || proof.version !== 1) throw new Error("Unsupported proof-carrying experience authority/version");
  const rebuilt = createExperienceProof({ artifact: proof.artifact, visual: proof.visual, topology: proof.topology, semantics: proof.semantics, evidenceAnchor: proof.evidenceAnchor });
  if (rebuilt.proofId !== proof.proofId || rebuilt.rootDigest !== proof.rootDigest || rebuilt.status !== proof.status || digestValue(rebuilt.claims) !== digestValue(proof.claims)) {
    throw new Error("Proof-carrying experience digest or claim linkage mismatch");
  }
  if (proof.subject !== rebuilt.subject || proof.sourceRevision !== rebuilt.sourceRevision) throw new Error("Proof-carrying experience subject/revision mismatch");
  return true;
}
