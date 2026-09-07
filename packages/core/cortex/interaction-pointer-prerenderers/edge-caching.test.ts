import { describe, expect, it } from "vitest";
import { createEdgeCachePolicy, evaluateEdgeCache, prerenderControlFromEdgeCache } from "./edge-caching";

function policy(mode: "ACTIVE" | "OBSERVE_ONLY" | "KILLED" = "ACTIVE") {
  return createEdgeCachePolicy({
    version: 1,
    mode,
    paths: [
      { path: "/explore", maxAgeSeconds: 60, staleWhileRevalidateSeconds: 300, prerenderAllowed: true },
      { path: "/proof", maxAgeSeconds: 300, staleWhileRevalidateSeconds: 600, prerenderAllowed: true },
      { path: "/contact", maxAgeSeconds: 0, staleWhileRevalidateSeconds: 0, prerenderAllowed: false },
    ],
  });
}

describe("CORTEX #28 edge caching", () => {
  it("derives pointer prerender allowlist from the same cache-safe paths", () => {
    expect(prerenderControlFromEdgeCache(policy(), 4)).toEqual({ mode: "ACTIVE", allowedPaths: ["/explore", "/proof"], maxPreparedTargets: 4 });
  });

  it("emits edge cache headers only for anonymous query-free GET/HEAD requests", () => {
    expect(evaluateEdgeCache({ url: "https://example.test/explore", method: "GET", authorizationPresent: false, cookiePresent: false }, policy())).toMatchObject({ cacheable: true, prerenderAllowed: true, cacheControl: "public, s-maxage=60, stale-while-revalidate=300", reason: "CACHEABLE" });
    expect(evaluateEdgeCache({ url: "https://example.test/explore?utm_source=google", method: "GET", authorizationPresent: false, cookiePresent: false }, policy())).toMatchObject({ cacheable: false, reason: "QUERY_PRESENT", cacheControl: "private, no-store" });
    expect(evaluateEdgeCache({ url: "https://example.test/explore", method: "GET", authorizationPresent: false, cookiePresent: true }, policy())).toMatchObject({ cacheable: false, reason: "IDENTITY_PRESENT" });
    expect(evaluateEdgeCache({ url: "https://example.test/explore", method: "POST", authorizationPresent: false, cookiePresent: false }, policy())).toMatchObject({ cacheable: false, reason: "METHOD_NOT_CACHEABLE" });
  });

  it("KILLED and OBSERVE_ONLY never make an edge response cacheable or prerenderable", () => {
    expect(evaluateEdgeCache({ url: "https://example.test/proof", method: "GET", authorizationPresent: false, cookiePresent: false }, policy("KILLED"))).toMatchObject({ cacheable: false, prerenderAllowed: false, reason: "KILL_SWITCH" });
    expect(evaluateEdgeCache({ url: "https://example.test/proof", method: "GET", authorizationPresent: false, cookiePresent: false }, policy("OBSERVE_ONLY"))).toMatchObject({ cacheable: false, prerenderAllowed: false, reason: "OBSERVE_ONLY" });
  });

  it("refuses prerender on paths with zero edge cache lifetime", () => {
    expect(() => createEdgeCachePolicy({ version: 1, mode: "ACTIVE", paths: [{ path: "/unsafe", maxAgeSeconds: 0, staleWhileRevalidateSeconds: 0, prerenderAllowed: true }] })).toThrowError(/zero edge cache lifetime/u);
  });
});