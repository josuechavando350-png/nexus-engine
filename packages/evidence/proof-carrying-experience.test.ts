import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import { semanticStateFromEngines, verifyComposition } from "@nexus/compositional-semantics";
import { createExperienceArtifact } from "@nexus/proof-carrying-experience";
import { synthesizeTermCertified } from "@nexus/topology";
import { createTerm, definePrimitive } from "@nexus/visual-algebra";
import { createRun, type EnvironmentDescriptor, type WorkloadDefinition } from "../measurement/index";
import { createEvidenceBundle, createEvidenceRecord, signEvidenceBundle } from "./index";
import { artifactEvidenceSourceId, createSignedProofCarryingExperience, verifySignedProofCarryingExperience } from "./proof-carrying-experience";

const revision = "0123456789abcdef0123456789abcdef01234567";
const subject = "client/home";
const content = "<html><body>proof-carrying</body></html>";
const gates = ["creative", "visual", "red-team", "repair", "accessibility", "browser", "build"] as const;
const workload: WorkloadDefinition = { id: "proof-carrying", version: "1.0.0", scope: { tenantId: "tenant-a", brandId: "project-a" }, name: "Proof carrying", parameters: {} };
const environment: EnvironmentDescriptor = { os: "linux", architecture: "x64", runtime: "node", runtimeVersion: "24", deviceClass: "ci" };
const run = createRun({ scope: workload.scope, startedAt: "2026-08-29T00:00:00.000Z", workload, environment });

function engines() {
  const visual = createTerm({
    subject,
    canvasBounds: { x: 0, y: 0, width: 100, height: 100 },
    primitives: [definePrimitive({ id: "a", kind: "rectangle", bounds: { x: 10, y: 10, width: 10, height: 10 } }), definePrimitive({ id: "b", kind: "rectangle", bounds: { x: 70, y: 70, width: 10, height: 10 } })],
  });
  const topology = synthesizeTermCertified({ planId: "topology", term: visual });
  const initialState = semanticStateFromEngines({ visual, topology });
  const semantics = verifyComposition({ planId: "semantics", subject, initialState, composition: { kind: "step", id: "noop", effects: [] } });
  return { visual, topology, semantics };
}

function evidence(options: { includeArtifact?: boolean; artifactContent?: string; sourceRevision?: string; mediaType?: string } = {}) {
  const sourceRevision = options.sourceRevision ?? revision;
  const mediaType = options.mediaType ?? "text/html";
  const artifact = createExperienceArtifact({ subject, mediaType, sourceRevision, content: options.artifactContent ?? content });
  const quality = createEvidenceRecord({ runId: run.runId, scope: run.scope, source: "QUALITY", sourceId: `quality:${sourceRevision}`, status: "MEASURED", samples: gates.map((gate) => ({ name: `gate.${gate}`, unit: "boolean", value: 1 })), capturedAt: "2026-08-29T00:01:00.000Z", integrity: "VERIFIED" });
  const capture = createEvidenceRecord({ runId: run.runId, scope: run.scope, source: "CAPTURE", sourceId: `capture:${sourceRevision}:browser-matrix`, status: "MEASURED", samples: [{ name: "capture_artifacts", unit: "count", value: 3 }], capturedAt: "2026-08-29T00:01:00.000Z", integrity: "VERIFIED" });
  const records = [quality, capture];
  if (options.includeArtifact !== false) records.push(createEvidenceRecord({ runId: run.runId, scope: run.scope, source: "RUNTIME", sourceId: artifactEvidenceSourceId(sourceRevision, artifact.descriptorDigest), status: "MEASURED", samples: [{ name: "artifact_bytes", unit: "bytes", value: Buffer.byteLength(options.artifactContent ?? content) }], capturedAt: "2026-08-29T00:01:00.000Z", integrity: "VERIFIED" }));
  const bundle = createEvidenceBundle(run, records, "2026-08-29T00:02:00.000Z", ["CAPTURE", "QUALITY"]);
  const keys = generateKeyPairSync("ed25519");
  return { signedEvidence: signEvidenceBundle(bundle, "proof-key", keys.privateKey), publicKey: keys.publicKey };
}

describe("signed proof-carrying experience integration", () => {
  test("cryptographically binds exact artifact descriptor to Motors 1-3 and signed delivery evidence", () => {
    const { visual, topology, semantics } = engines();
    const { signedEvidence, publicKey } = evidence();
    const envelope = createSignedProofCarryingExperience({ subject, mediaType: "text/html", sourceRevision: revision, content, tenantId: "tenant-a", projectId: "project-a", visual, topology, semantics, signedEvidence, publicKey });
    expect(envelope.proof.status).toBe("VERIFIED");
    expect(verifySignedProofCarryingExperience(envelope, publicKey)).toBe(true);
  });

  test("fails closed when exact artifact-binding evidence is absent", () => {
    const { visual, topology, semantics } = engines();
    const { signedEvidence, publicKey } = evidence({ includeArtifact: false });
    expect(() => createSignedProofCarryingExperience({ subject, mediaType: "text/html", sourceRevision: revision, content, tenantId: "tenant-a", projectId: "project-a", visual, topology, semantics, signedEvidence, publicKey })).toThrow(/artifact-binding RUNTIME record/);
  });

  test("does not allow different artifact bytes to reuse a valid signed evidence bundle", () => {
    const { visual, topology, semantics } = engines();
    const { signedEvidence, publicKey } = evidence();
    expect(() => createSignedProofCarryingExperience({ subject, mediaType: "text/html", sourceRevision: revision, content: "different bytes", tenantId: "tenant-a", projectId: "project-a", visual, topology, semantics, signedEvidence, publicKey })).toThrow(/artifact-binding RUNTIME record/);
  });

  test("does not allow another media type to reuse signed evidence for identical bytes", () => {
    const { visual, topology, semantics } = engines();
    const { signedEvidence, publicKey } = evidence({ mediaType: "text/html" });
    expect(() => createSignedProofCarryingExperience({ subject, mediaType: "application/xhtml+xml", sourceRevision: revision, content, tenantId: "tenant-a", projectId: "project-a", visual, topology, semantics, signedEvidence, publicKey })).toThrow(/artifact-binding RUNTIME record/);
  });

  test("rejects an untrusted Ed25519 key", () => {
    const { visual, topology, semantics } = engines();
    const { signedEvidence } = evidence();
    const attacker = generateKeyPairSync("ed25519");
    expect(() => createSignedProofCarryingExperience({ subject, mediaType: "text/html", sourceRevision: revision, content, tenantId: "tenant-a", projectId: "project-a", visual, topology, semantics, signedEvidence, publicKey: attacker.publicKey })).toThrow(/signature verification failed/);
  });

  test("rejects source revision replay even when artifact bytes match", () => {
    const { visual, topology, semantics } = engines();
    const otherRevision = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const { signedEvidence, publicKey } = evidence({ sourceRevision: otherRevision });
    expect(() => createSignedProofCarryingExperience({ subject, mediaType: "text/html", sourceRevision: revision, content, tenantId: "tenant-a", projectId: "project-a", visual, topology, semantics, signedEvidence, publicKey })).toThrow(/delivery-certified|QUALITY record/);
  });
});
