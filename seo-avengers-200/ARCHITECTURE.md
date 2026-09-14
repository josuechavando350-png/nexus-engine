# Architecture invariants

1. **Nexus render path is untouchable.** All CPU/network-heavy work is submitted after artifact commit and handled asynchronously.
2. **Hash first.** Every job carries Nexus `source_revision`, `input_hash`, and `idempotency_key`; every result carries `output_hash`.
3. **Edge transforms are bounded and semantic-equivalent.** No crawler-only text, links or structured-data claims.
4. **External APIs are adapters.** Google NLP, eligible Google APIs, Search Console, SERP-data providers and backlink-data providers fail closed and never crash or stall Nexus. Direct automated querying or scraping of Google Search is not an allowed provider path.
5. **Operator gates risky mutations.** Redirects, slug rewrites, external-link/backlink creation, disavow actions, DNS changes and title experiments are proposed/evidenced before activation. Enabling `CONFIG_SEO_AVENGERS_200` alone is never sufficient authorization for those mutations.
6. **Policy-sensitive catalog entries fail closed at activation.** Historical catalog entries M18, M21, M23, M25 and M50 are forced to effective `advisory-only` activation even when their catalog mode remains `compliant`; the original catalog mode is retained in activation evidence as `catalog_mode` for provenance.
7. **RUM is observational.** Telemetry is deferred, sampled, consent-aware where required, and never used to fake CrUX.
8. **Controlled execution is not production authorization.** WALLE/local-mirror runs may execute every module contract to collect deterministic evidence, including GATED/ADVISORY contracts, but that execution must not be interpreted as permission to perform an external or destructive action.

## Google Search safety boundary

NEXUS must use authorized provider/API surfaces for Google-owned data where applicable. It must not use Google Search result pages as a rank-check scraping surface, must not generate crawler-only variants, must not create external links automatically for ranking manipulation, and must not publish doorway/near-duplicate location or service pages merely to capture queries. A missing eligibility signal, operator approval, provenance record, or policy decision is a deny condition rather than an implicit allow.

This boundary is intentionally stricter than module names. A module may retain a historical name such as "Web Scraper a Backlink" for catalog identity while its effective activation remains advisory and its external action stays forbidden unless a separately authorized provider/action contract exists.

## Multi-tenant capability boundary

The capability has two independent isolation authorities:

- Native Nexus: `apps/<site_id>/package.json -> nexus.CONFIG_SEO_AVENGERS_200`.
- External sites: `apps/seo-avengers-reverse-proxy/external-clients.json -> CONFIG_SEO_AVENGERS_200`.

No global `true` setting is authoritative. The checked-in native gateway template is `false`. External Cloudflare Routes are generated only for records explicitly set to `true`.

For disabled native clients, the Nexus helper never creates `.artifacts`. For disabled/unknown external clients, the reverse proxy performs only the normal route-to-origin `fetch(request)` and does not touch SEO KV or the Rust Service Binding.

The shared Rust transform service is tenant-neutral. It accepts the already-scoped vector snapshot and cannot derive client identity from global environment variables.
