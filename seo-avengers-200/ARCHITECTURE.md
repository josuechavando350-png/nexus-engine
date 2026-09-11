# Architecture invariants

1. **Nexus render path is untouchable.** All CPU/network-heavy work is submitted after artifact commit and handled asynchronously.
2. **Hash first.** Every job carries Nexus `source_revision`, `input_hash`, and `idempotency_key`; every result carries `output_hash`.
3. **Edge transforms are bounded and semantic-equivalent.** No crawler-only text, links or structured-data claims.
4. **External APIs are adapters.** Google NLP, indexing, SERP providers and backlink providers fail closed and never crash or stall Nexus.
5. **Operator gates risky mutations.** Redirects, slug rewrites, disavow recommendations, DNS changes and title experiments are proposed/evidenced before activation.
6. **RUM is observational.** Telemetry is deferred, sampled, consent-aware where required, and never used to fake CrUX.

## Multi-tenant capability boundary

The capability has two independent isolation authorities:

- Native Nexus: `apps/<site_id>/package.json -> nexus.CONFIG_SEO_AVENGERS_200`.
- External sites: `apps/seo-avengers-reverse-proxy/external-clients.json -> CONFIG_SEO_AVENGERS_200`.

No global `true` setting is authoritative. The checked-in native gateway template is `false`. External Cloudflare Routes are generated only for records explicitly set to `true`.

For disabled native clients, the Nexus helper never creates `.artifacts`. For disabled/unknown external clients, the reverse proxy performs only the normal route-to-origin `fetch(request)` and does not touch SEO KV or the Rust Service Binding.

The shared Rust transform service is tenant-neutral. It accepts the already-scoped vector snapshot and cannot derive client identity from global environment variables.
