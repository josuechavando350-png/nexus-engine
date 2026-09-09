import type {
  EdgeCircuitPhase,
  EdgeCircuitStatePort,
} from "../10-candado-invisible/index.js";
import {
  EdgeRuntimeGuardError,
  assertOperationKey,
  type EdgeRuntimeGuardIdentity,
  type EdgeRuntimeGuardOutcome,
  type EdgeRuntimeGuardPolicy,
  type EdgeRuntimeGuardTelemetryEvent,
  type EdgeRuntimeGuardTelemetrySink,
  type EdgeRuntimeHandler,
  type EdgeRuntimeStateBackend,
} from "./contracts.js";

type BoundedInvocation =
  | Readonly<{ kind: "RESPONSE"; response: Response }>
  | Readonly<{ kind: "TIMEOUT" }>
  | Readonly<{ kind: "PARENT_ABORTED" }>
  | Readonly<{ kind: "EXCEPTION" }>;

type StateCall<T> = Readonly<{ value: T | null; degraded: boolean }>;

type FallbackSuccessOutcome =
  | "PRIMARY_TRANSIENT_FALLBACK"
  | "PRIMARY_TIMEOUT_FALLBACK"
  | "PRIMARY_EXCEPTION_FALLBACK"
  | "CIRCUIT_OPEN_FALLBACK";

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function unavailable(status: 503 | 504, retryAfterSeconds: number): Response {
  return new Response(status === 504 ? "Guarded execution timed out" : "Guarded execution unavailable", {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "retry-after": String(retryAfterSeconds),
    },
  });
}

async function invokeBounded(
  handler: EdgeRuntimeHandler,
  request: Request,
  parentSignal: AbortSignal,
  timeoutMs: number,
): Promise<BoundedInvocation> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let detachParent: (() => void) | undefined;

  const abortResult = new Promise<BoundedInvocation>((resolve) => {
    const onParentAbort = () => {
      controller.abort(parentSignal.reason);
      resolve(Object.freeze({ kind: "PARENT_ABORTED" as const }));
    };
    if (parentSignal.aborted) {
      onParentAbort();
      return;
    }
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
    detachParent = () => parentSignal.removeEventListener("abort", onParentAbort);
    timer = setTimeout(() => {
      controller.abort(new Error("edge runtime guard deadline exceeded"));
      resolve(Object.freeze({ kind: "TIMEOUT" as const }));
    }, timeoutMs);
  });

  const handlerResult: Promise<BoundedInvocation> = Promise.resolve()
    .then(() => handler(request, controller.signal))
    .then(
      (response) => response instanceof Response
        ? Object.freeze({ kind: "RESPONSE" as const, response })
        : Object.freeze({ kind: "EXCEPTION" as const }),
      () => Object.freeze({ kind: "EXCEPTION" as const }),
    );

  try {
    return await Promise.race([handlerResult, abortResult]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    detachParent?.();
  }
}

export class PortableEdgeRuntimeGuard {
  private readonly policy: EdgeRuntimeGuardPolicy;
  private readonly state: EdgeCircuitStatePort;
  private readonly now: () => number;
  private readonly telemetry: EdgeRuntimeGuardTelemetrySink | null;
  private inFlight = 0;

  constructor(input: {
    readonly policy: EdgeRuntimeGuardPolicy;
    readonly state: EdgeCircuitStatePort;
    readonly now?: () => number;
    readonly telemetry?: EdgeRuntimeGuardTelemetrySink;
  }) {
    if (!input || typeof input !== "object") throw new EdgeRuntimeGuardError("INVALID_CONFIG", "edge runtime guard configuration is required");
    if (!input.policy || input.policy.version !== "seo11-edge-runtime-guard-v1") throw new EdgeRuntimeGuardError("INVALID_CONFIG", "edge runtime guard policy is invalid");
    if (!input.state || typeof input.state.beforeRequest !== "function" || typeof input.state.recordSuccess !== "function" || typeof input.state.recordFailure !== "function") {
      throw new EdgeRuntimeGuardError("INVALID_CONFIG", "edge runtime guard requires an EdgeCircuitStatePort");
    }
    if (input.now !== undefined && typeof input.now !== "function") throw new EdgeRuntimeGuardError("INVALID_CONFIG", "now must be a function");
    if (input.telemetry !== undefined && typeof input.telemetry !== "function") throw new EdgeRuntimeGuardError("INVALID_CONFIG", "telemetry must be a function");
    this.policy = input.policy;
    this.state = input.state;
    this.now = input.now ?? Date.now;
    this.telemetry = input.telemetry ?? null;
  }

