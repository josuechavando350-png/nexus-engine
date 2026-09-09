import { describe, expect, it, vi } from "vitest";
import { createGuardedEdgeFetchHandler, type EdgeResilienceBoundaryPort, type EdgeRuntimeGuardBoundaryPort } from "./global-handler.js";

function edge(origin = "https://example.test", platform: "CLOUDFLARE" | "VERCEL" = "VERCEL", calls: string[] = []): EdgeResilienceBoundaryPort {
  return {
    identity: () => Object.freeze({ strategy: 10 as const, provider: "PORTABLE_EDGE_RESILIENCE" as const, platform, operatorWebsiteOrigin: origin }),
    handle: async (routeKey, request, upstream) => {
      calls.push(`#10:${routeKey}`);
      return upstream(request, new AbortController().signal);
    },
  };
}

function guard(origin = "https://example.test", platform: "CLOUDFLARE" | "VERCEL" = "VERCEL", calls: string[] = []): EdgeRuntimeGuardBoundaryPort {
  return {
    identity: () => Object.freeze({ strategy: 11 as const, provider: "EDGE_RUNTIME_GLOBAL_GUARD" as const, upstreamProvider: "PORTABLE_EDGE_RESILIENCE" as const, platform, operatorWebsiteOrigin: origin }),
    handle: async (operationKey, request, signal, primary) => {
      calls.push(`#11:${operationKey}`);
      return primary(request, signal);
    },
  };
}

describe("createGuardedEdgeFetchHandler", () => {
  it("executes the production chain #10 -> #11 -> primary handler", async () => {
    const calls: string[] = [];
    const primary = vi.fn(async () => new Response("ok", { status: 200 }));
    const handler = createGuardedEdgeFetchHandler({ edgeResilience: edge("https://example.test", "VERCEL", calls), runtimeGuard: guard("https://example.test", "VERCEL", calls), routeKey: "homepage", operationKey: "render.homepage", primary, fallback: async () => new Response("fallback") });
    const response = await handler(new Request("https://example.test/"));
    expect(response.status).toBe(200);
    expect(calls).toEqual(["#10:homepage", "#11:render.homepage"]);
    expect(primary).toHaveBeenCalledTimes(1);
  });

  it("rejects a #10/#11 origin or platform mismatch before serving traffic", () => {
    expect(() => createGuardedEdgeFetchHandler({ edgeResilience: edge(), runtimeGuard: guard("https://other.example"), routeKey: "homepage", operationKey: "render.homepage", primary: async () => new Response("ok"), fallback: async () => new Response("fallback") })).toThrow(/same origin/u);
    expect(() => createGuardedEdgeFetchHandler({ edgeResilience: edge("https://example.test", "VERCEL"), runtimeGuard: guard("https://example.test", "CLOUDFLARE"), routeKey: "homepage", operationKey: "render.homepage", primary: async () => new Response("ok"), fallback: async () => new Response("fallback") })).toThrow(/same origin.*same platform|same platform/u);
  });
});
