import type { EdgeCacheMode, EdgeResiliencePolicy } from "./contracts.js";

const PRIVATE_REQUEST_HEADERS = Object.freeze([
  "authorization",
  "cookie",
  "x-nexus-ad-experience",
  "x-nexus-ad-context",
  "x-nexus-personalization",
  "x-nexus-session",
] as const);
const RESPONSE_CACHE_CONTROL_HEADERS = Object.freeze([
  "cache-control",
  "cdn-cache-control",
  "cloudflare-cdn-cache-control",
  "vercel-cdn-cache-control",
  "surrogate-control",
] as const);
const RESTRICTIVE_CACHE_DIRECTIVE = /(?:^|,)\s*(?:private|no-store|no-cache|must-revalidate|proxy-revalidate)(?:\s*(?:=|,|$)|$)/iu;
const ZERO_SHARED_MAX_AGE_DIRECTIVE = /(?:^|,)\s*s-maxage\s*=\s*0\s*(?:,|$)/iu;

export interface EdgeCachePolicyApplication {
  readonly response: Response;
  readonly cacheMode: EdgeCacheMode;
}

function cloneWithHeaders(response: Response, headers: Headers): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function responseVariesOnPrivateContext(response: Response): boolean {
  const vary = response.headers.get("vary")?.toLowerCase() ?? "";
  return vary
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === "*" || value === "cookie" || value === "authorization");
}

function responseDeclaresRestrictiveCaching(response: Response): boolean {
  for (const name of RESPONSE_CACHE_CONTROL_HEADERS) {
    const value = response.headers.get(name) ?? "";
    if (RESTRICTIVE_CACHE_DIRECTIVE.test(value) || ZERO_SHARED_MAX_AGE_DIRECTIVE.test(value)) return true;
  }
  return false;
}

function failureResponseRequiresPrivateNoStore(response: Response): boolean {
  return response.headers.has("set-cookie") || responseVariesOnPrivateContext(response) || responseDeclaresRestrictiveCaching(response);
}

export function requestCanUseSharedResilienceCache(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  for (const name of PRIVATE_REQUEST_HEADERS) if (request.headers.has(name)) return false;
  return true;
}

export function responseCanUseSharedResilienceCache(response: Response): boolean {
  if (response.status !== 200) return false;
  if (response.headers.has("set-cookie")) return false;
  if (responseVariesOnPrivateContext(response)) return false;
  if (responseDeclaresRestrictiveCaching(response)) return false;
  return true;
}

function privateNoStore(response: Response): EdgeCachePolicyApplication {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  headers.delete("cdn-cache-control");
  headers.delete("cloudflare-cdn-cache-control");
  headers.delete("vercel-cdn-cache-control");
  headers.delete("surrogate-control");
  headers.delete("expires");
  return Object.freeze({ response: cloneWithHeaders(response, headers), cacheMode: "PRIVATE_NO_STORE" as const });
}

function bypass(response: Response): EdgeCachePolicyApplication {
  return Object.freeze({ response, cacheMode: "BYPASS_UNCACHEABLE" as const });
}

export function applyEdgeResilienceCachePolicy(request: Request, response: Response, policy: EdgeResiliencePolicy): EdgeCachePolicyApplication {
  if (!requestCanUseSharedResilienceCache(request)) return privateNoStore(response);
  if (!responseCanUseSharedResilienceCache(response)) {
    if (response.headers.has("set-cookie")) return privateNoStore(response);
    return bypass(response);
  }

  const headers = new Headers(response.headers);
  headers.set("cache-control", `public, max-age=${policy.browserMaxAgeSeconds}`);
  const edgeDirectives = `public, max-age=${policy.edgeMaxAgeSeconds}, stale-while-revalidate=${policy.staleWhileRevalidateSeconds}, stale-if-error=${policy.staleIfErrorSeconds}`;
  if (policy.platform === "CLOUDFLARE") {
    headers.set("cloudflare-cdn-cache-control", edgeDirectives);
    headers.delete("cdn-cache-control");
    headers.delete("vercel-cdn-cache-control");
  } else {
    headers.set("cdn-cache-control", edgeDirectives);
    headers.delete("cloudflare-cdn-cache-control");
    headers.delete("vercel-cdn-cache-control");
  }
  return Object.freeze({ response: cloneWithHeaders(response, headers), cacheMode: "PUBLIC_RESILIENT" as const });
}

export function applyEdgeResilienceFailureCachePolicy(request: Request, response: Response): EdgeCachePolicyApplication {
  if (!requestCanUseSharedResilienceCache(request) || failureResponseRequiresPrivateNoStore(response)) return privateNoStore(response);

  const headers = new Headers(response.headers);
  headers.delete("cache-control");
  headers.delete("cdn-cache-control");
  headers.delete("cloudflare-cdn-cache-control");
  headers.delete("vercel-cdn-cache-control");
  headers.delete("expires");
  headers.delete("surrogate-control");
  return Object.freeze({ response: cloneWithHeaders(response, headers), cacheMode: "BYPASS_UNCACHEABLE" as const });
}

export function createEdgeUnavailableResponse(request: Request, policy: EdgeResiliencePolicy, status: 503 | 504): EdgeCachePolicyApplication {
  const headers = new Headers({
    "content-type": "text/plain; charset=utf-8",
    "retry-after": String(policy.retryAfterSeconds),
  });
  if (!requestCanUseSharedResilienceCache(request)) headers.set("cache-control", "private, no-store");
  const response = new Response(status === 504 ? "Upstream timed out" : "Service temporarily unavailable", { status, headers });
  return Object.freeze({ response, cacheMode: requestCanUseSharedResilienceCache(request) ? "BYPASS_UNCACHEABLE" as const : "PRIVATE_NO_STORE" as const });
}
