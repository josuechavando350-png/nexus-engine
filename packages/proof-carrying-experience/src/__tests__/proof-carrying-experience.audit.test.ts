import { describe, expect, test } from "vitest";
import { semanticStateFromEngines, verifyComposition } from "@nexus/compositional-semantics";
import {
  assessOriginality,
  buildOriginalityManifold,
  createOriginalityPoint,
  createOriginalityPolicy,
  originalityPointFromTerm,
} from "@nexus/originality-geodesics";
import { synthesizeTermCertified } from "@nexus/topology";
import { createTerm, definePrimitive } from "@nexus/visual-algebra";
import {
  createEvidenceTrustAnchor,
  createExperienceArtifact,
  createExperienceProof,
  formalExperienceProofDigest,
  validateEvidenceTrustAnchorAuthenticationBinding,
  validateExperienceProof,
  validateExperienceProofAgainstContent,
} from "../index.js";

const revision = "0123456789abcdef0123456789abcdef01234567";
const subject = "client/home";
const content = "<html><body>proof audit</body></html>";
const gates = ["creative", "visual", "red-team", "repair", "accessibility", "browser", "build"] as const;

function fixture(withAuthenticationBinding = false) {
  const visual = createTerm({
    subject,
    canvasBounds: { x: 0, y: 0, width: 100, height: 100 },
    primitives: [
      definePrimitive({ id: "a", kind: "rectangle", bounds: { x: 5, y: 10, width: 10, height: 10 } }),
      definePrimitive({ id: "b", kind: "rectangle", bounds: { x: 75, y: 70, width: 10, height: 10 } }),
    ],
  });
  const topology = synthesizeTermCertified({ planId: "topology-audit", term: visual });
  const semantics = verifyComposition({
    planId: "semantics-audit",
    subject,
    initialState: semanticStateFromEngines({ visual, topology }),
    composition: { kind: "step", id: "noop", effects: [] },
  });
  const candidate = originalityPointFromTerm({ pointId: "candidate", role: "CANDIDATE", term: visual });
  const protectedPoint = createOriginalityPoint({
    pointId: "protected",
    role: "PROTECTED",
    subject: "protected/reference",
    termDigest: "a".repeat(64),
    metrics: {
      gridRegularity: visual.metrics.gridRegularity < 0.5 ? 1 : 0,
      axialSymmetry: visual.metrics.axialSymmetry < 0.5 ? 1 : 0,
      whitespace: visual.metrics.whitespace < 0.5 ? 1 : 0,
      continuity: visual.metrics.continuity < 0.5 ? 1 : 0,
      overlap: visual.metrics.overlap < 0.5 ? 1 : 0,
      structuralEntropy: visual.metrics.structuralEntropy < 0.5 ? 1 : 0,
      aspectConsistency: visual.metrics.aspectConsistency < 0.5 ? 1 : 0,
      packingDensity: visual.metrics.packingDensity < 0.5 ? 1 : 0,
    },
  });
  const originality = assessOriginality({
    candidate,
    manifold: buildOriginalityManifold({
      points: [protectedPoint],
      policy: createOriginalityPolicy({ kNeighbors: 1, minimumProtectedDirect: 0.05, minimumProtectedGeodesic: 0.05 }),
    }),
  });
  if (originality.status !== "CLEAR") throw new Error("audit fixture originality must be CLEAR");

  const artifact = createExperienceArtifact({ subject, mediaType: "text/html", sourceRevision: revision, content });
  const formalDigest = formalExperienceProofDigest({ artifact, visual, topology, semantics, originality });
  const anchor = createEvidenceTrustAnchor({
    subject,
    sourceRevision: revision,
    tenantId: "tenant-a",
    projectId: "project-a",
    bundleId: `bundle_${"1".repeat(64)}`,
    keyId: "audit-key-label",
    payloadDigest: `sha256:${"2".repeat(64)}`,
    artifactDigest: artifact.artifactDigest,
    artifactDescriptorDigest: artifact.descriptorDigest,
    formalDigest,
    proofRecordId: `record_${"3".repeat(64)}`,
    proofProvenanceDigest: `prov_${"4".repeat(64)}`,
    verifiedGates: gates,
    ...(withAuthenticationBinding ? {
      signingKeyFingerprint: `sha256:${"5".repeat(64)}`,
      signatureDigest: `sha256:${"6".repeat(64)}`,
    } : {}),
  });
  const proof = createExperienceProof({ artifact, visual, topology, semantics, originality, evidenceAnchor: anchor });
  return { anchor, proof };
}

describe("proof-carrying experience trust-boundary audit", () => {
  test("raw proof validation is explicitly structural-only and cannot be relabeled", () => {
    const { proof } = fixture();
    expect(proof.authentication).toBe("STRUCTURAL_ONLY");
    expect(validateExperienceProof(proof)).toBe(true);

    const relabeled = Object.freeze({ ...proof, authentication: "ED25519_VERIFIED" as never });
    expect(() => validateExperienceProof(relabeled)).toThrow(/authentication marker/);
  });

  test("rehashes the actual delivered bytes at the proof boundary", () => {
    const { proof } = fixture();
    expect(validateExperienceProofAgainstContent(proof, content)).toBe(true);
    expect(() => validateExperienceProofAgainstContent(proof, "modified bytes")).toThrow(/artifact content/);
  });

  test("requires complete signing-key/signature binding metadata for authenticated envelope assembly", () => {
    const structural = fixture().anchor;
    expect(() => validateEvidenceTrustAnchorAuthenticationBinding(structural)).toThrow(/lacks signing-key\/signature binding metadata/);

    const bound = fixture(true).anchor;
    expect(() => validateEvidenceTrustAnchorAuthenticationBinding(bound)).not.toThrow();
  });
});
