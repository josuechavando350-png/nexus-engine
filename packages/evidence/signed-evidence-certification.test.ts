import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createRun, type EnvironmentDescriptor, type WorkloadDefinition } from "../measurement/index";
import { createEvidenceBundle, createEvidenceRecord, signEvidenceBundle } from "./index";
import { certifySignedEvidenceForDelivery } from "./signed-evidence-certification";

const revision = "0123456789abcdef0123456789abcdef01234567";
const workload: WorkloadDefinition = {
  id: "delivery-certification",
  version: "1.0.0",
  scope: { tenantId: "tenant-a", brandId: "project-a" },
  name: "Delivery certification",
  parameters: {},
};
const environment: EnvironmentDescriptor = {
  os: "linux",
  architecture: "x64",
  runtime: "node",
  runtimeVersion: "24",
  deviceClass: "ci",
};
const run = createRun({ scope: workload.scope, startedAt: "2026-08-17T07:10:00.000Z", workload, environment });
const gates = ["creative", "visual", "red-team", "repair", "accessibility", "browser", "build"] as const;

function signedEvidence(options: { omittedGate?: typeof gates[number]; sourceRevision?: string; captureRevision?: string } = {}) {
  const quality = createEvidenceRecord({
    runId: run.runId,
    scope: run.scope,
    source: "QUALITY",
    sourceId: `quality:${options.sourceRevision ?? revision}`,
    status: "MEASURED",
    samples: gates.filter((gate) => gate !== options.omittedGate).map((gate) => ({ name: `gate.${gate}`, unit: "boolean", value: 1 })),
    capturedAt: "2026-08-17T07:11:00.000Z",
    integrity: "VERIFIED",
  });
  const capture = createEvidenceRecord({
    runId: run.runId,
    scope: run.scope,
    source: "CAPTURE",
    sourceId: `capture:${options.captureRevision ?? revision}:browser-matrix`,
    status: "MEASURED",
    samples: [{ name: "capture_artifacts", unit: "count", value: 12 }],
    capturedAt: "2026-08-17T07:11:00.000Z",
    integrity: "VERIFIED",
  });
  const bundle = createEvidenceBundle(run, [quality, capture], "2026-08-17T07:12:00.000Z", ["CAPTURE", "QUALITY"]);
  const keys = generateKeyPairSync("ed25519");
  return { signed: signEvidenceBundle(bundle, "delivery-fixture", keys.privateKey), publicKey: keys.publicKey };
}

describe("delivery certification", () => {
  it("certifies only a signed exact-revision bundle with every mandatory gate", () => {
    const { signed, publicKey } = signedEvidence();
    const result = certifySignedEvidenceForDelivery({ signedEvidence: signed, publicKey, sourceRevision: revision, tenantId: "tenant-a", projectId: "project-a" });
    expect(result.certified).toBe(true);
    expect(result.verifiedGates).toHaveLength(gates.length);
  });

  it("fails closed when a mandatory gate is absent", () => {
    const { signed, publicKey } = signedEvidence({ omittedGate: "visual" });
    const result = certifySignedEvidenceForDelivery({ signedEvidence: signed, publicKey, sourceRevision: revision, tenantId: "tenant-a", projectId: "project-a" });
    expect(result.certified).toBe(false);
    expect(result.findings.join(" ")).toMatch(/gate.visual/);
  });

  it("rejects custom policies that remove a baseline mandatory gate", () => {
    const { signed, publicKey } = signedEvidence();
    expect(() => certifySignedEvidenceForDelivery({
      signedEvidence: signed,
      publicKey,
      sourceRevision: revision,
      tenantId: "tenant-a",
      projectId: "project-a",
      policy: { requiredSources: ["CAPTURE", "QUALITY"], requiredGates: ["build"] },
    })).toThrow(/cannot remove baseline required gate creative/);
  });

  it("rejects custom policies that remove a baseline evidence source", () => {
    const { signed, publicKey } = signedEvidence();
    expect(() => certifySignedEvidenceForDelivery({
      signedEvidence: signed,
      publicKey,
      sourceRevision: revision,
      tenantId: "tenant-a",
      projectId: "project-a",
      policy: { requiredSources: ["QUALITY"], requiredGates: gates },
    })).toThrow(/cannot remove baseline required source CAPTURE/);
  });

  it("does not accept quality evidence from another source revision", () => {
    const { signed, publicKey } = signedEvidence({ sourceRevision: "abcdefabcdefabcdefabcdefabcdefabcdefabcd" });
    const result = certifySignedEvidenceForDelivery({ signedEvidence: signed, publicKey, sourceRevision: revision, tenantId: "tenant-a", projectId: "project-a" });
    expect(result.certified).toBe(false);
    expect(result.findings.join(" ")).toMatch(/exactly one verified QUALITY record/);
  });

  it("does not accept stale capture evidence from another source revision", () => {
    const { signed, publicKey } = signedEvidence({ captureRevision: "abcdefabcdefabcdefabcdefabcdefabcdefabcd" });
    const result = certifySignedEvidenceForDelivery({ signedEvidence: signed, publicKey, sourceRevision: revision, tenantId: "tenant-a", projectId: "project-a" });
    expect(result.certified).toBe(false);
    expect(result.findings.join(" ")).toMatch(/CAPTURE evidence is bound/);
  });

  it("rejects cross-project certification even with a valid signature", () => {
    const { signed, publicKey } = signedEvidence();
    const result = certifySignedEvidenceForDelivery({ signedEvidence: signed, publicKey, sourceRevision: revision, tenantId: "tenant-a", projectId: "project-b" });
    expect(result.certified).toBe(false);
    expect(result.findings.join(" ")).toMatch(/scope does not match/);
  });

  it("rejects a bundle signed by an untrusted key", () => {
    const { signed } = signedEvidence();
    const attacker = generateKeyPairSync("ed25519");
    expect(() => certifySignedEvidenceForDelivery({ signedEvidence: signed, publicKey: attacker.publicKey, sourceRevision: revision, tenantId: "tenant-a", projectId: "project-a" })).toThrow(/signature verification failed/);
  });
});
