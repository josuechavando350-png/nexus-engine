import { describe, expect, test } from "vitest";
import { createSemanticState, semanticStateFromEngines, verifyComposition } from "@nexus/compositional-semantics";
import {
  assessOriginality,
  buildOriginalityManifold,
  createOriginalityPoint,
  createOriginalityPolicy,
  originalityPointFromTerm,
} from "@nexus/originality-geodesics";
import { synthesizeTermCertified } from "@nexus/topology";
import { createTerm, definePrimitive } from "@nexus/visual-algebra";
import type { GeometricMetrics } from "@nexus/visual-algebra";
import {
  createEvidenceTrustAnchor,
  createExperienceArtifact,
  createExperienceProof,
  formalExperienceProofDigest,
  validateExperienceProof,
} from "../index.js";

const revision = "0123456789abcdef0123456789abcdef01234567";
const subject = "client/home";
const artifactContent = "<html><body>NEXUS</body></html>";
const gates = ["creative", "visual", "red-team", "repair", "accessibility", "browser", "build"] as const;

function engines(rejected = false, offset = 0) {
  const visual = createTerm({
    subject,
    canvasBounds: { x: 0, y: 0, width: 100, height: 100 },
    primitives: [
      definePrimitive({ id: "a", kind: "rectangle", bounds: { x: 10 + offset, y: 10, width: 10, height: 10 } }),
      definePrimitive({ id: "b", kind: "rectangle", bounds: { x: 70, y: 70 - offset, width: 10, height: 10 } }),
    ],
  });
  const topology = synthesizeTermCertified({ planId: "topology", term: visual });
  const initialState = semanticStateFromEngines({ visual, topology });
  const semantics = verifyComposition({
    planId: "semantics",
    subject,
    initialState,
    composition: rejected
      ? { kind: "step", id: "reject", effects: [], contract: { id: "reject.contract", requires: [{ id: "missing", formula: { op: "exists", operand: { kind: "fact", name: "missing" } } }] } }
      : { kind: "step", id: "accept", effects: [] },
  });
  return { visual, topology, semantics };
}

function oppositeMetrics(metrics: GeometricMetrics): GeometricMetrics {
  return Object.freeze({
    gridRegularity: metrics.gridRegularity < 0.5 ? 1 : 0,
    axialSymmetry: metrics.axialSymmetry < 0.5 ? 1 : 0,
    whitespace: metrics.whitespace < 0.5 ? 1 : 0,
    continuity: metrics.continuity < 0.5 ? 1 : 0,
    overlap: metrics.overlap < 0.5 ? 1 : 0,
    structuralEntropy: metrics.structuralEntropy < 0.5 ? 1 : 0,
    aspectConsistency: metrics.aspectConsistency < 0.5 ? 1 : 0,
    packingDensity: metrics.packingDensity < 0.5 ? 1 : 0,
  });
}

function originalityFor(visual: ReturnType<typeof engines>["visual"], tooClose = false) {
  const candidate = originalityPointFromTerm({ pointId: "candidate", role: "CANDIDATE", term: visual });
  const referenceMetrics = tooClose ? visual.metrics : oppositeMetrics(visual.metrics);
  const protectedPoint = createOriginalityPoint({
    pointId: "protected-reference",
    role: "PROTECTED",
    subject: "protected/reference",
    termDigest: "a".repeat(64),
    metrics: referenceMetrics,
  });
  const manifold = buildOriginalityManifold({
    points: [protectedPoint],
    policy: createOriginalityPolicy({ kNeighbors: 1, minimumProtectedDirect: 0.1, minimumProtectedGeodesic: 0.1 }),
  });
  return assessOriginality({ candidate, manifold });
}

