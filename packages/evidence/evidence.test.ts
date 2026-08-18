import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createRun, createEvidence, type EnvironmentDescriptor, type WorkloadDefinition } from "../measurement/index";
import { createEvidenceBundle, createEvidenceRecord, EvidencePipelineError, recordFromBenchmark, recordFromEnvelope, signEvidenceBundle, verifySignedEvidenceBundle } from "./index";
import type { BenchmarkExecution } from "../benchmark/index";

const workload: WorkloadDefinition = {
  id: "evidence-workload",
  version: "1.0.0",
  scope: { tenantId: "tenant-a", brandId: "brand-a" },
  name: "Evidence workload",
  parameters: { durationMs: 1000 }
};

const environment: EnvironmentDescriptor = {
  os: "linux",
  architecture: "x64",
  runtime: "node",
  runtimeVersion: "24",
  deviceClass: "ci"
};

const run = createRun({
  scope: workload.scope,
  startedAt: "2026-08-15T19:30:00.000Z",
  workload,
  environment
});

function measuredRecord(source: "CAPTURE" | "BENCHMARK" | "RUNTIME" | "QUALITY", sourceId: string, value = 12) {
  return createEvidenceRecord({
    runId: run.runId,
    scope: run.scope,
    source,
    sourceId,
    status: "MEASURED",
    samples: [{ name: "frame_time", unit: "ms", value }],
    capturedAt: "2026-08-15T19:31:00.000Z",
    integrity: "VERIFIED"
  });
}

