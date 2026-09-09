# 11 — Guardián de Latencia Cero

SEO Profesional #11 is a first-party Edge runtime execution guard layered **inside #10 Candado Invisible**. The product name is retained, but the implementation does not claim literal zero latency, a fixed physical distance from every user, forced garbage collection, immunity from provider limits, or the ability to kill arbitrary JavaScript that ignores cancellation.

## What it actually does

`PortableEdgeRuntimeGuard` protects a named request-time operation with:

- a hard application deadline exposed through `AbortSignal` to cooperative handlers;
- an independently bounded fallback deadline;
- reuse of #10's `EdgeCircuitStatePort` so repeatedly failing logical handlers enter CLOSED / OPEN / HALF_OPEN state instead of being retried on every request;
- a per-isolate concurrency bulkhead that rejects excess work before it amplifies CPU/heap pressure;
- a bounded fail-open timeout around the shared circuit-state backend, preventing a slow coordination store from becoming a new global outage;
- automatic fallback for 408, 425, 429, 5xx, primary timeout and primary exception;
- parent-signal propagation from #10 so #11 cannot keep working after the outer Edge request has already been cancelled;
- PII-minimized telemetry: operation key, provider/platform, outcome, circuit phase, statuses and duration only;
- no buffering or cloning of request/response bodies in the guard itself.

The fallback is not invoked when the local concurrency bulkhead is already saturated, because adding more application work while the isolate is under pressure would defeat the bulkhead. In that condition #11 returns a bounded 503 and lets outer #10 apply its provider/cache policy.

## Real #10 -> #11 composition

`createGuardedEdgeFetchHandler()` creates the production chain:

1. #10 receives the public request and applies its outer timeout/circuit/cache boundary.
2. #10 passes its request and `AbortSignal` to #11.
3. #11 executes the primary logical handler under its own operation circuit/deadline.
4. If primary fails or times out, #11 executes the bounded fallback.
5. The resulting `Response` returns through #10, which still owns privacy-safe cache and stale-if-error semantics.

#11 validates that #10 and #11 use the same canonical HTTPS origin and the same platform before creating the global handler.

## Memory reality

JavaScript Edge runtimes do not expose a portable API that safely "cleans RAM in hot production" or forces garbage collection. #11 therefore does not pretend to do so. It prevents common leak amplification patterns by keeping all execution state request-scoped, releasing its in-flight reservation in `finally`, avoiding body buffering, bounding concurrency and cutting off future primary work with the circuit breaker. A handler that retains objects globally is still a bug in that handler and must be fixed at source.

Cloudflare Workers currently enforce a 128 MB memory limit per isolate and can replace isolates when they exceed the limit. That provider behavior is not reimplemented by Nexus. CPU/resource termination is also provider-enforced. #11's `AbortSignal` deadline is cooperative for asynchronous application code; code that ignores cancellation cannot be forcibly terminated from ordinary JavaScript.

## Provider notes verified September 2026

### Cloudflare

Cloudflare Workers use Web-standard `Request`, `Response` and `AbortController`, matching this guard directly. Workers currently document 128 MB per isolate, configurable CPU limits, and provider-side termination/recycling when resource limits are exceeded. `ctx.waitUntil()` is for non-response background work and has its own post-response lifetime; #11 does not move response-critical fallback work into `waitUntil()`.

### Vercel

Vercel's historical Edge Functions runtime is deprecated for new projects. New applications should choose Routing Middleware for request-time routing or Vercel Functions/Fluid compute when the workload needs server-side compute. #11 stays vendor-neutral at the Web API boundary so it can be called from the appropriate Vercel request boundary without taking a dependency on a deprecated SDK. Long-running work belongs outside this guard; it should use the provider's durable/background primitives instead of extending request latency.

## Production requirements

- #11 must be composed behind the exact #10 runtime that protects the same canonical origin and platform.
- Multi-isolate production should use the same atomic shared `EdgeCircuitStatePort` discipline already required by #10; the in-memory store remains test/dev/single-isolate best effort.
- Primary and fallback handlers must honor the supplied `AbortSignal` for cancellable I/O.
- Fallbacks should be cheaper and less dependency-heavy than primaries.
- Application code must not keep unbounded global maps, buffers, response bodies or user-specific state across requests.

This is bounded failure and controlled degradation, not a promise that a provider, network, origin or arbitrary application bug can never fail.
