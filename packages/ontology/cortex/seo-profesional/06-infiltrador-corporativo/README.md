# SEO Profesional #6 — El Infiltrador Corporativo

Public procurement / RFQ intelligence for authorized public sources. The strategy detects procurement opportunities; it does **not** authenticate into private portals, bypass access controls, solve CAPTCHAs, evade anti-bot systems, submit bids, or contact buyers automatically.

## Production path

1. A tenant config declares an allowlisted public procurement origin and first-party seller identity.
2. `PublicProcurementUrlPolicy` requires HTTPS, exact-origin allowlisting and public DNS answers before every source/network boundary.
3. `RobotsPolicy` evaluates `robots.txt` for the `NexusProcurementBot` product token before ingestion.
4. Structured sources use OCDS JSON first. `parseOcdsOpportunities` retains bounded tender evidence only.
5. Public HTML sources use the structural browser port. The production adapter is `@nexus/capture/procurement-playwright` and creates a fresh Playwright `BrowserContext` per crawl.
6. The adapter forbids cross-origin navigation/subresources and calls the URL authorization callback before continuing requests.
7. Matching is deterministic against declared tenant capability phrases. It does not invent procurement fit with an LLM.
8. Qualified opportunities expose only a first-party `/procurement-opportunity?opportunity=<opaque-id>` handoff.
9. `SqliteProcurementJobQueue` provides durable tenant-scoped dedupe, leases and bounded retries; `ProcurementAsyncWorker` acknowledges only after the result sink succeeds.

## OCDS-first

When a portal exposes Open Contracting Data Standard JSON, the crawler uses it instead of rendering a browser. Supported input includes release packages (`releases`) and record packages with `compiledRelease` entries. Per-run bounds protect release count, text size, documents and response bytes.

## Public HTML fallback

HTML crawling is a fallback for genuinely public procurement notices. The Playwright adapter:

- launches headless Chromium through the existing `playwright` dependency in `@nexus/capture`;
- uses a fresh browser context per call (no cookie/session reuse between tenants);
- disables downloads and service workers;
- keeps navigation/subresources on the initial origin;
- re-authorizes each HTTP(S) request through the caller's public-URL policy;
- returns bounded title/text/link evidence only.

No credential, login, form-submit, file-upload, CAPTCHA, proxy rotation, fingerprint spoofing or anti-bot bypass API is exposed.

## Network / SSRF policy

Configured procurement origins must be bare HTTPS origins. DNS answers are checked before requests and private/special ranges are rejected, including IPv4 loopback/private/link-local/CGNAT/benchmark ranges and IPv6 loopback/ULA/link-local/multicast/documentation ranges. Redirects are disabled for structured fetches; the Playwright adapter rejects cross-origin final navigation.

This reduces SSRF risk but does not claim perfect protection against every possible DNS-rebinding or upstream compromise scenario. Production operators should also enforce egress policy at the infrastructure layer.

## Robots

The parser is bounded and uses exact case-insensitive product-token matching, falling back to `*` only when there is no exact group. Longest matching rule wins and `Allow` wins an equal-specificity tie. Percent octets are normalized without decoding reserved separators.

## Master System integration

The certified #1–#4 core remains unchanged. The accumulated master graph adds:

- `#4 -> #6` — `VERIFIED_SELLER_IDENTITY`: #6's seller origin must equal the canonical LocalBusiness origin from #4.
- `#6 -> #1` — `QUALIFIED_PROCUREMENT_HANDOFF`: a qualified public opportunity can link to the canonical first-party landing, whose visits re-enter the existing #1/#3/#4 acquisition circuit.

No individual strategy imports another strategy's internal implementation.
