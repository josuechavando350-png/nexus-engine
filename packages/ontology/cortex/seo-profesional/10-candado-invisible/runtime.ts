import {
  applyEdgeResilienceCachePolicy,
  applyEdgeResilienceFailureCachePolicy,
  createEdgeUnavailableResponse,
} from "./cache-policy.js";
import {
  EdgeResilienceError,
  assertRouteKey,
  createEdgeResiliencePolicy,
  type EdgeCacheMode,
  type EdgeCircuitDecision,
  type EdgeCircuitState,
  type EdgeCircuitStatePort,
  type EdgeResilienceIdentity,
  type EdgeResilienceOutcome,
  type EdgeResiliencePolicy,
  type EdgeResiliencePolicyInput,
  type EdgeResilienceTelemetryEvent,
  type EdgeUpstreamHandler,
} from "./contracts.js";

class UpstreamTimeoutError extends Error {
  constructor() {
    super("upstream timeout");
    this.name = "UpstreamTimeoutError";
  }
}

function transientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function responsePhase(state: EdgeCircuitState | null): EdgeCircuitState["phase"] | "UNKNOWN" {
  return state?.phase ?? "UNKNOWN";
}

export class PortableEdgeResilienceRuntime {
  readonly policy: EdgeResiliencePolicy;
  private readonly state: EdgeCircuitStatePort;
  private readonly now: () => number;
  private readonly onTelemetry?: (event: EdgeResilienceTelemetryEvent) => void;
  private readonly onTelemetryError?: (error: unknown, event: EdgeResilienceTelemetryEvent) => void;
  private inFlight = 0;

  constructor(input: {
    readonly policy: EdgeResiliencePolicyInput;
    readonly state: EdgeCircuitStatePort;
    readonly now?: () => number;
    readonly onTelemetry?: (event: EdgeResilienceTelemetryEvent) => void;
    readonly onTelemetryError?: (error: unknown, event: EdgeResilienceTelemetryEvent) => void;
  }) {
    if (!input || typeof input !== "object" || !input.state || typeof input.state.beforeRequest !== "function" || typeof input.state.recordSuccess !== "function" || typeof input.state.recordFailure !== "function") {
      throw new EdgeResilienceError("INVALID_CONFIG", "edge resilience requires an atomic circuit state port");
    }
    this.policy = createEdgeResiliencePolicy(input.policy);
    this.state = input.state;
    this.now = input.now ?? Date.now;
    this.onTelemetry = input.onTelemetry;
    this.onTelemetryError = input.onTelemetryError;
  }

  identity(): EdgeResilienceIdentity {
    return Object.freeze({
      strategy: 10 as const,
      provider: "PORTABLE_EDGE_RESILIENCE" as const,
      platform: this.policy.platform,
      operatorWebsiteOrigin: this.policy.operatorWebsiteOrigin,
    });
  }

  private time(): number {
    const value = this.now();
    if (!Number.isFinite(value) || value < 0) throw new EdgeResilienceError("INVALID_CONFIG", "edge resilience clock is invalid");
    return value;
  }

  private emit(
    routeKey: string,
    startedAt: number,
    outcome: EdgeResilienceOutcome,
    cacheMode: EdgeCacheMode,
    circuitState: EdgeCircuitState | null,
    status: number | null,
  ): void {
    if (!this.onTelemetry) return;
    const endedAt = this.time();
    const event = Object.freeze({
      strategy: 10 as const,
      routeKey,
      platform: this.policy.platform,
      outcome,
      cacheMode,
      circuitPhase: responsePhase(circuitState),
      status,
      durationMs: Math.max(0, endedAt - startedAt),
    });
    try {
      this.onTelemetry(event);
    } catch (error) {
      try {
        this.onTelemetryError?.(error, event);
      } catch {
        // Telemetry must never change request semantics.
      }
    }
  }

  private async beforeRequest(key: string, routeKey: string, startedAt: number): Promise<EdgeCircuitDecision | null> {
    try {
      return await this.state.beforeRequest(key, this.time(), this.policy.halfOpenProbeLeaseMs);
    } catch {
      // A resilience-state outage must not become a new site-wide outage.
      this.emit(routeKey, startedAt, "STATE_DEGRADED", "BYPASS_UNCACHEABLE", null, null);
      return null;
    }
  }

  private async recordSuccess(key: string, routeKey: string, startedAt: number): Promise<EdgeCircuitState | null> {
    try {
      return await this.state.recordSuccess(key, this.time());
    } catch {
      this.emit(routeKey, startedAt, "STATE_DEGRADED", "BYPASS_UNCACHEABLE", null, null);
      return null;
    }
  }

