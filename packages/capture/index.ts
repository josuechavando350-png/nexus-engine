import type { EvidenceEnvelope, MeasurementRun, MeasurementScope, MetricSample } from "../measurement/index";
import { createEvidence, deterministicId } from "../measurement/index";

export type CaptureCapability = "SCREENSHOT" | "PERFORMANCE" | "RUNTIME_TELEMETRY";
export type CaptureOutcome = "CAPTURED" | "UNSUPPORTED" | "FAILED";

export interface CaptureRequest {
  run: MeasurementRun;
  scope: MeasurementScope;
  targetId: string;
  capabilities: readonly CaptureCapability[];
  metadata?: Readonly<Record<string, string>>;
}

export interface CaptureArtifact {
  artifactId: string;
  runId: string;
  scope: MeasurementScope;
  capability: CaptureCapability;
  mediaType: string;
  digest: string;
  byteLength: number;
  capturedAt: string;
}

export interface CaptureResult {
  requestId: string;
  outcome: CaptureOutcome;
  artifacts: readonly CaptureArtifact[];
  samples: readonly MetricSample[];
  reason?: string;
}

export interface BrowserDeviceCapturePort {
  readonly adapterId: string;
  readonly adapterVersion: string;
  capture(request: CaptureRequest): Promise<CaptureResult>;
}

export class CaptureValidationError extends Error {
  constructor(public readonly code: "INVALID_SCOPE" | "SCOPE_MISMATCH" | "INVALID_REQUEST" | "INVALID_RESULT" | "NON_FINITE_VALUE", message: string) {
    super(message);
    this.name = "CaptureValidationError";
  }
}

function nonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new CaptureValidationError("INVALID_REQUEST", `${field} must be non-empty`);
}

function assertScope(scope: MeasurementScope): void {
  if (!scope.tenantId.trim() || !scope.brandId.trim()) throw new CaptureValidationError("INVALID_SCOPE", "tenantId and brandId are required");
}

export function captureRequestId(request: CaptureRequest): string {
  validateCaptureRequest(request);
  return deterministicId("capreq", {
    runId: request.run.runId,
    scope: request.scope,
    targetId: request.targetId,
    capabilities: [...request.capabilities].sort(),
    metadata: request.metadata ?? {}
  });
}

export function validateCaptureRequest(request: CaptureRequest): void {
  assertScope(request.scope);
  nonEmpty(request.targetId, "targetId");
  if (request.scope.tenantId !== request.run.scope.tenantId || request.scope.brandId !== request.run.scope.brandId) {
    throw new CaptureValidationError("SCOPE_MISMATCH", "capture request scope must match run scope");
  }
  if (request.capabilities.length === 0) throw new CaptureValidationError("INVALID_REQUEST", "at least one capture capability is required");
  if (new Set(request.capabilities).size !== request.capabilities.length) throw new CaptureValidationError("INVALID_REQUEST", "capture capabilities must be unique");
}

export function createCaptureArtifact(input: Omit<CaptureArtifact, "artifactId">): CaptureArtifact {
  assertScope(input.scope);
  nonEmpty(input.runId, "runId");
  nonEmpty(input.mediaType, "mediaType");
  nonEmpty(input.digest, "digest");
  nonEmpty(input.capturedAt, "capturedAt");
  if (!Number.isInteger(input.byteLength) || input.byteLength < 0) throw new CaptureValidationError("NON_FINITE_VALUE", "byteLength must be a non-negative integer");
  return {
    artifactId: deterministicId("artifact", input),
    ...input
  };
}

export function validateCaptureResult(request: CaptureRequest, result: CaptureResult): void {
  validateCaptureRequest(request);
  const expectedRequestId = captureRequestId(request);
  if (result.requestId !== expectedRequestId) throw new CaptureValidationError("INVALID_RESULT", "capture result requestId does not match request");
  if (result.outcome === "CAPTURED" && result.artifacts.length === 0 && result.samples.length === 0) {
    throw new CaptureValidationError("INVALID_RESULT", "CAPTURED result requires at least one artifact or sample");
  }
  if (result.outcome !== "CAPTURED" && (result.artifacts.length > 0 || result.samples.length > 0)) {
    throw new CaptureValidationError("INVALID_RESULT", `${result.outcome} result cannot contain captured evidence`);
  }
  if (result.outcome !== "CAPTURED" && !result.reason?.trim()) {
    throw new CaptureValidationError("INVALID_RESULT", `${result.outcome} result requires a reason`);
  }
  for (const artifact of result.artifacts) {
    if (artifact.runId !== request.run.runId || artifact.scope.tenantId !== request.scope.tenantId || artifact.scope.brandId !== request.scope.brandId) {
      throw new CaptureValidationError("SCOPE_MISMATCH", "capture artifact must belong to request run and scope");
    }
    if (!request.capabilities.includes(artifact.capability)) throw new CaptureValidationError("INVALID_RESULT", "artifact capability was not requested");
  }
  for (const sample of result.samples) {
    nonEmpty(sample.name, "sample.name");
    nonEmpty(sample.unit, "sample.unit");
    if (!Number.isFinite(sample.value)) throw new CaptureValidationError("NON_FINITE_VALUE", `${sample.name} must be finite`);
  }
}

export function captureResultToEvidence(request: CaptureRequest, result: CaptureResult, capturedAt: string): EvidenceEnvelope {
  validateCaptureResult(request, result);
  const status = result.outcome === "CAPTURED" ? "MEASURED" : result.outcome === "UNSUPPORTED" ? "UNSUPPORTED" : "FAILED";
  return createEvidence({
    runId: request.run.runId,
    scope: request.scope,
    status,
    samples: result.samples,
    capturedAt,
    reason: result.outcome === "CAPTURED" ? undefined : result.reason
  });
}