describe("evidence pipeline", () => {
  it("creates deterministic evidence records", () => {
    const input = {
      runId: run.runId,
      scope: run.scope,
      source: "RUNTIME" as const,
      sourceId: "runtime-1",
      status: "MEASURED" as const,
      samples: [{ name: "frame_time", unit: "ms", value: 16.2 }],
      capturedAt: "2026-08-15T19:31:00.000Z",
      integrity: "VERIFIED" as const
    };
    expect(createEvidenceRecord(input)).toEqual(createEvidenceRecord(input));
  });

  it("rejects non-canonical timestamps", () => {
    expect(() => createEvidenceRecord({
      runId: run.runId,
      scope: run.scope,
      source: "RUNTIME",
      sourceId: "runtime-1",
      status: "MEASURED",
      samples: [{ name: "frame_time", unit: "ms", value: 16.2 }],
      capturedAt: "2026-08-15 19:31:00",
      integrity: "VERIFIED"
    })).toThrowError(EvidencePipelineError);
  });

  it("rejects non-finite values", () => {
    expect(() => createEvidenceRecord({
      runId: run.runId,
      scope: run.scope,
      source: "RUNTIME",
      sourceId: "runtime-1",
      status: "MEASURED",
      samples: [{ name: "frame_time", unit: "ms", value: Number.NaN }],
      capturedAt: "2026-08-15T19:31:00.000Z",
      integrity: "VERIFIED"
    })).toThrow("must be finite");
  });

  it("converts measurement envelopes into records without losing status", () => {
    const envelope = createEvidence({
      runId: run.runId,
      scope: run.scope,
      status: "UNSUPPORTED",
      samples: [],
      reason: "gpu timing unavailable",
      capturedAt: "2026-08-15T19:31:00.000Z"
    });
    const record = recordFromEnvelope(envelope, "CAPTURE", "capture-1", "UNVERIFIED");
    expect(record.status).toBe("UNSUPPORTED");
    expect(record.reason).toContain("gpu timing");
  });

  it("creates verified benchmark evidence only for the matching run", () => {
    const execution: BenchmarkExecution = {
      executionId: "bench_1",
      runId: run.runId,
      policy: { warmupRuns: 1, sampleRuns: 2, aggregation: "MEAN", rejectNonFinite: true },
      rawSamples: [],
      aggregates: [{ name: "frame_time", unit: "ms", value: 12 }]
    };
    const record = recordFromBenchmark(run, execution, "2026-08-15T19:32:00.000Z");
    expect(record.integrity).toBe("VERIFIED");
    expect(record.source).toBe("BENCHMARK");
    expect(() => recordFromBenchmark(run, { ...execution, runId: "other-run" }, "2026-08-15T19:32:00.000Z")).toThrow("must belong to run");
  });

  it("rejects cross-tenant evidence in bundles", () => {
    const record = createEvidenceRecord({
      runId: run.runId,
      scope: { tenantId: "tenant-b", brandId: "brand-a" },
      source: "RUNTIME",
      sourceId: "runtime-1",
      status: "MEASURED",
      samples: [{ name: "frame_time", unit: "ms", value: 14 }],
      capturedAt: "2026-08-15T19:31:00.000Z",
      integrity: "VERIFIED"
    });
    expect(() => createEvidenceBundle(run, [record], "2026-08-15T19:33:00.000Z")).toThrow("must match run scope");
  });

  it("marks a bundle complete only when every required source has verified measured evidence and persists canonical requirements", () => {
    const benchmark = measuredRecord("BENCHMARK", "bench-1");
    const capture = measuredRecord("CAPTURE", "capture-1");
    expect(createEvidenceBundle(run, [benchmark], "2026-08-15T19:33:00.000Z", ["CAPTURE", "BENCHMARK"]).complete).toBe(false);
    const bundle = createEvidenceBundle(run, [capture, benchmark], "2026-08-15T19:33:00.000Z", ["CAPTURE", "BENCHMARK", "CAPTURE"]);
    expect(bundle.complete).toBe(true);
    expect(bundle.requiredSources).toEqual(["BENCHMARK", "CAPTURE"]);
  });

  it("rejects duplicate source identities", () => {
    const record = measuredRecord("RUNTIME", "runtime-1", 14);
    expect(() => createEvidenceBundle(run, [record, record], "2026-08-15T19:33:00.000Z")).toThrow("duplicate evidence source identity");
  });

  it("signs and verifies a canonical evidence bundle with Ed25519", () => {
    const capture = measuredRecord("CAPTURE", "capture-1");
    const quality = measuredRecord("QUALITY", "quality-1");
    const bundle = createEvidenceBundle(run, [quality, capture], "2026-08-15T19:33:00.000Z", ["QUALITY", "CAPTURE"]);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signed = signEvidenceBundle(bundle, "ci-fixture-key", privateKey);

    expect(signed.algorithm).toBe("Ed25519");
    expect(signed.payloadDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(signed.signature.length).toBeGreaterThan(40);
    expect(verifySignedEvidenceBundle(signed, publicKey)).toBe(true);
  });

  it("rejects verification with the wrong public key", () => {
    const bundle = createEvidenceBundle(run, [measuredRecord("QUALITY", "quality-1")], "2026-08-15T19:33:00.000Z", ["QUALITY"]);
    const signer = generateKeyPairSync("ed25519");
    const attacker = generateKeyPairSync("ed25519");
    const signed = signEvidenceBundle(bundle, "fixture-key", signer.privateKey);
    expect(() => verifySignedEvidenceBundle(signed, attacker.publicKey)).toThrow("signature verification failed");
  });

  it("rejects a signed bundle when evidence samples are tampered after signing", () => {
    const bundle = createEvidenceBundle(run, [measuredRecord("QUALITY", "quality-1")], "2026-08-15T19:33:00.000Z", ["QUALITY"]);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signed = signEvidenceBundle(bundle, "fixture-key", privateKey);
    const tamperedRecord = { ...bundle.records[0]!, samples: [{ name: "frame_time", unit: "ms", value: 1 }] };
    const tampered = { ...signed, bundle: { ...bundle, records: [tamperedRecord] } };
    expect(() => verifySignedEvidenceBundle(tampered, publicKey)).toThrow("provenance verification");
  });

  it("rejects tampering with completeness requirements or bundle identity", () => {
    const bundle = createEvidenceBundle(run, [measuredRecord("QUALITY", "quality-1")], "2026-08-15T19:33:00.000Z", ["QUALITY"]);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signed = signEvidenceBundle(bundle, "fixture-key", privateKey);

    expect(() => verifySignedEvidenceBundle({ ...signed, bundle: { ...bundle, complete: false } }, publicKey)).toThrow("completeness flag");
    expect(() => verifySignedEvidenceBundle({ ...signed, bundle: { ...bundle, requiredSources: [] } }, publicKey)).toThrow("bundleId failed deterministic verification");
    expect(() => verifySignedEvidenceBundle({ ...signed, bundle: { ...bundle, bundleId: "bundle_tampered" } }, publicKey)).toThrow("bundleId failed deterministic verification");
  });
});
