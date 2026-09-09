export type EdgePlatform = "CLOUDFLARE" | "VERCEL";
export type EdgeCacheMode = "PUBLIC_RESILIENT" | "PRIVATE_NO_STORE" | "BYPASS_UNCACHEABLE";
export type EdgeResilienceOutcome =
  | "UPSTREAM_SUCCESS"
  | "UPSTREAM_FAILURE"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_EXCEPTION"
  | "CIRCUIT_OPEN"
  | "BULKHEAD_REJECTED"
  | "STATE_DEGRADED";

export type EdgeCircuitPhase = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface EdgeCircuitState {
  readonly phase: EdgeCircuitPhase;
  readonly consecutiveFailures: number;
  readonly openedAt: number | null;
  readonly retryAt: number | null;
  readonly probeUntil: number | null;
  readonly updatedAt: number;
}

export interface EdgeCircuitDecision {
  readonly allowed: boolean;
  readonly state: EdgeCircuitState;
}

export interface EdgeCircuitFailurePolicy {
  readonly failureThreshold: number;
  readonly openCircuitMs: number;
}

export interface EdgeCircuitStatePort {
  beforeRequest(key: string, nowMs: number, halfOpenProbeLeaseMs: number): Promise<EdgeCircuitDecision>;
  recordSuccess(key: string, nowMs: number): Promise<EdgeCircuitState>;
  recordFailure(key: string, nowMs: number, policy: EdgeCircuitFailurePolicy): Promise<EdgeCircuitState>;
}

export interface EdgeResiliencePolicyInput {
  readonly policyId: string;
  readonly operatorWebsiteOrigin: string;
  readonly platform: EdgePlatform;
  readonly timeoutMs: number;
  readonly failureThreshold: number;
  readonly openCircuitMs: number;
  readonly halfOpenProbeLeaseMs?: number;
  readonly maxConcurrentRequests: number;
  readonly browserMaxAgeSeconds: number;
  readonly edgeMaxAgeSeconds: number;
  readonly staleWhileRevalidateSeconds: number;
  readonly staleIfErrorSeconds: number;
  readonly retryAfterSeconds?: number;
}

export interface EdgeResiliencePolicy extends Required<EdgeResiliencePolicyInput> {
  readonly version: "seo10-edge-resilience-v1";
}

export interface EdgeResilienceIdentity {
  readonly strategy: 10;
  readonly provider: "PORTABLE_EDGE_RESILIENCE";
  readonly platform: EdgePlatform;
  readonly operatorWebsiteOrigin: string;
}

export interface EdgeResilienceTelemetryEvent {
  readonly strategy: 10;
  readonly routeKey: string;
  readonly platform: EdgePlatform;
  readonly outcome: EdgeResilienceOutcome;
  readonly cacheMode: EdgeCacheMode;
  readonly circuitPhase: EdgeCircuitPhase | "UNKNOWN";
  readonly status: number | null;
  readonly durationMs: number;
}

export type EdgeUpstreamHandler = (request: Request, signal: AbortSignal) => Promise<Response>;

export class EdgeResilienceError extends Error {
  constructor(
    public readonly code: "INVALID_CONFIG" | "INVALID_INPUT" | "IDENTITY_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "EdgeResilienceError";
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/u;

function integer(value: number, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new EdgeResilienceError("INVALID_CONFIG", `${field} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function normalizeOperatorOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EdgeResilienceError("INVALID_CONFIG", "operatorWebsiteOrigin must be an absolute URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.port) {
    throw new EdgeResilienceError("INVALID_CONFIG", "operatorWebsiteOrigin must be a bare HTTPS origin");
  }
  return url.origin;
}

export function assertRouteKey(value: string): string {
  const normalized = value.trim();
  if (!ID.test(normalized)) throw new EdgeResilienceError("INVALID_INPUT", "routeKey is malformed");
  return normalized;
}

export function createEdgeResiliencePolicy(input: EdgeResiliencePolicyInput): EdgeResiliencePolicy {
  if (!input || typeof input !== "object" || !ID.test(input.policyId?.trim?.() ?? "")) {
    throw new EdgeResilienceError("INVALID_CONFIG", "edge resilience policyId is malformed");
  }
  if (input.platform !== "CLOUDFLARE" && input.platform !== "VERCEL") {
    throw new EdgeResilienceError("INVALID_CONFIG", "edge resilience platform must be CLOUDFLARE or VERCEL");
  }
  const timeoutMs = integer(input.timeoutMs, "timeoutMs", 100, 30_000);
  const failureThreshold = integer(input.failureThreshold, "failureThreshold", 1, 20);
  const openCircuitMs = integer(input.openCircuitMs, "openCircuitMs", 1_000, 10 * 60_000);
  const halfOpenProbeLeaseMs = integer(input.halfOpenProbeLeaseMs ?? timeoutMs + 1_000, "halfOpenProbeLeaseMs", timeoutMs, 60_000);
  const maxConcurrentRequests = integer(input.maxConcurrentRequests, "maxConcurrentRequests", 1, 1_000);
  const browserMaxAgeSeconds = integer(input.browserMaxAgeSeconds, "browserMaxAgeSeconds", 0, 86_400);
  const edgeMaxAgeSeconds = integer(input.edgeMaxAgeSeconds, "edgeMaxAgeSeconds", 1, 7 * 86_400);
  const staleWhileRevalidateSeconds = integer(input.staleWhileRevalidateSeconds, "staleWhileRevalidateSeconds", 0, 30 * 86_400);
  const staleIfErrorSeconds = integer(input.staleIfErrorSeconds, "staleIfErrorSeconds", 0, 30 * 86_400);
  const retryAfterSeconds = integer(input.retryAfterSeconds ?? Math.max(1, Math.ceil(openCircuitMs / 1_000)), "retryAfterSeconds", 1, 600);
  return Object.freeze({
    policyId: input.policyId.trim(),
    operatorWebsiteOrigin: normalizeOperatorOrigin(input.operatorWebsiteOrigin),
    platform: input.platform,
    timeoutMs,
    failureThreshold,
    openCircuitMs,
    halfOpenProbeLeaseMs,
    maxConcurrentRequests,
    browserMaxAgeSeconds,
    edgeMaxAgeSeconds,
    staleWhileRevalidateSeconds,
    staleIfErrorSeconds,
    retryAfterSeconds,
    version: "seo10-edge-resilience-v1" as const,
  });
}
