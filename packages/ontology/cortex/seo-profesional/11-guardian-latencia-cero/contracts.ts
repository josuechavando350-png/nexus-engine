import {
  normalizeOperatorOrigin,
  type EdgeCircuitPhase,
  type EdgePlatform,
} from "../10-candado-invisible/index.js";

export type EdgeRuntimeGuardOutcome =
  | "PRIMARY_SUCCESS"
  | "PRIMARY_TRANSIENT_FALLBACK"
  | "PRIMARY_TIMEOUT_FALLBACK"
  | "PRIMARY_EXCEPTION_FALLBACK"
  | "CIRCUIT_OPEN_FALLBACK"
  | "FALLBACK_FAILURE"
  | "FALLBACK_TIMEOUT"
  | "BULKHEAD_REJECTED"
  | "PARENT_ABORTED";

export type EdgeRuntimeStateBackend = "HEALTHY" | "DEGRADED";

export interface EdgeRuntimeGuardPolicyInput {
  readonly policyId: string;
  readonly operatorWebsiteOrigin: string;
  readonly platform: EdgePlatform;
  readonly primaryTimeoutMs: number;
  readonly fallbackTimeoutMs: number;
  readonly stateOperationTimeoutMs: number;
  readonly failureThreshold: number;
  readonly openCircuitMs: number;
  readonly halfOpenProbeLeaseMs?: number;
  readonly maxConcurrentExecutions: number;
  readonly retryAfterSeconds?: number;
}

export interface EdgeRuntimeGuardPolicy extends Required<EdgeRuntimeGuardPolicyInput> {
  readonly version: "seo11-edge-runtime-guard-v1";
}

export interface EdgeRuntimeGuardIdentity {
  readonly strategy: 11;
  readonly provider: "EDGE_RUNTIME_GLOBAL_GUARD";
  readonly upstreamProvider: "PORTABLE_EDGE_RESILIENCE";
  readonly platform: EdgePlatform;
  readonly operatorWebsiteOrigin: string;
}

export interface EdgeRuntimeGuardTelemetryEvent {
  readonly strategy: 11;
  readonly operationKey: string;
  readonly platform: EdgePlatform;
  readonly outcome: EdgeRuntimeGuardOutcome;
  readonly stateBackend: EdgeRuntimeStateBackend;
  readonly circuitPhase: EdgeCircuitPhase | "UNKNOWN";
  readonly primaryStatus: number | null;
  readonly fallbackStatus: number | null;
  readonly durationMs: number;
}

export type EdgeRuntimeHandler = (request: Request, signal: AbortSignal) => Promise<Response>;
export type EdgeRuntimeGuardTelemetrySink = (event: EdgeRuntimeGuardTelemetryEvent) => void;

export class EdgeRuntimeGuardError extends Error {
  constructor(
    public readonly code: "INVALID_CONFIG" | "INVALID_INPUT" | "IDENTITY_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "EdgeRuntimeGuardError";
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/u;

function integer(value: number, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new EdgeRuntimeGuardError("INVALID_CONFIG", `${field} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function assertOperationKey(value: string): string {
  const normalized = value?.trim?.() ?? "";
  if (!ID.test(normalized)) throw new EdgeRuntimeGuardError("INVALID_INPUT", "operationKey is malformed");
  return normalized;
}

export function createEdgeRuntimeGuardPolicy(input: EdgeRuntimeGuardPolicyInput): EdgeRuntimeGuardPolicy {
  if (!input || typeof input !== "object" || !ID.test(input.policyId?.trim?.() ?? "")) {
    throw new EdgeRuntimeGuardError("INVALID_CONFIG", "edge runtime guard policyId is malformed");
  }
  if (input.platform !== "CLOUDFLARE" && input.platform !== "VERCEL") {
    throw new EdgeRuntimeGuardError("INVALID_CONFIG", "edge runtime guard platform must be CLOUDFLARE or VERCEL");
  }
  const primaryTimeoutMs = integer(input.primaryTimeoutMs, "primaryTimeoutMs", 10, 30_000);
  const fallbackTimeoutMs = integer(input.fallbackTimeoutMs, "fallbackTimeoutMs", 10, 10_000);
  const stateOperationTimeoutMs = integer(input.stateOperationTimeoutMs, "stateOperationTimeoutMs", 10, 2_000);
  const failureThreshold = integer(input.failureThreshold, "failureThreshold", 1, 20);
  const openCircuitMs = integer(input.openCircuitMs, "openCircuitMs", 1_000, 10 * 60_000);
  const halfOpenProbeLeaseMs = integer(input.halfOpenProbeLeaseMs ?? primaryTimeoutMs + 1_000, "halfOpenProbeLeaseMs", primaryTimeoutMs, 60_000);
  const maxConcurrentExecutions = integer(input.maxConcurrentExecutions, "maxConcurrentExecutions", 1, 1_000);
  const retryAfterSeconds = integer(input.retryAfterSeconds ?? Math.max(1, Math.ceil(openCircuitMs / 1_000)), "retryAfterSeconds", 1, 600);
  return Object.freeze({
    policyId: input.policyId.trim(),
    operatorWebsiteOrigin: normalizeOperatorOrigin(input.operatorWebsiteOrigin),
    platform: input.platform,
    primaryTimeoutMs,
    fallbackTimeoutMs,
    stateOperationTimeoutMs,
    failureThreshold,
    openCircuitMs,
    halfOpenProbeLeaseMs,
    maxConcurrentExecutions,
    retryAfterSeconds,
    version: "seo11-edge-runtime-guard-v1" as const,
  });
}
