import { NextResponse, type NextRequest } from "next/server";
import { createEdgeCachePolicy, evaluateEdgeCache, type EdgeCachePolicyInput } from "@nexus/core/cortex/interaction-pointer-edge-caching";

export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  try {
    const raw = process.env.NEXUS_CORTEX_28_EDGE_CACHE_POLICY_JSON?.trim();
    if (!raw) throw new Error("edge cache policy missing");
    const policy = createEdgeCachePolicy(JSON.parse(raw) as EdgeCachePolicyInput);
    const decision = evaluateEdgeCache({
      url: request.url,
      method: request.method,
      authorizationPresent: request.headers.has("authorization"),
      cookiePresent: request.headers.has("cookie"),
    }, policy);
    response.headers.set("cache-control", decision.cacheControl);
    response.headers.set("x-nexus-cortex-28-cache-reason", decision.reason);
    response.headers.set("x-nexus-cortex-28-prerender-safe", decision.prerenderAllowed ? "1" : "0");
    return response;
  } catch {
    response.headers.set("cache-control", "private, no-store");
    response.headers.set("x-nexus-cortex-28-cache-reason", "POLICY_UNAVAILABLE");
    response.headers.set("x-nexus-cortex-28-prerender-safe", "0");
    return response;
  }
}

export const config = {
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico).*)"],
};
