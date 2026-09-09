import { describe, expect, it } from "vitest";
import {
  InMemoryEdgeCircuitStateStore,
  PortableEdgeResilienceRuntime,
} from "../10-candado-invisible/index.js";
import { createEdgeRuntimeGuardPolicy } from "./contracts.js";
import { createGuardedEdgeFetchHandler } from "./global-handler.js";
import { PortableEdgeRuntimeGuard } from "./runtime.js";

function realChain() {
  const state = new InMemoryEdgeCircuitStateStore();
  const edgeResilience = new PortableEdgeResilienceRuntime({
    policy: {
      policyId: "seo10-integration",
      operatorWebsiteOrigin: "https://example.test",
      platform: "VERCEL",
      timeoutMs: 500,
      failureThreshold: 2,
      openCircuitMs: 1_000,
      maxConcurrentRequests: 16,
      browserMaxAgeSeconds: 0,
      edgeMaxAgeSeconds: 60,
      staleWhileRevalidateSeconds: 300,
      staleIfErrorSeconds: 3_600,
      retryAfterSeconds: 1,
    },
    state,
  });
  const runtimeGuard = new PortableEdgeRuntimeGuard({
    policy: createEdgeRuntimeGuardPolicy({
      policyId: "seo11-integration",
      operatorWebsiteOrigin: "https://example.test",
      platform: "VERCEL",
      primaryTimeoutMs: 100,
      fallbackTimeoutMs: 50,
      stateOperationTimeoutMs: 20,
      failureThreshold: 1,
      openCircuitMs: 1_000,
      maxConcurrentExecutions: 8,
      retryAfterSeconds: 1,
    }),
    state,
  });
  return { edgeResilience, runtimeGuard };
}

describe("real #10 + #11 edge chain", () => {
  it("routes a transient primary failure through #11 fallback and then through #10 public cache policy", async () => {
    const { edgeResilience, runtimeGuard } = realChain();
    const handler = createGuardedEdgeFetchHandler({
      edgeResilience,
      runtimeGuard,
      routeKey: "homepage",
      operationKey: "render.homepage",
      primary: async () => new Response("primary down", { status: 503 }),
      fallback: async () => new Response("degraded public page", { status: 200 }),
    });

    const response = await handler(new Request("https://example.test/"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("degraded public page");
    expect(response.headers.get("cache-control")).toBe("public, max-age=0");
    expect(response.headers.get("cdn-cache-control")).toBe("public, max-age=60, stale-while-revalidate=300, stale-if-error=3600");
  });

  it("preserves #10 private no-store semantics around a real #11 fallback", async () => {
    const { edgeResilience, runtimeGuard } = realChain();
    const handler = createGuardedEdgeFetchHandler({
      edgeResilience,
      runtimeGuard,
      routeKey: "account-homepage",
      operationKey: "render.account-homepage",
      primary: async () => new Response("primary down", { status: 503 }),
      fallback: async () => new Response("private degraded page", { status: 200 }),
    });

    const response = await handler(new Request("https://example.test/account", { headers: { cookie: "session=private" } }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("private degraded page");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.has("cdn-cache-control")).toBe(false);
  });
});
