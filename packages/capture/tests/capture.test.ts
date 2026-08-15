import { describe, expect, it } from "vitest";
import { createRun, type EnvironmentDescriptor, type WorkloadDefinition } from "@nexus/measurement";
import { CaptureValidationError, captureRequestId, captureResultToEvidence, createCaptureArtifact, validateCaptureResult, type CaptureRequest } from "../index";

const workload: WorkloadDefinition = {
  id: "landing-hero",
  version: "1",
  scope: { tenantId: "tenant-a", brandId: "brand-a" },
  name: "Landing hero",
  parameters: { durationMs: 1000 }
};

const environment: EnvironmentDescriptor = {
  os: "test-os",
  architecture: "x64",
  runtime: "test-runtime",
  runtimeVersion: "1",
  deviceClass: "desktop"
};

const run = createRun({
  workloadId: workload.id,
  workloadVersion: workload.version,
  scope: workload.scope,
  startedAt: "2026-08-15T00:00:00.000Z",
  workload,
  environment
});

function request(): CaptureRequest {
  return {
    run,
    scope: workload.scope,
    targetId: "hero",
    capabilities: ["SCREENSHOT", "PERFORMANCE"],
    metadata: { viewport: "1440x900" }
  };
}

describe("BrowserDeviceCapturePort contracts", () => {
  it("creates deterministic request identities independent of capability order", () => {
    const a = request();
    const b = { ...request(), capabilities: ["PERFORMANCE", "SCREENSHOT"] as const };
    expect(captureRequestId(a)).toBe(captureRequestId(b));
  });

  it("rejects cross-scope requests", () => {
    expect(() => captureRequestId({ ...request(), scope: { tenantId: "tenant-b", brandId: "brand-a" } })).toThrowError(CaptureValidationError);
  });

  it("creates deterministic artifact identities", () => {
    const input = {
      runId: run.runId,
      scope: workload.scope,
      capability: "SCREENSHOT" as const,
      mediaType: "image/png",
      digest: "sha256:abc",
      byteLength: 128,
      capturedAt: "2026-08-15T00:00:01.000Z"
    };
    expect(createCaptureArtifact(input).artifactId).toBe(createCaptureArtifact(input).artifactId);
  });

  it("rejects evidence from another scope", () => {
    const req = request();
    const artifact = createCaptureArtifact({
      runId: run.runId,
      scope: { tenantId: "tenant-b", brandId: "brand-a" },
      capability: "SCREENSHOT",
      mediaType: "image/png",
      digest: "sha256:abc",
      byteLength: 128,
      capturedAt: "2026-08-15T00:00:01.000Z"
    });
    expect(() => validateCaptureResult(req, { requestId: captureRequestId(req), outcome: "CAPTURED", artifacts: [artifact], samples: [] })).toThrowError(CaptureValidationError);
  });

  it("rejects unsupported results that pretend to contain evidence", () => {
    const req = request();
    expect(() => validateCaptureResult(req, {
      requestId: captureRequestId(req),
      outcome: "UNSUPPORTED",
      artifacts: [],
      samples: [{ name: "frame_time", unit: "ms", value: 16 }],
      reason: "not available"
    })).toThrowError(CaptureValidationError);
  });

  it("rejects non-finite samples", () => {
    const req = request();
    expect(() => validateCaptureResult(req, {
      requestId: captureRequestId(req),
      outcome: "CAPTURED",
      artifacts: [],
      samples: [{ name: "frame_time", unit: "ms", value: Number.NaN }]
    })).toThrowError(CaptureValidationError);
  });

  it("converts successful capture samples into measured evidence", () => {
    const req = request();
    const evidence = captureResultToEvidence(req, {
      requestId: captureRequestId(req),
      outcome: "CAPTURED",
      artifacts: [],
      samples: [{ name: "frame_time", unit: "ms", value: 16.5 }]
    }, "2026-08-15T00:00:02.000Z");
    expect(evidence.status).toBe("MEASURED");
    expect(evidence.runId).toBe(run.runId);
    expect(evidence.scope).toEqual(workload.scope);
  });

  it("converts unsupported capture into explicit unsupported evidence", () => {
    const req = request();
    const evidence = captureResultToEvidence(req, {
      requestId: captureRequestId(req),
      outcome: "UNSUPPORTED",
      artifacts: [],
      samples: [],
      reason: "adapter cannot capture GPU timing"
    }, "2026-08-15T00:00:02.000Z");
    expect(evidence.status).toBe("UNSUPPORTED");
    expect(evidence.reason).toContain("GPU timing");
  });
});
