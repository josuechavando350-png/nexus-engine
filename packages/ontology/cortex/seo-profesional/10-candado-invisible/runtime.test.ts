import { describe, expect, it, vi } from "vitest";
import { InMemoryEdgeCircuitStateStore } from "./circuit-breaker.js";
import { PortableEdgeResilienceRuntime } from "./runtime.js";

function runtime(options: Partial<{
  platform: "CLOUDFLARE" | "VERCEL";
  failureThreshold: number;
  openCircuitMs: number;
  maxConcurrentRequests: number;
  timeoutMs: number;
  now: () => number;
}> = {}) {
  return new PortableEdgeResilienceRuntime({
    policy: {
      policyId: "edge-main-v1",
      operatorWebsiteOrigin: "https://example.test",
      platform: options.platform ?? "VERCEL",
      timeoutMs: options.timeoutMs ?? 1_000,
      failureThreshold: options.failureThreshold ?? 2,
      openCircuitMs: options.openCircuitMs ?? 5_000,
      maxConcurrentRequests: options.maxConcurrentRequests ?? 8,
      browserMaxAgeSeconds: 0,
      edgeMaxAgeSeconds: 60,
      staleWhileRevalidateSeconds: 300,
      staleIfErrorSeconds: 3_600,
    },
    state: new InMemoryEdgeCircuitStateStore(),
    now: options.now,
  });
}

describe("PortableEdgeResilienceRuntime", () => {
  it("binds requests to the configured operator origin and emits provider-specific resilient cache headers", async () => {
    const edge = runtime({ platform: "CLOUDFLARE" });
    await expect(edge.handle("homepage", new Request("https://other.test/"), async () => new Response("no")))
      .rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });

    const response = await edge.handle("homepage", new Request("https://example.test/"), async () => new Response("ok", { status: 200 }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cloudflare-cdn-cache-control")).toContain("stale-if-error=3600");
    expect(edge.identity()).toEqual({ strategy: 10, provider: "PORTABLE_EDGE_RESILIENCE", platform: "CLOUDFLARE", operatorWebsiteOrigin: "https://example.test" });
  });

  it("opens the circuit after transient upstream failure and stops calling the upstream while open", async () => {
    let now = 1_000;
    const edge = runtime({ failureThreshold: 1, openCircuitMs: 5_000, now: () => now });
    const upstream = vi.fn(async () => new Response("down", { status: 503 }));
    expect((await edge.handle("homepage", new Request("https://example.test/"), upstream)).status).toBe(503);
    expect(upstream).toHaveBeenCalledTimes(1);

    now = 2_000;
    const blocked = await edge.handle("homepage", new Request("https://example.test/"), upstream);
    expect(blocked.status).toBe(503);
    expect(blocked.headers.get("retry-after")).toBe("5");
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("admits one half-open probe after cooldown and closes the circuit on success", async () => {
    let now = 1_000;
    const edge = runtime({ failureThreshold: 1, openCircuitMs: 1_000, now: () => now });
    await edge.handle("homepage", new Request("https://example.test/"), async () => new Response("down", { status: 503 }));
    now = 2_000;
    const success = await edge.handle("homepage", new Request("https://example.test/"), async () => new Response("back", { status: 200 }));
    expect(success.status).toBe(200);
    now = 2_001;
    const next = await edge.handle("homepage", new Request("https://example.test/"), async () => new Response("still back", { status: 200 }));
    expect(next.status).toBe(200);
  });

  it("uses a local bulkhead to reject isolate overload without calling the upstream twice", async () => {
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<Response>((resolve) => { release = () => resolve(new Response("first", { status: 200 })); });
    const edge = runtime({ maxConcurrentRequests: 1 });
    const upstream = vi.fn(async () => {
      started();
      return pending;
    });
    const first = edge.handle("homepage", new Request("https://example.test/"), upstream);
    await startedPromise;
    const second = await edge.handle("homepage", new Request("https://example.test/"), upstream);
    expect(second.status).toBe(503);
    expect(upstream).toHaveBeenCalledTimes(1);
    release();
    expect((await first).status).toBe(200);
  });

  it("returns 504 and records a failure when the upstream exceeds the bounded timeout", async () => {
    vi.useFakeTimers();
    try {
      const edge = runtime({ timeoutMs: 100, failureThreshold: 1 });
      const responsePromise = edge.handle("api", new Request("https://example.test/api"), async () => await new Promise<Response>(() => {}));
      await vi.advanceTimersByTimeAsync(101);
      const response = await responsePromise;
      expect(response.status).toBe(504);
      expect(response.headers.get("retry-after")).toBe("5");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails open when the circuit-state backend is unavailable so the resilience layer cannot create a site-wide outage", async () => {
    const state = {
      beforeRequest: async () => { throw new Error("state unavailable"); },
      recordSuccess: async () => { throw new Error("state unavailable"); },
      recordFailure: async () => { throw new Error("state unavailable"); },
    };
    const telemetry: unknown[] = [];
    const edge = new PortableEdgeResilienceRuntime({
      policy: {
        policyId: "edge-main-v1",
        operatorWebsiteOrigin: "https://example.test",
        platform: "VERCEL",
        timeoutMs: 1_000,
        failureThreshold: 2,
        openCircuitMs: 5_000,
        maxConcurrentRequests: 8,
        browserMaxAgeSeconds: 0,
        edgeMaxAgeSeconds: 60,
        staleWhileRevalidateSeconds: 300,
        staleIfErrorSeconds: 3_600,
      },
      state,
      onTelemetry: (event) => telemetry.push(event),
    });
    const response = await edge.handle("homepage", new Request("https://example.test/"), async () => new Response("ok", { status: 200 }));
    expect(response.status).toBe(200);
    expect(telemetry).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: "STATE_DEGRADED", routeKey: "homepage" }), expect.objectContaining({ outcome: "UPSTREAM_SUCCESS", routeKey: "homepage" })]));
    expect(JSON.stringify(telemetry)).not.toContain("https://example.test/");
  });

  it("keeps personalized failure responses private while leaving public 5xx eligible for CDN stale-if-error handling", async () => {
    const edge = runtime();
    const privateResponse = await edge.handle("personalized", new Request("https://example.test/", { headers: { "x-nexus-ad-experience": "a" } }), async () => new Response("down", { status: 503 }));
    expect(privateResponse.headers.get("cache-control")).toBe("private, no-store");

    const publicEdge = runtime();
    const publicResponse = await publicEdge.handle("public", new Request("https://example.test/"), async () => new Response("down", { status: 503 }));
    expect(publicResponse.headers.has("cache-control")).toBe(false);
  });
});
