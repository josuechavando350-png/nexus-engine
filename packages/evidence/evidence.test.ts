import { describe, expect, it } from "vitest";
import { createRun, createEvidence, type EnvironmentDescriptor, type WorkloadDefinition } from "../measurement/index";
import { createEvidenceBundle, createEvidenceRecord, EvidencePipelineError, recordFromBenchmark, recordFromEnvelope } from "./index";
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
  workloadId: workload.id,
  workloadVersion: workload.version,
  scope: workload.scope,
  startedAt: "2026-08-15T19:30:00.000Z",
  workload,
  environment
});

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

  it("marks a bundle complete only when every required source has verified measured evidence", () => {
    const benchmark = createEvidenceRecord({
      runId: run.runId,
      scope: run.scope,
      source: "BENCHMARK",
      sourceId: "bench-1",
      status: "MEASURED",
      samples: [{ name: "frame_time", unit: "ms", value: 12 }],
      capturedAt: "2026-08-15T19:31:00.000Z",
      integrity: "VERIFIED"
    });
    const capture = createEvidenceRecord({
      runId: run.runId,
      scope: run.scope,
      source: "CAPTURE",
      sourceId: "capture-1",
      status: "MEASURED",
      samples: [{ name: "paint_time", unit: "ms", value: 5 }],
      capturedAt: "2026-08-15T19:31:30.000Z",
      integrity: "VERIFIED"
    });
    expect(createEvidenceBundle(run, [benchmark], "2026-08-15T19:33:00.000Z", ["BENCHMARK", "CAPTURE"]).complete).toBe(false);
    expect(createEvidenceBundle(run, [capture, benchmark], "2026-08-15T19:33:00.000Z", ["BENCHMARK", "CAPTURE"]).complete).toBe(true);
  });

  it("rejects duplicate source identities", () => {
    const record = createEvidenceRecord({
      runId: run.runId,
      scope: run.scope,
      source: "RUNTIME",
      sourceId: "runtime-1",
      status: "MEASURED",
      samples: [{ name: "frame_time", unit: "ms", value: 14 }],
      capturedAt: "2026-08-15T19:31:00.000Z",
      integrity: "VERIFIED"
    });
    expect(() => createEvidenceBundle(run, [record, record], "2026-08-15T19:33:00.000Z")).toThrow("duplicate evidence source identity");
  });
});