  private async recordFailure(key: string, routeKey: string, startedAt: number): Promise<EdgeCircuitState | null> {
    try {
      return await this.state.recordFailure(key, this.time(), {
        failureThreshold: this.policy.failureThreshold,
        openCircuitMs: this.policy.openCircuitMs,
      });
    } catch {
      this.emit(routeKey, startedAt, "STATE_DEGRADED", "BYPASS_UNCACHEABLE", null, null);
      return null;
    }
  }

  private async executeWithTimeout(request: Request, upstream: EdgeUpstreamHandler): Promise<Response> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(request.signal.reason);
    if (request.signal.aborted) onAbort();
    else request.signal.addEventListener("abort", onAbort, { once: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new UpstreamTimeoutError());
        reject(new UpstreamTimeoutError());
      }, this.policy.timeoutMs);
    });
    try {
      const response = await Promise.race([Promise.resolve().then(() => upstream(request, controller.signal)), timeout]);
      if (!(response instanceof Response)) throw new TypeError("edge upstream must return a Response");
      return response;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
    }
  }

  async handle(routeKeyInput: string, request: Request, upstream: EdgeUpstreamHandler): Promise<Response> {
    const routeKey = assertRouteKey(routeKeyInput);
    if (!(request instanceof Request) || typeof upstream !== "function") throw new EdgeResilienceError("INVALID_INPUT", "edge request/upstream contract is invalid");
    let requestUrl: URL;
    try {
      requestUrl = new URL(request.url);
    } catch {
      throw new EdgeResilienceError("INVALID_INPUT", "edge request URL is invalid");
    }
    if (requestUrl.origin !== this.policy.operatorWebsiteOrigin) {
      throw new EdgeResilienceError("IDENTITY_MISMATCH", "edge request origin does not match the #10 operator origin");
    }

    const startedAt = this.time();
    const circuitKey = `${this.policy.policyId}:${routeKey}`;
    const decision = await this.beforeRequest(circuitKey, routeKey, startedAt);
    if (decision && !decision.allowed) {
      const unavailable = createEdgeUnavailableResponse(request, this.policy, 503);
      this.emit(routeKey, startedAt, "CIRCUIT_OPEN", unavailable.cacheMode, decision.state, 503);
      return unavailable.response;
    }

    if (this.inFlight >= this.policy.maxConcurrentRequests) {
      const unavailable = createEdgeUnavailableResponse(request, this.policy, 503);
      this.emit(routeKey, startedAt, "BULKHEAD_REJECTED", unavailable.cacheMode, decision?.state ?? null, 503);
      return unavailable.response;
    }

    this.inFlight += 1;
    try {
      let response: Response;
      try {
        response = await this.executeWithTimeout(request, upstream);
      } catch (error) {
        if (request.signal.aborted && !(error instanceof UpstreamTimeoutError)) {
          const unavailable = createEdgeUnavailableResponse(request, this.policy, 503);
          this.emit(routeKey, startedAt, "UPSTREAM_EXCEPTION", unavailable.cacheMode, decision?.state ?? null, 503);
          return unavailable.response;
        }
        const state = await this.recordFailure(circuitKey, routeKey, startedAt);
        const timedOut = error instanceof UpstreamTimeoutError;
        const unavailable = createEdgeUnavailableResponse(request, this.policy, timedOut ? 504 : 503);
        this.emit(routeKey, startedAt, timedOut ? "UPSTREAM_TIMEOUT" : "UPSTREAM_EXCEPTION", unavailable.cacheMode, state ?? decision?.state ?? null, unavailable.response.status);
        return unavailable.response;
      }

      if (transientStatus(response.status)) {
        const state = await this.recordFailure(circuitKey, routeKey, startedAt);
        const protectedResponse = applyEdgeResilienceFailureCachePolicy(request, response);
        this.emit(routeKey, startedAt, "UPSTREAM_FAILURE", protectedResponse.cacheMode, state ?? decision?.state ?? null, response.status);
        return protectedResponse.response;
      }

      const state = await this.recordSuccess(circuitKey, routeKey, startedAt);
      const protectedResponse = applyEdgeResilienceCachePolicy(request, response, this.policy);
      this.emit(routeKey, startedAt, "UPSTREAM_SUCCESS", protectedResponse.cacheMode, state ?? decision?.state ?? null, response.status);
      return protectedResponse.response;
    } finally {
      this.inFlight -= 1;
    }
  }
}
