import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import { semanticStateFromEngines, verifyComposition } from "@nexus/compositional-semantics";
import { createExperienceArtifact, formalExperienceProofDigest } from "@nexus/proof-carrying-experience";
import { synthesizeTermCertified } from "@nexus/topology";
import { createTerm, definePrimitive } from "@nexus/visual-algebra";
import { createRun, type EnvironmentDescriptor, type WorkloadDefinition } from "../measurement/index";
import { createEvidenceBundle, createEvidenceRecord, signEvidenceBundle } from "./index";
import {
  createProofBindingEvidenceRecord,
  createSignedProofCarryingExperience,
  verifySignedProofCarryingExperience,
} from "./proof-carrying-experience";

const revision = "0123456789abcdef0123456789abcdef01234567";
const subject = "client/home";
const content = "<html><body>proof-carrying</body></html>";
const gates = ["creative", "visual", "red-team", "repair", "accessibility", "browser", "build"] as const;
const workload: WorkloadDefinition = { id: "proof-carrying", version: "1.0.0", scope: { tenantId: "tenant-a", brandId: "project-a" }, name: "Proof carrying", parameters: {} };
const environment: EnvironmentDescriptor = { os: "linux", architecture: "x64", runtime: "node", runtimeVersion: "24", deviceClass: "ci" };
const run = createRun({ scope: workload.scope, startedAt: "2026-08-29T00:00:00.000Z", workload, environment });

function engines(offset = 0) {
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
  const semantics = verifyComposition({ planId: "semantics", subject, initialState, composition: { kind: "step", id: "noop", effects: [] } });
  return { visual, topology, semantics };
}

function formalFixture(sourceRevision = revision, artifactContent = content, offset = 0) {
  const artifact = createExperienceArtifact({ subject, mediaType: "text/html", sourceRevision, content: artifactContent });
  const engineEvidence = engines(offset);
  const formalDigest = formalExperienceProofDigest({ artifact, ...engineEvidence });
  return { artifact, formalDigest, ...engineEvidence };
}

function evidence(input: {
  artifact: ReturnType<typeof createExperienceArtifact>;
  formalDigest: string;
  includeProof?: boolean;
  requireRuntime?: boolean;
}) {
  const sourceRevision = input.artifact.sourceRevision;
  const quality = createEvidenceRecord({ runId: run.runId, scope: run.scope, source: "QUALITY", sourceId: `quality:${sourceRevision}`, status: "MEASURED", samples: gates.map((gate) => ({ name: `gate.${gate}`, unit: "boolean", value: 1 })), capturedAt: "2026-08-29T00:01:00.000Z", integrity: "VERIFIED" });
  const capture = createEvidenceRecord({ runId: run.runId, scope: run.scope, source: "CAPTURE", sourceId: `capture:${sourceRevision}:browser-matrix`, status: "MEASURED", samples: [{ name: "capture_artifacts", unit: "count", value: 3 }], capturedAt: "2026-08-29T00:01:00.000Z", integrity: "VERIFIED" });
  const records = [quality, capture];
  if (input.includeProof !== false) records.push(createProofBindingEvidenceRecord({
    runId: run.runId,
    scope: run.scope,
    sourceRevision,
    artifact: input.artifact,
    formalDigest: input.formalDigest,
    capturedAt: "2026-08-29T00:01:00.000Z",
  }));
  const requiredSources = input.requireRuntime === false ? ["CAPTURE", "QUALITY"] as const : ["CAPTURE", "QUALITY", "RUNTIME"] as const;
  const bundle = createEvidenceBundle(run, records, "2026-08-29T00:02:00.000Z", requiredSources);
  const keys = generateKeyPairSync("ed25519");
  return { signedEvidence: signEvidenceBundle(bundle, "proof-key", keys.privateKey), publicKey: keys.publicKey };
}

