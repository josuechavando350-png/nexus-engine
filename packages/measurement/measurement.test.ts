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

  it("uses full SHA-256 deterministic identities", () => {
    expect(deterministicId("x", { a: 1 })).toMatch(/^x_[a-f0-9]{64}$/);
    expect(workloadDigest(workload)).toMatch(/^wrk_[a-f0-9]{64}$/);
    expect(environmentDigest(environment)).toMatch(/^env_[a-f0-9]{64}$/);
  });

  it("creates deterministic workload and environment identities", () => {
    expect(workloadDigest(workload)).toBe(workloadDigest({ ...workload, parameters: { preset: "cinematic", reducedMotion: false, durationMs: 1200 } }));
    expect(environmentDigest(environment)).toBe(environmentDigest({ ...environment }));
  });

  it("creates deterministic runs from workload, environment, scope and start time", () => {
    const input = {
      workload,
      environment,
      scope: workload.scope,
      startedAt: "2026-08-15T18:30:00.000Z"
    };
    const run = createRun(input);
    expect(run).toEqual(createRun(input));
    expect(run.runId).toMatch(/^run_[a-f0-9]{64}$/);
  });

  it("rejects non-canonical or non-UTC run timestamps", () => {
    for (const startedAt of ["2026-08-15 18:30:00", "2026-08-15T18:30:00Z", "2026-08-15T12:30:00.000-06:00", "not-a-date"]) {
      expect(() => createRun({ workload, environment, scope: workload.scope, startedAt })).toThrowError(MeasurementValidationError);
    }
  });

  it("rejects cross-scope runs", () => {
    expect(() => createRun({
      workload,
      environment,
      scope: { tenantId: "tenant-b", brandId: "brand-a" },
      startedAt: "2026-08-15T18:30:00.000Z"
    })).toThrowError(MeasurementValidationError);
  });

  it("requires finite metric values", () => {
    expect(() => createEvidence({ runId: "run_1", scope: workload.scope, status: "MEASURED", samples: [{ name: "frameTime", unit: "ms", value: Number.NaN }], capturedAt: "2026-08-15T18:31:00.000Z" })).toThrow("must be finite");
    expect(() => createEvidence({ runId: "run_1", scope: workload.scope, status: "MEASURED", samples: [{ name: "frameTime", unit: "ms", value: Number.POSITIVE_INFINITY }], capturedAt: "2026-08-15T18:31:00.000Z" })).toThrow("must be finite");
  });

  it("rejects non-canonical evidence timestamps", () => {
    expect(() => createEvidence({ runId: "run_1", scope: workload.scope, status: "MEASURED", samples: [{ name: "frameTime", unit: "ms", value: 8.4 }], capturedAt: "2026-08-15 18:31:00" })).toThrowError(MeasurementValidationError);
  });

  it("distinguishes measured from missing/unsupported/failed evidence", () => {
    const measured = createEvidence({ runId: "run_1", scope: workload.scope, status: "MEASURED", samples: [{ name: "frameTime", unit: "ms", value: 8.4 }], capturedAt: "2026-08-15T18:31:00.000Z" });
    expect(measured.status).toBe("MEASURED");
    expect(measured.evidenceId).toMatch(/^evd_[a-f0-9]{64}$/);
    for (const status of ["MISSING", "UNSUPPORTED", "FAILED"] as const) {
      const envelope = createEvidence({ runId: "run_1", scope: workload.scope, status, samples: [], reason: `${status.toLowerCase()} reason`, capturedAt: "2026-08-15T18:31:00.000Z" });
      expect(envelope.status).toBe(status);
    }
  });

  it("does not allow non-measured states to smuggle samples", () => {
    expect(() => createEvidence({ runId: "run_1", scope: workload.scope, status: "FAILED", samples: [{ name: "fake", unit: "ms", value: 1 }], reason: "capture failed", capturedAt: "2026-08-15T18:31:00.000Z" })).toThrow("cannot contain samples");
  });

  it("requires evidence to match both run identity and tenant/brand scope", () => {
    const run = createRun({ workload, environment, scope: workload.scope, startedAt: "2026-08-15T18:30:00.000Z" });
    const evidence = createEvidence({ runId: run.runId, scope: workload.scope, status: "MEASURED", samples: [{ name: "frameTime", unit: "ms", value: 7.9 }], capturedAt: "2026-08-15T18:31:00.000Z" });
    expect(() => assertEvidenceBelongsToRun(evidence, run)).not.toThrow();
    expect(() => assertEvidenceBelongsToRun({ ...evidence, scope: { tenantId: "tenant-a", brandId: "brand-b" } }, run)).toThrow("same run and scope");
  });
});
