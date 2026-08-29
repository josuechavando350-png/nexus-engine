import { describe, expect, test } from "vitest";
import { semanticStateFromEngines, verifyComposition } from "@nexus/compositional-semantics";
import { synthesizeTermCertified } from "@nexus/topology";
import { createTerm, definePrimitive } from "@nexus/visual-algebra";
import {
  createEvidenceTrustAnchor,
  createExperienceArtifact,
  createExperienceProof,
  validateExperienceProof,
} from "../index.js";

const revision = "0123456789abcdef0123456789abcdef01234567";
const subject = "client/home";
const artifactContent = "<html><body>NEXUS</body></html>";

function engines(rejected = false) {
  const visual = createTerm({
    subject,
    canvasBounds: { x: 0, y: 0, width: 100, height: 100 },
    primitives: [
      definePrimitive({ id: "a", kind: "rectangle", bounds: { x: 10, y: 10, width: 10, height: 10 } }),
      definePrimitive({ id: "b", kind: "rectangle", bounds: { x: 70, y: 70, width: 10, height: 10 } }),
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

function fixture(rejected = false) {
  const artifact = createExperienceArtifact({ subject, mediaType: "text/html", sourceRevision: revision, content: artifactContent });
  const anchor = createEvidenceTrustAnchor({
    subject,
    sourceRevision: revision,
    tenantId: "tenant-a",
    projectId: "project-a",
    bundleId: `bundle_${"1".repeat(64)}`,
    keyId: "fixture-key",
    payloadDigest: `sha256:${"2".repeat(64)}`,
    artifactDigest: artifact.artifactDigest,
    artifactRecordId: `record_${"3".repeat(64)}`,
    artifactProvenanceDigest: `prov_${"4".repeat(64)}`,
    verifiedGates: ["visual", "build", "browser"],
  });
  return { artifact, anchor, ...engines(rejected) };
}

describe("proof-carrying experience", () => {
  test("digests exact artifact bytes deterministically", () => {
    const a = createExperienceArtifact({ subject, mediaType: "text/html", sourceRevision: revision, content: artifactContent });
    const b = createExperienceArtifact({ subject, mediaType: "text/html", sourceRevision: revision, content: Buffer.from(artifactContent) });
    expect(a.artifactDigest).toBe(b.artifactDigest);
    expect(a.descriptorDigest).toBe(b.descriptorDigest);
  });

  test("creates a deterministic verified proof linked across Motors 1-3", () => {
    const { artifact, anchor, visual, topology, semantics } = fixture();
    const first = createExperienceProof({ artifact, evidenceAnchor: anchor, visual, topology, semantics });
    const second = createExperienceProof({ artifact, evidenceAnchor: anchor, visual, topology, semantics });
    expect(first.status).toBe("VERIFIED");
    expect(first.proofId).toBe(second.proofId);
    expect(first.claims).toHaveLength(5);
    expect(validateExperienceProof(first)).toBe(true);
  });

  test("carries a valid upstream rejection without converting it into success", () => {
    const { artifact, anchor, visual, topology, semantics } = fixture(true);
    const proof = createExperienceProof({ artifact, evidenceAnchor: anchor, visual, topology, semantics });
    expect(semantics.status).toBe("REJECTED");
    expect(proof.status).toBe("REJECTED");
    expect(proof.claims.find((item) => item.kind === "COMPOSITIONAL_SEMANTICS")?.status).toBe("REJECTED");
    expect(validateExperienceProof(proof)).toBe(true);
  });

  test("rejects source-revision replay", () => {
    const { artifact, anchor, visual, topology, semantics } = fixture();
    const replay = { ...anchor, sourceRevision: "abcdefabcdefabcdefabcdefabcdefabcdefabcd" } as typeof anchor;
    expect(() => createExperienceProof({ artifact, evidenceAnchor: replay, visual, topology, semantics })).toThrow(/source revision linkage mismatch|anchor digest/);
  });

  test("rejects artifact/evidence substitution", () => {
    const { artifact, anchor, visual, topology, semantics } = fixture();
    const otherArtifact = createExperienceArtifact({ subject, mediaType: "text/html", sourceRevision: revision, content: "different" });
    expect(() => createExperienceProof({ artifact: otherArtifact, evidenceAnchor: anchor, visual, topology, semantics })).toThrow(/artifact\/evidence digest linkage mismatch/);
  });

  test("rejects semantic evidence that did not consume topology", () => {
    const { artifact, anchor, visual, topology } = fixture();
    const initialState = semanticStateFromEngines({ visual });
    const semantics = verifyComposition({ planId: "semantics", subject, initialState, composition: { kind: "step", id: "accept", effects: [] } });
    expect(() => createExperienceProof({ artifact, evidenceAnchor: anchor, visual, topology, semantics })).toThrow(/not bound to Topology/);
  });

  test("detects claim/root tampering", () => {
    const { artifact, anchor, visual, topology, semantics } = fixture();
    const proof = createExperienceProof({ artifact, evidenceAnchor: anchor, visual, topology, semantics });
    const tampered = Object.freeze({ ...proof, claims: Object.freeze(proof.claims.map((item, index) => index === 0 ? Object.freeze({ ...item, status: "REJECTED" as const }) : item)) });
    expect(() => validateExperienceProof(tampered)).toThrow(/digest or claim linkage mismatch/);
  });

  test("rejects cross-subject proof assembly", () => {
    const { artifact, anchor, visual, topology, semantics } = fixture();
    const wrongAnchor = createEvidenceTrustAnchor({
      subject: "other/home", sourceRevision: revision, tenantId: anchor.tenantId, projectId: anchor.projectId,
      bundleId: anchor.bundleId, keyId: anchor.keyId, payloadDigest: anchor.payloadDigest, artifactDigest: anchor.artifactDigest,
      artifactRecordId: anchor.artifactRecordId, artifactProvenanceDigest: anchor.artifactProvenanceDigest, verifiedGates: anchor.verifiedGates,
    });
    expect(() => createExperienceProof({ artifact, evidenceAnchor: wrongAnchor, visual, topology, semantics })).toThrow(/subject linkage mismatch/);
  });
});
