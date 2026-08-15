import { describe, expect, it } from "vitest";
import {
  MeasurementValidationError,
  assertEvidenceBelongsToRun,
  canonicalJson,
  createEvidence,
  createRun,
  deterministicId,
  environmentDigest,
  workloadDigest,
  type EnvironmentDescriptor,
  type WorkloadDefinition
} from "./index";

const workload: WorkloadDefinition = {
  id: "hero-motion",
  version: "1.0.0",
  scope: { tenantId: "tenant-a", brandId: "brand-a" },
  name: "Hero motion workload",
  parameters: { durationMs: 1200, reducedMotion: false, preset: "cinematic" }
};

const environment: EnvironmentDescriptor = {
  os: "linux",
  architecture: "x64",
  runtime: "node",
  runtimeVersion: "24",
  deviceClass: "ci"
};

describe("measurement harness", () => {
  it("canonicalizes object key order deterministically", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
    expect(deterministicId("x", { b: 2, a: 1 })).toBe(deterministicId("x", { a: 1, b: 2 }));
  });

  it("creates deterministic workload and environment identities", () => {
    expect(workloadDigest(workload)).toBe(workloadDigest({ ...workload, parameters: { preset: "cinematic", reducedMotion: false, durationMs: 1200 } }));
    expect(environmentDigest(environment)).toBe(environmentDigest({ ...environment }));
  });

  it("creates deterministic runs from workload, environment, scope and start time", () => {
    const input = {
      workload,
      environment,
      workloadId: workload.id,
      workloadVersion: workload.version,
      scope: workload.scope,
      startedAt: "2026-08-15T18:30:00.000Z"
    };
    expect(createRun(input)).toEqual(createRun(input));
  });

  it("rejects cross-scope runs", () => {
    expect(() => createRun({
      workload,
      environment,
      workloadId: workload.id,
      workloadVersion: workload.version,
      scope: { tenantId: "tenant-b", brandId: "brand-a" },
      startedAt: "2026-08-15T18:30:00.000Z"
    })).toThrowError(MeasurementValidationError);
  });

  it("requires finite metric values", () => {
    expect(() => createEvidence({
      runId: "run_1",
      scope: workload.scope,
      status: "MEASURED",
      samples: [{ name: "frameTime", unit: "ms", value: Number.NaN }],
      capturedAt: "2026-08-15T18:31:00.000Z"
    })).toThrow("must be finite");
    expect(() => createEvidence({
      runId: "run_1",
      scope: workload.scope,
      status: "MEASURED",
      samples: [{ name: "frameTime", unit: "ms", value: Number.POSITIVE_INFINITY }],
      capturedAt: "2026-08-15T18:31:00.000Z"
    })).toThrow("must be finite");
  });

  it("distinguishes measured from missing/unsupported/failed evidence", () => {
    const measured = createEvidence({
      runId: "run_1",
      scope: workload.scope,
      status: "MEASURED",
      samples: [{ name: "frameTime", unit: "ms", value: 8.4 }],
      capturedAt: "2026-08-15T18:31:00.000Z"
    });
    expect(measured.status).toBe("MEASURED");
    for (const status of ["MISSING", "UNSUPPORTED", "FAILED"] as const) {
      const envelope = createEvidence({
        runId: "run_1",
        scope: workload.scope,
        status,
        samples: [],
        reason: `${status.toLowerCase()} reason`,
        capturedAt: "2026-08-15T18:31:00.000Z"
      });
      expect(envelope.status).toBe(status);
    }
  });

  it("does not allow non-measured states to smuggle samples", () => {
    expect(() => createEvidence({
      runId: "run_1",
      scope: workload.scope,
      status: "FAILED",
      samples: [{ name: "fake", unit: "ms", value: 1 }],
      reason: "capture failed",
      capturedAt: "2026-08-15T18:31:00.000Z"
    })).toThrow("cannot contain samples");
  });

  it("requires evidence to match both run identity and tenant/brand scope", () => {
    const run = createRun({
      workload,
      environment,
      workloadId: workload.id,
      workloadVersion: workload.version,
      scope: workload.scope,
      startedAt: "2026-08-15T18:30:00.000Z"
    });
    const evidence = createEvidence({
      runId: run.runId,
      scope: workload.scope,
      status: "MEASURED",
      samples: [{ name: "frameTime", unit: "ms", value: 7.9 }],
      capturedAt: "2026-08-15T18:31:00.000Z"
    });
    expect(() => assertEvidenceBelongsToRun(evidence, run)).not.toThrow();
    expect(() => assertEvidenceBelongsToRun({ ...evidence, scope: { tenantId: "tenant-a", brandId: "brand-b" } }, run)).toThrow("same run and scope");
  });
});
