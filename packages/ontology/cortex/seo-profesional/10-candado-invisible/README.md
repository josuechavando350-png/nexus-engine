# 10 — Candado Invisible

SEO Profesional #10 is a portable Edge resilience boundary for the canonical first-party website. It does **not** claim immunity from outages, DDoS, provider incidents, cache misses, origin bugs or network partitions. The goal is bounded failure, controlled degradation and preservation of previously cached public content when the selected CDN supports it.

## Architecture

`PortableEdgeResilienceRuntime` is based only on Web `Request`, `Response`, `AbortController` and timers. It does not import Next.js, Vercel SDKs or Cloudflare SDKs, so the same policy can be composed at either edge provider.

The runtime provides:

- an atomic circuit-state port with CLOSED / OPEN / HALF_OPEN transitions;
- bounded upstream timeout;
- a per-isolate concurrency bulkhead;
- fail-open behavior if the breaker state backend itself is unavailable, so the resilience subsystem cannot create a new global outage;
- transient-failure classification for 408, 425, 429 and 5xx responses;
- provider-specific public cache headers for previously successful responses;
- privacy/cache guards that never shared-cache Authorization, Cookie, Nexus ad-personalization/session requests or `Set-Cookie` responses;
- PII-minimized telemetry containing only configured route keys, platform, outcome, cache mode, circuit phase, status and duration.

The included `InMemoryEdgeCircuitStateStore` is intentionally scoped to tests, local development and best-effort single-isolate operation. Multi-isolate production deployments must inject a state implementation whose `beforeRequest`, `recordSuccess` and `recordFailure` operations are atomic for each circuit key. A Cloudflare deployment can back that port with an appropriate coordination primitive such as a Durable Object; Vercel deployments can use a shared durable store. #10 does not pretend an isolate-local `Map` is globally coordinated state.

## Cache policy

Only GET/HEAD responses with status 200 and no private/session signals are eligible for resilient shared caching. Existing `private`, `no-store`, `no-cache`, `must-revalidate` or `proxy-revalidate` directives are respected instead of being overwritten.

### Cloudflare

#10 emits browser `Cache-Control` separately from `Cloudflare-CDN-Cache-Control`. The Cloudflare edge header uses `max-age`, `stale-while-revalidate` and `stale-if-error` and deliberately does not inject `s-maxage`, because current Cloudflare caching semantics can disable stale serving when `s-maxage`/revalidation-forcing directives are present.

### Vercel

#10 uses browser `Cache-Control` plus `CDN-Cache-Control` for the edge TTL and stale windows. This keeps browser freshness independent from Vercel CDN freshness.

For public upstream 5xx/timeout/circuit-open responses, #10 does not add a fresh `no-store` directive that could interfere with a CDN's stale-on-error decision for an already cached successful object. Private/personalized failures do receive `private, no-store`.

A true cache miss still has no stale object to serve. When the circuit is open or a bulkhead is saturated, #10 returns a bounded 503; upstream timeout returns 504. `Retry-After` is present. These responses are not claims of zero downtime.

## Connected master

- `#4 -> #10` via `VERIFIED_EDGE_OPERATOR_IDENTITY`: the protected origin must equal the canonical LocalBusiness / first-party website origin.
- `#10 -> #1` via `RESILIENT_WEB_LANDING`: successful/fallback edge delivery remains the same web acquisition surface and returns to the existing invalid-traffic/acquisition circuit.

#1–#9 do not import #10 internals. The accumulated SEO master depends only on the structural #10 port.

## External behavior checked

The cache-header split follows current provider documentation verified in September 2026:

- Cloudflare Workers caching / `Cloudflare-CDN-Cache-Control`, `stale-while-revalidate` and `stale-if-error`.
- Vercel CDN `CDN-Cache-Control`, background revalidation and stale cache behavior.

Provider configuration outside this repository can override or disable these semantics. #10 therefore exposes resilience policy and observability, not an impossible guarantee of provider-independent uptime.