describe("signed proof-carrying experience integration", () => {
  test("cryptographically binds exact artifact bytes, Motors 1-3 and signed delivery evidence", () => {
    const fixture = formalFixture();
    const { signedEvidence, publicKey } = evidence(fixture);
    const envelope = createSignedProofCarryingExperience({ subject, mediaType: "text/html", sourceRevision: revision, content, tenantId: "tenant-a", projectId: "project-a", visual: fixture.visual, topology: fixture.topology, semantics: fixture.semantics, signedEvidence, publicKey });
    expect(envelope.proof.status).toBe("VERIFIED");
    expect(envelope.proof.formalDigest).toBe(fixture.formalDigest);
    expect(verifySignedProofCarryingExperience(envelope, publicKey, content)).toBe(true);
  });

  test("fails closed when signed proof-binding evidence is absent", () => {
    const fixture = formalFixture();
    const { signedEvidence, publicKey } = evidence({ ...fixture, includeProof: false });
    expect(() => createSignedProofCarryingExperience({ subject, mediaType: "text/html", sourceRevision: revision, content, tenantId: "tenant-a", projectId: "project-a", visual: fixture.visual, topology: fixture.topology, semantics: fixture.semantics, signedEvidence, publicKey })).toThrow(/delivery-certified|proof-binding/);
  });

  test("requires RUNTIME as a signed bundle source even if a proof record is present", () => {
    const fixture = formalFixture();
    const { signedEvidence, publicKey } = evidence({ ...fixture, requireRuntime: false });
    expect(() => createSignedProofCarryingExperience({ subject, mediaType: "text/html", sourceRevision: revision, content, tenantId: "tenant-a", projectId: "project-a", visual: fixture.visual, topology: fixture.topology, semantics: fixture.semantics, signedEvidence, publicKey })).toThrow(/require RUNTIME/);
  });

  test("does not allow different artifact bytes to reuse a valid signed evidence bundle", () => {
    const fixture = formalFixture();
    const { signedEvidence, publicKey } = evidence(fixture);
    expect(() => createSignedProofCarryingExperience({ subject, mediaType: "text/html", sourceRevision: revision, content: "different bytes", tenantId: "tenant-a", projectId: "project-a", visual: fixture.visual, topology: fixture.topology, semantics: fixture.semantics, signedEvidence, publicKey })).toThrow(/proof-binding RUNTIME record/);
  });

  test("does not allow a different valid Motor 1-3 chain to reuse the signed artifact bundle", () => {
    const original = formalFixture();
    const alternate = formalFixture(revision, content, 7);
    expect(alternate.artifact.descriptorDigest).toBe(original.artifact.descriptorDigest);
    expect(alternate.formalDigest).not.toBe(original.formalDigest);
    const { signedEvidence, publicKey } = evidence(original);
    expect(() => createSignedProofCarryingExperience({ subject, mediaType: "text/html", sourceRevision: revision, content, tenantId: "tenant-a", projectId: "project-a", visual: alternate.visual, topology: alternate.topology, semantics: alternate.semantics, signedEvidence, publicKey })).toThrow(/proof-binding RUNTIME record/);
  });

  test("final verification re-hashes the actual delivered bytes", () => {
    const fixture = formalFixture();
    const { signedEvidence, publicKey } = evidence(fixture);
    const envelope = createSignedProofCarryingExperience({ subject, mediaType: "text/html", sourceRevision: revision, content, tenantId: "tenant-a", projectId: "project-a", visual: fixture.visual, topology: fixture.topology, semantics: fixture.semantics, signedEvidence, publicKey });
    expect(() => verifySignedProofCarryingExperience(envelope, publicKey, "modified after signing")).toThrow(/Actual delivered artifact content/);
  });

  test("rejects an untrusted Ed25519 key", () => {
    const fixture = formalFixture();
    const { signedEvidence } = evidence(fixture);
    const attacker = generateKeyPairSync("ed25519");
    expect(() => createSignedProofCarryingExperience({ subject, mediaType: "text/html", sourceRevision: revision, content, tenantId: "tenant-a", projectId: "project-a", visual: fixture.visual, topology: fixture.topology, semantics: fixture.semantics, signedEvidence, publicKey: attacker.publicKey })).toThrow(/signature verification failed/);
  });

  test("rejects source revision replay even when artifact payload text matches", () => {
    const otherRevision = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const fixture = formalFixture(otherRevision);
    const { signedEvidence, publicKey } = evidence(fixture);
    const original = formalFixture();
    expect(() => createSignedProofCarryingExperience({ subject, mediaType: "text/html", sourceRevision: revision, content, tenantId: "tenant-a", projectId: "project-a", visual: original.visual, topology: original.topology, semantics: original.semantics, signedEvidence, publicKey })).toThrow(/delivery-certified|QUALITY record/);
  });
});
