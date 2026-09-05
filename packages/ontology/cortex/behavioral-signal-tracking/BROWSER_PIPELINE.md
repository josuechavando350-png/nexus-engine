# CORTEX #6 browser-to-runtime pipeline

GREEN-PROD for behavioral signal tracking requires a real signal source, not only an ingestion API. `createBehavioralBrowserCollector` supplies the browser-side source and `createBehavioralSignalHttpHandler` supplies the web-standard server boundary into `CortexBehavioralSignalRuntime`.

The collector records page view, bounded scroll thresholds, CTA clicks, form start/submit/error, coarse pointer-enter/pointer-down, touch start/end and a visibility/focus-gated reading pause. Pointer coordinates, pressure, pointer IDs, touch counts, user-agent strings and arbitrary traits are never read or transmitted.

The collector requires an upstream privacy decision on every emission. When collection is denied, it does not generate an event ID or make a request. The endpoint is restricted to same-origin to avoid leaking behavioral telemetry to arbitrary third parties. Transport uses `fetch(..., { keepalive: true })` with a bounded in-memory retry count; consent is checked again before every retry.

The HTTP handler requires an explicit origin allowlist, JSON content type, a bounded request body and an exact envelope. It does not inspect cookies, IP addresses or user-agent headers. Events are handed directly to the durable runtime, which applies the same policy allowlists, HMAC pseudonymization, kill/observe modes, rollback control and integrity checks used by non-browser ingestion.

The integration test exercises the complete path from synthetic browser DOM events through the real HTTP handler into the same ontology transaction store and verifies aggregate counts plus absence of raw session/privacy identifiers in durable state.
