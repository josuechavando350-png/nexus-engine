import { describe, expect, it } from "vitest";
import { applyEdgeResilienceCachePolicy, applyEdgeResilienceFailureCachePolicy, createEdgeUnavailableResponse } from "./cache-policy.js";
import { createEdgeResiliencePolicy } from "./contracts.js";

function policy(platform: "CLOUDFLARE" | "VERCEL") {
  return createEdgeResiliencePolicy({
    policyId: "edge-main-v1",
    operatorWebsiteOrigin: "https://example.test",
    platform,
    timeoutMs: 1_000,
    failureThreshold: 2,
    openCircuitMs: 5_000,
    maxConcurrentRequests: 8,
    browserMaxAgeSeconds: 0,
    edgeMaxAgeSeconds: 60,
    staleWhileRevalidateSeconds: 300,
    staleIfErrorSeconds: 3_600,
  });
}

describe("edge resilience cache policy", () => {
  it("uses Cloudflare-specific CDN cache control without s-maxage", () => {
    const result = applyEdgeResilienceCachePolicy(new Request("https://example.test/"), new Response("ok", { status: 200 }), policy("CLOUDFLARE"));
    expect(result.cacheMode).toBe("PUBLIC_RESILIENT");
    expect(result.response.headers.get("cache-control")).toBe("public, max-age=0");
    expect(result.response.headers.get("cloudflare-cdn-cache-control")).toBe("public, max-age=60, stale-while-revalidate=300, stale-if-error=3600");
    expect(result.response.headers.get("cloudflare-cdn-cache-control")).not.toMatch(/s-maxage/u);
    expect(result.response.headers.has("cdn-cache-control")).toBe(false);
  });

  it("uses CDN-Cache-Control for Vercel while keeping browser cache separate", () => {
    const result = applyEdgeResilienceCachePolicy(new Request("https://example.test/"), new Response("ok", { status: 200 }), policy("VERCEL"));
    expect(result.response.headers.get("cdn-cache-control")).toBe("public, max-age=60, stale-while-revalidate=300, stale-if-error=3600");
    expect(result.response.headers.get("cache-control")).toBe("public, max-age=0");
    expect(result.response.headers.has("cloudflare-cdn-cache-control")).toBe(false);
  });

  it("never shared-caches authorization, cookies, #3 personalization headers or Set-Cookie responses", () => {
    const privateHeaderSets: readonly HeadersInit[] = [
      { authorization: "Bearer token" },
      { cookie: "session=1" },
      { "x-nexus-ad-experience": "campaign-a" },
    ];
    for (const headers of privateHeaderSets) {
      const result = applyEdgeResilienceCachePolicy(new Request("https://example.test/", { headers }), new Response("ok", { status: 200 }), policy("VERCEL"));
      expect(result.cacheMode).toBe("PRIVATE_NO_STORE");
      expect(result.response.headers.get("cache-control")).toBe("private, no-store");
      expect(result.response.headers.has("cdn-cache-control")).toBe(false);
    }
    const setCookie = applyEdgeResilienceCachePolicy(new Request("https://example.test/"), new Response("ok", { status: 200, headers: { "set-cookie": "sid=1" } }), policy("CLOUDFLARE"));
    expect(setCookie.cacheMode).toBe("PRIVATE_NO_STORE");
  });

  it("respects an upstream no-store response and does not overwrite it with public caching", () => {
    const response = new Response("private", { status: 200, headers: { "cache-control": "no-store" } });
    const result = applyEdgeResilienceCachePolicy(new Request("https://example.test/"), response, policy("VERCEL"));
    expect(result.cacheMode).toBe("BYPASS_UNCACHEABLE");
    expect(result.response.headers.get("cache-control")).toBe("no-store");
    expect(result.response.headers.has("cdn-cache-control")).toBe(false);
  });

  it("strips positive cache directives from a public transient failure without adding no-store", () => {
    const response = new Response("down", { status: 503, headers: { "cache-control": "public, max-age=600", "cdn-cache-control": "public, max-age=600", expires: "Wed, 09 Sep 2026 00:00:00 GMT" } });
    const result = applyEdgeResilienceFailureCachePolicy(new Request("https://example.test/"), response);
    expect(result.cacheMode).toBe("BYPASS_UNCACHEABLE");
    expect(result.response.headers.has("cache-control")).toBe(false);
    expect(result.response.headers.has("cdn-cache-control")).toBe(false);
    expect(result.response.headers.has("expires")).toBe(false);
  });

  it("preserves upstream privacy on transient failures instead of exposing stale public caching", () => {
    const response = new Response("private failure", {
      status: 503,
      headers: {
        "cache-control": "private, no-store",
        "cdn-cache-control": "public, max-age=600, stale-if-error=3600",
        "surrogate-control": "max-age=600",
      },
    });
    const result = applyEdgeResilienceFailureCachePolicy(new Request("https://example.test/"), response);
    expect(result.cacheMode).toBe("PRIVATE_NO_STORE");
    expect(result.response.headers.get("cache-control")).toBe("private, no-store");
    expect(result.response.headers.has("cdn-cache-control")).toBe(false);
    expect(result.response.headers.has("surrogate-control")).toBe(false);
  });

  it("treats Set-Cookie failures as private even when public CDN headers are present", () => {
    const response = new Response("session failure", {
      status: 503,
      headers: {
        "set-cookie": "sid=secret; HttpOnly; Secure",
        "cdn-cache-control": "public, max-age=600",
      },
    });
    const result = applyEdgeResilienceFailureCachePolicy(new Request("https://example.test/"), response);
    expect(result.cacheMode).toBe("PRIVATE_NO_STORE");
    expect(result.response.headers.get("cache-control")).toBe("private, no-store");
    expect(result.response.headers.has("cdn-cache-control")).toBe(false);
    expect(result.response.headers.has("set-cookie")).toBe(true);
  });

  it("treats Vary authorization and zero shared max-age failures as private", () => {
    const varyResponse = new Response("auth failure", {
      status: 503,
      headers: { vary: "Accept-Encoding, Authorization", "cdn-cache-control": "public, max-age=600" },
    });
    const varyResult = applyEdgeResilienceFailureCachePolicy(new Request("https://example.test/"), varyResponse);
    expect(varyResult.cacheMode).toBe("PRIVATE_NO_STORE");
    expect(varyResult.response.headers.get("cache-control")).toBe("private, no-store");

    const zeroSharedMaxAge = new Response("do not share", {
      status: 503,
      headers: { "cloudflare-cdn-cache-control": "public, s-maxage=0" },
    });
    const zeroResult = applyEdgeResilienceFailureCachePolicy(new Request("https://example.test/"), zeroSharedMaxAge);
    expect(zeroResult.cacheMode).toBe("PRIVATE_NO_STORE");
    expect(zeroResult.response.headers.get("cache-control")).toBe("private, no-store");
    expect(zeroResult.response.headers.has("cloudflare-cdn-cache-control")).toBe(false);
  });

  it("does not add no-store to a public 5xx because that can suppress provider stale-if-error fallback", () => {
    const result = createEdgeUnavailableResponse(new Request("https://example.test/"), policy("CLOUDFLARE"), 503);
    expect(result.cacheMode).toBe("BYPASS_UNCACHEABLE");
    expect(result.response.headers.has("cache-control")).toBe(false);
    expect(result.response.headers.get("retry-after")).toBe("5");
  });
});