  identity(): EdgeRuntimeGuardIdentity {
    return Object.freeze({
      strategy: 11 as const,
      provider: "EDGE_RUNTIME_GLOBAL_GUARD" as const,
      upstreamProvider: "PORTABLE_EDGE_RESILIENCE" as const,
      platform: this.policy.platform,
      operatorWebsiteOrigin: this.policy.operatorWebsiteOrigin,
    });
  }

  private async stateCall<T>(operation: () => Promise<T>): Promise<StateCall<T>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Readonly<{ kind: "FAILED" }>>((resolve) => {
      timer = setTimeout(() => resolve(Object.freeze({ kind: "FAILED" as const })), this.policy.stateOperationTimeoutMs);
    });
    const operationResult = Promise.resolve()
      .then(operation)
      .then(
        (value) => Object.freeze({ kind: "VALUE" as const, value }),
        () => Object.freeze({ kind: "FAILED" as const }),
      );
    try {
      const result = await Promise.race([operationResult, timeout]);
      return result.kind === "VALUE"
        ? Object.freeze({ value: result.value, degraded: false })
        : Object.freeze({ value: null, degraded: true });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private emit(input: Omit<EdgeRuntimeGuardTelemetryEvent, "strategy" | "platform" | "durationMs">, startedAt: number): void {
    if (!this.telemetry) return;
    try {
      this.telemetry(Object.freeze({
        strategy: 11 as const,
        platform: this.policy.platform,
        ...input,
        durationMs: Math.max(0, this.now() - startedAt),
      }));
    } catch {
      // Telemetry must never turn an otherwise valid edge response into an outage.
    }
  }

  private async recordSuccess(operationKey: string, stateBackend: EdgeRuntimeStateBackend): Promise<Readonly<{ stateBackend: EdgeRuntimeStateBackend; phase: EdgeCircuitPhase | "UNKNOWN" }>> {
    const result = await this.stateCall(() => this.state.recordSuccess(operationKey, this.now()));
    if (result.degraded || !result.value) return Object.freeze({ stateBackend: "DEGRADED" as const, phase: "UNKNOWN" as const });
    return Object.freeze({ stateBackend, phase: result.value.phase });
  }

  private async recordFailure(operationKey: string, stateBackend: EdgeRuntimeStateBackend): Promise<Readonly<{ stateBackend: EdgeRuntimeStateBackend; phase: EdgeCircuitPhase | "UNKNOWN" }>> {
    const result = await this.stateCall(() => this.state.recordFailure(operationKey, this.now(), {
      failureThreshold: this.policy.failureThreshold,
      openCircuitMs: this.policy.openCircuitMs,
    }));
    if (result.degraded || !result.value) return Object.freeze({ stateBackend: "DEGRADED" as const, phase: "UNKNOWN" as const });
    return Object.freeze({ stateBackend, phase: result.value.phase });
  }

  private async runFallback(
    successOutcome: FallbackSuccessOutcome,
    request: Request,
    parentSignal: AbortSignal,
    fallback: EdgeRuntimeHandler,
  ): Promise<Readonly<{ response: Response; outcome: EdgeRuntimeGuardOutcome; fallbackStatus: number | null }>> {
    const result = await invokeBounded(fallback, request, parentSignal, this.policy.fallbackTimeoutMs);
    if (result.kind === "PARENT_ABORTED") {
      return Object.freeze({ response: unavailable(504, this.policy.retryAfterSeconds), outcome: "PARENT_ABORTED" as const, fallbackStatus: null });
    }
    if (result.kind === "TIMEOUT") {
      return Object.freeze({ response: unavailable(504, this.policy.retryAfterSeconds), outcome: "FALLBACK_TIMEOUT" as const, fallbackStatus: null });
    }
    if (result.kind === "EXCEPTION") {
      return Object.freeze({ response: unavailable(503, this.policy.retryAfterSeconds), outcome: "FALLBACK_FAILURE" as const, fallbackStatus: null });
    }
    return Object.freeze({
      response: result.response,
      outcome: isTransientStatus(result.response.status) ? "FALLBACK_FAILURE" as const : successOutcome,
      fallbackStatus: result.response.status,
    });
  }

  async handle(
    operationKeyInput: string,
    request: Request,
    parentSignal: AbortSignal,
    primary: EdgeRuntimeHandler,
    fallback: EdgeRuntimeHandler,
  ): Promise<Response> {
    const operationKey = assertOperationKey(operationKeyInput);
    if (!(request instanceof Request)) throw new EdgeRuntimeGuardError("INVALID_INPUT", "request must be a Web Request");
    if (!parentSignal || typeof parentSignal.aborted !== "boolean" || typeof parentSignal.addEventListener !== "function") {
      throw new EdgeRuntimeGuardError("INVALID_INPUT", "parentSignal must be an AbortSignal");
    }
    if (typeof primary !== "function" || typeof fallback !== "function") throw new EdgeRuntimeGuardError("INVALID_INPUT", "primary and fallback handlers are required");
    if (new URL(request.url).origin !== this.policy.operatorWebsiteOrigin) {
      throw new EdgeRuntimeGuardError("IDENTITY_MISMATCH", "guarded request origin must match operatorWebsiteOrigin");
    }

    const startedAt = this.now();
    if (this.inFlight >= this.policy.maxConcurrentExecutions) {
      const response = unavailable(503, this.policy.retryAfterSeconds);
      this.emit({ operationKey, outcome: "BULKHEAD_REJECTED", stateBackend: "HEALTHY", circuitPhase: "UNKNOWN", primaryStatus: null, fallbackStatus: null }, startedAt);
      return response;
    }

    this.inFlight += 1;
    let stateBackend: EdgeRuntimeStateBackend = "HEALTHY";
    let circuitPhase: EdgeCircuitPhase | "UNKNOWN" = "UNKNOWN";
    let primaryStatus: number | null = null;
    try {
      const gate = await this.stateCall(() => this.state.beforeRequest(operationKey, this.now(), this.policy.halfOpenProbeLeaseMs));
      if (gate.degraded || !gate.value) {
        stateBackend = "DEGRADED";
      } else {
        circuitPhase = gate.value.state.phase;
        if (!gate.value.allowed) {
          const fallbackResult = await this.runFallback("CIRCUIT_OPEN_FALLBACK", request, parentSignal, fallback);
          this.emit({ operationKey, outcome: fallbackResult.outcome, stateBackend, circuitPhase, primaryStatus, fallbackStatus: fallbackResult.fallbackStatus }, startedAt);
          return fallbackResult.response;
        }
      }

      const primaryResult = await invokeBounded(primary, request, parentSignal, this.policy.primaryTimeoutMs);
      if (primaryResult.kind === "PARENT_ABORTED") {
        const response = unavailable(504, this.policy.retryAfterSeconds);
        this.emit({ operationKey, outcome: "PARENT_ABORTED", stateBackend, circuitPhase, primaryStatus, fallbackStatus: null }, startedAt);
        return response;
      }

      if (primaryResult.kind === "RESPONSE") {
        primaryStatus = primaryResult.response.status;
        if (!isTransientStatus(primaryStatus)) {
          const recorded = await this.recordSuccess(operationKey, stateBackend);
          stateBackend = recorded.stateBackend;
          circuitPhase = recorded.phase;
          this.emit({ operationKey, outcome: "PRIMARY_SUCCESS", stateBackend, circuitPhase, primaryStatus, fallbackStatus: null }, startedAt);
          return primaryResult.response;
        }
        const recorded = await this.recordFailure(operationKey, stateBackend);
        stateBackend = recorded.stateBackend;
        circuitPhase = recorded.phase;
        const fallbackResult = await this.runFallback("PRIMARY_TRANSIENT_FALLBACK", request, parentSignal, fallback);
        this.emit({ operationKey, outcome: fallbackResult.outcome, stateBackend, circuitPhase, primaryStatus, fallbackStatus: fallbackResult.fallbackStatus }, startedAt);
        return fallbackResult.response;
      }

      const recorded = await this.recordFailure(operationKey, stateBackend);
      stateBackend = recorded.stateBackend;
      circuitPhase = recorded.phase;
      const successOutcome = primaryResult.kind === "TIMEOUT" ? "PRIMARY_TIMEOUT_FALLBACK" as const : "PRIMARY_EXCEPTION_FALLBACK" as const;
      const fallbackResult = await this.runFallback(successOutcome, request, parentSignal, fallback);
      this.emit({ operationKey, outcome: fallbackResult.outcome, stateBackend, circuitPhase, primaryStatus, fallbackStatus: fallbackResult.fallbackStatus }, startedAt);
      return fallbackResult.response;
    } finally {
      this.inFlight -= 1;
    }
  }
}