function fixture(rejected = false, originalityTooClose = false) {
  const artifact = createExperienceArtifact({ subject, mediaType: "text/html", sourceRevision: revision, content: artifactContent });
  const engineEvidence = engines(rejected);
  const originality = originalityFor(engineEvidence.visual, originalityTooClose);
  const formalDigest = formalExperienceProofDigest({ artifact, ...engineEvidence, originality });
  const anchor = createEvidenceTrustAnchor({
    subject,
    sourceRevision: revision,
    tenantId: "tenant-a",
    projectId: "project-a",
    bundleId: `bundle_${"1".repeat(64)}`,
    keyId: "fixture-key",
    payloadDigest: `sha256:${"2".repeat(64)}`,
    artifactDigest: artifact.artifactDigest,
    artifactDescriptorDigest: artifact.descriptorDigest,
    formalDigest,
    proofRecordId: `record_${"3".repeat(64)}`,
    proofProvenanceDigest: `prov_${"4".repeat(64)}`,
    verifiedGates: gates,
  });
  return { artifact, anchor, formalDigest, originality, ...engineEvidence };
}

describe("proof-carrying experience with originality", () => {
  test("digests exact artifact bytes deterministically", () => {
    const a = createExperienceArtifact({ subject, mediaType: "text/html", sourceRevision: revision, content: artifactContent });
    const b = createExperienceArtifact({ subject, mediaType: "text/html", sourceRevision: revision, content: Buffer.from(artifactContent) });
    expect(a.artifactDigest).toBe(b.artifactDigest);
    expect(a.descriptorDigest).toBe(b.descriptorDigest);
  });

  test("creates a deterministic verified proof linked across Motors 1-5 and signed formal identity", () => {
    const { artifact, anchor, formalDigest, visual, topology, semantics, originality } = fixture();
    const first = createExperienceProof({ artifact, evidenceAnchor: anchor, visual, topology, semantics, originality });
    const second = createExperienceProof({ artifact, evidenceAnchor: anchor, visual, topology, semantics, originality });
    expect(originality.status).toBe("CLEAR");
    expect(first.status).toBe("VERIFIED");
    expect(first.formalDigest).toBe(formalDigest);
    expect(first.proofId).toBe(second.proofId);
    expect(first.claims).toHaveLength(6);
    expect(first.claims.find((item) => item.kind === "ORIGINALITY")?.status).toBe("VERIFIED");
    expect(validateExperienceProof(first)).toBe(true);
  });

  test("carries semantic rejection without converting it into success", () => {
    const { artifact, anchor, visual, topology, semantics, originality } = fixture(true);
    const proof = createExperienceProof({ artifact, evidenceAnchor: anchor, visual, topology, semantics, originality });
    expect(semantics.status).toBe("REJECTED");
    expect(proof.status).toBe("REJECTED");
    expect(proof.claims.find((item) => item.kind === "COMPOSITIONAL_SEMANTICS")?.status).toBe("REJECTED");
    expect(validateExperienceProof(proof)).toBe(true);
  });

  test("carries originality rejection without converting it into success", () => {
    const { artifact, anchor, visual, topology, semantics, originality } = fixture(false, true);
    const proof = createExperienceProof({ artifact, evidenceAnchor: anchor, visual, topology, semantics, originality });
    expect(originality.status).toBe("TOO_CLOSE");
    expect(proof.status).toBe("REJECTED");
    expect(proof.claims.find((item) => item.kind === "ORIGINALITY")?.status).toBe("REJECTED");
    expect(validateExperienceProof(proof)).toBe(true);
  });

  test("rejects source-revision replay", () => {
    const { artifact, anchor, visual, topology, semantics, originality } = fixture();
    const replay = { ...anchor, sourceRevision: "abcdefabcdefabcdefabcdefabcdefabcdefabcd" } as typeof anchor;
    expect(() => createExperienceProof({ artifact, evidenceAnchor: replay, visual, topology, semantics, originality })).toThrow(/source revision linkage mismatch|anchor digest/);
  });

  test("rejects artifact/evidence substitution including media-type descriptor changes", () => {
    const { artifact, anchor, visual, topology, semantics, originality } = fixture();
    const otherArtifact = createExperienceArtifact({ subject, mediaType: "text/plain", sourceRevision: revision, content: artifactContent });
    expect(otherArtifact.artifactDigest).toBe(artifact.artifactDigest);
    expect(otherArtifact.descriptorDigest).not.toBe(artifact.descriptorDigest);
    expect(() => createExperienceProof({ artifact: otherArtifact, evidenceAnchor: anchor, visual, topology, semantics, originality })).toThrow(/descriptor\/evidence|formal Motor 1-5 proof/);
  });

  test("rejects semantic evidence that did not consume topology", () => {
    const { artifact, anchor, visual, topology, originality } = fixture();
    const initialState = semanticStateFromEngines({ visual });
    const semantics = verifyComposition({ planId: "semantics", subject, initialState, composition: { kind: "step", id: "accept", effects: [] } });
    expect(() => createExperienceProof({ artifact, evidenceAnchor: anchor, visual, topology, semantics, originality })).toThrow(/not bound to Topology/);
  });

  test("rejects semantic lineage missing the topology source-term digest even when other digests match", () => {
    const { artifact, anchor, visual, topology, originality } = fixture();
    const initialState = createSemanticState({
      facts: {
        "visual.termDigest": visual.digest,
        "topology.certificateDigest": topology.certificate.certificateDigest,
      },
    });
    const semantics = verifyComposition({ planId: "semantics", subject, initialState, composition: { kind: "step", id: "accept", effects: [] } });
    expect(() => createExperienceProof({ artifact, evidenceAnchor: anchor, visual, topology, semantics, originality })).toThrow(/Topology source term/);
  });

  test("rejects originality evidence bound to a different Visual Algebra term", () => {
    const { artifact, anchor, visual, topology, semantics } = fixture();
    const alternate = engines(false, 5);
    const wrongOriginality = originalityFor(alternate.visual);
    expect(() => createExperienceProof({ artifact, evidenceAnchor: anchor, visual, topology, semantics, originality: wrongOriginality })).toThrow(/originality candidate/);
  });

  test("rejects a valid but differently signed formal Motor 1-5 identity", () => {
    const { artifact, anchor } = fixture();
    const alternate = engines(false, 5);
    const originality = originalityFor(alternate.visual);
    const alternateFormal = formalExperienceProofDigest({ artifact, ...alternate, originality });
    expect(alternateFormal).not.toBe(anchor.formalDigest);
    expect(() => createExperienceProof({ artifact, evidenceAnchor: anchor, ...alternate, originality })).toThrow(/formal Motor 1-5 proof/);
  });

  test("detects claim/root tampering", () => {
    const { artifact, anchor, visual, topology, semantics, originality } = fixture();
    const proof = createExperienceProof({ artifact, evidenceAnchor: anchor, visual, topology, semantics, originality });
    const tampered = Object.freeze({ ...proof, claims: Object.freeze(proof.claims.map((item, index) => index === 0 ? Object.freeze({ ...item, status: "REJECTED" as const }) : item)) });
    expect(() => validateExperienceProof(tampered)).toThrow(/digest or claim linkage mismatch/);
  });

  test("rejects cross-subject proof assembly", () => {
    const { artifact, anchor, visual, topology, semantics, originality } = fixture();
    const wrongAnchor = createEvidenceTrustAnchor({
      subject: "other/home",
      sourceRevision: revision,
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
    });
    expect(() => createExperienceProof({ artifact, evidenceAnchor: wrongAnchor, visual, topology, semantics, originality })).toThrow(/subject linkage mismatch/);
  });

  test("refuses downgraded delivery gate anchors", () => {
    const { artifact, formalDigest } = fixture();
    expect(() => createEvidenceTrustAnchor({
      subject,
      sourceRevision: revision,
      tenantId: "tenant-a",
      projectId: "project-a",
      bundleId: `bundle_${"1".repeat(64)}`,
      keyId: "fixture-key",
      payloadDigest: `sha256:${"2".repeat(64)}`,
      artifactDigest: artifact.artifactDigest,
      artifactDescriptorDigest: artifact.descriptorDigest,
      formalDigest,
      proofRecordId: `record_${"3".repeat(64)}`,
      proofProvenanceDigest: `prov_${"4".repeat(64)}`,
      verifiedGates: ["visual", "build", "browser"],
    })).toThrow(/complete signed delivery baseline/);
  });
});
