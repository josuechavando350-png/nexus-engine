import { describe, expect, it, vi } from "vitest";
import { InMemoryEdgeCircuitStateStore, type EdgeCircuitStatePort } from "../10-candado-invisible/index.js";
import { createEdgeRuntimeGuardPolicy, type EdgeRuntimeGuardTelemetryEvent } from "./contracts.js";
import { PortableEdgeRuntimeGuard } from "./runtime.js";

function makeRuntime(overrides: Partial<{ maxConcurrentExecutions: number; failureThreshold: number; primaryTimeoutMs: number; fallbackTimeoutMs: number; stateOperationTimeoutMs: number }> = {}) {
  const events: EdgeRuntimeGuardTelemetryEvent[] = [];
  const guard = new PortableEdgeRuntimeGuard({
    policy: createEdgeRuntimeGuardPolicy({
      policyId: "edge-handler-main-v1",
      operatorWebsiteOrigin: "https://example.test",
      platform: "VERCEL",
      primaryTimeoutMs: overrides.primaryTimeoutMs ?? 20,
      fallbackTimeoutMs: overrides.fallbackTimeoutMs ?? 20,
      stateOperationTimeoutMs: overrides.stateOperationTimeoutMs ?? 10,
      failureThreshold: overrides.failureThreshold ?? 1,
      openCircuitMs: 1_000,
      maxConcurrentExecutions: overrides.maxConcurrentExecutions ?? 8,
      retryAfterSeconds: 1,
    }),
    state: new InMemoryEdgeCircuitStateStore(),
    telemetry: (event) => events.push(event),
  });
  return { guard, events };
}

const request = () => new Request("https://example.test/edge");
const parent = () => new AbortController().signal;

function never(): Promise<Response> {
  return new Promise<Response>(() => undefined);
}

describe("PortableEdgeRuntimeGuard", () => {
  it("returns a healthy primary response without invoking fallback", async () => {
    const { guard, events } = makeRuntime();
    const fallback = vi.fn(async () => new Response("fallback", { status: 200 }));
    const response = await guard.handle("render.homepage", request(), parent(), async () => new Response("primary", { status: 200 }), fallback);
    expect(await response.text()).toBe("primary");
    expect(fallback).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ outcome: "PRIMARY_SUCCESS", primaryStatus: 200, fallbackStatus: null, stateBackend: "HEALTHY" });
  });

  it("opens the #11 circuit on a transient primary failure and routes later calls directly to fallback", async () => {
    const { guard, events } = makeRuntime({ failureThreshold: 1 });
    const primary = vi.fn(async () => new Response("down", { status: 503 }));
    const fallback = vi.fn(async () => new Response("degraded", { status: 200 }));
    const first = await guard.handle("render.homepage", request(), parent(), primary, fallback);
    const second = await guard.handle("render.homepage", request(), parent(), primary, fallback);
    expect(await first.text()).toBe("degraded");
    expect(await second.text()).toBe("degraded");
    expect(primary).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.outcome)).toEqual(["PRIMARY_TRANSIENT_FALLBACK", "CIRCUIT_OPEN_FALLBACK"]);
  });

  it("aborts a hung primary at the guard deadline and returns the bounded fallback", async () => {
    const { guard, events } = makeRuntime({ primaryTimeoutMs: 10 });
    let observedSignal: AbortSignal | null = null;
    const response = await guard.handle("render.homepage", request(), parent(), async (_request, signal) => {
      observedSignal = signal;
      return never();
    }, async () => new Response("fallback", { status: 200 }));
    expect(await response.text()).toBe("fallback");
    expect((observedSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(events.at(-1)).toMatchObject({ outcome: "PRIMARY_TIMEOUT_FALLBACK", fallbackStatus: 200 });
  });

  it("bounds a hung fallback and returns a 504 without cache directives that would defeat outer #10 stale-if-error", async () => {
    const { guard, events } = makeRuntime({ fallbackTimeoutMs: 10 });
    const response = await guard.handle("render.homepage", request(), parent(), async () => new Response("down", { status: 503 }), never);
    expect(response.status).toBe(504);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(response.headers.has("cache-control")).toBe(false);
    expect(events.at(-1)).toMatchObject({ outcome: "FALLBACK_TIMEOUT", primaryStatus: 503, fallbackStatus: null });
  });

  it("rejects excess concurrent executions instead of amplifying isolate pressure", async () => {
    const { guard, events } = makeRuntime({ maxConcurrentExecutions: 1 });
    let release: ((response: Response) => void) | undefined;
    const first = guard.handle("render.homepage", request(), parent(), async () => new Promise<Response>((resolve) => { release = resolve; }), async () => new Response("fallback"));
    const second = await guard.handle("render.search", request(), parent(), async () => new Response("should-not-run"), async () => new Response("fallback"));
    expect(second.status).toBe(503);
    expect(events.some((event) => event.outcome === "BULKHEAD_REJECTED")).toBe(true);
    release?.(new Response("ok", { status: 200 }));
    await expect(first).resolves.toMatchObject({ status: 200 });
  });

  it("fails open when the shared circuit backend is unavailable so the guard cannot create a global outage", async () => {
    const hangingState: EdgeCircuitStatePort = {
      beforeRequest: async () => new Promise(() => undefined),
      recordSuccess: async () => new Promise(() => undefined),
      recordFailure: async () => new Promise(() => undefined),
    };
    const events: EdgeRuntimeGuardTelemetryEvent[] = [];
    const guard = new PortableEdgeRuntimeGuard({
      policy: createEdgeRuntimeGuardPolicy({ policyId: "edge-state-degraded", operatorWebsiteOrigin: "https://example.test", platform: "CLOUDFLARE", primaryTimeoutMs: 50, fallbackTimeoutMs: 20, stateOperationTimeoutMs: 10, failureThreshold: 2, openCircuitMs: 1_000, maxConcurrentExecutions: 4 }),
      state: hangingState,
      telemetry: (event) => events.push(event),
    });
    const response = await guard.handle("render.homepage", request(), parent(), async () => new Response("primary", { status: 200 }), async () => new Response("fallback"));
    expect(await response.text()).toBe("primary");
    expect(events.at(-1)).toMatchObject({ outcome: "PRIMARY_SUCCESS", stateBackend: "DEGRADED", circuitPhase: "UNKNOWN" });
  });

  it("does not start fallback after the outer #10 request signal is already aborted", async () => {
    const { guard, events } = makeRuntime();
    const controller = new AbortController();
    controller.abort(new Error("outer edge deadline"));
    const fallback = vi.fn(async () => new Response("fallback"));
    const response = await guard.handle("render.homepage", request(), controller.signal, async () => new Response("primary"), fallback);
    expect(response.status).toBe(504);
    expect(fallback).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ outcome: "PARENT_ABORTED" });
  });
});
