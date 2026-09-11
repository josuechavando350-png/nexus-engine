# SEO AVENGERS 200 — exact integration map

This package is installed as a premium sidecar. The checked-in state is **OFF**. Missing or `false` is authoritative OFF; only an explicit boolean `true` on the named tenant enables the suite.

## Nexus tenant manifest

For the standalone Nexus delivery ZIP, `package.json` lines 84–93 contain the `nexus` tenant block. `CONFIG_SEO_AVENGERS_50` and `CONFIG_SEO_AVENGERS_200` both ship `false`.

For monorepo clients, the authoritative lookup is implemented in:

- `engine-overlay/scripts/seo-avengers-200-config.mjs:4` — flag name.
- `engine-overlay/scripts/seo-avengers-200-config.mjs:6-24` — exact per-project manifest lookup; only boolean `true` enables.

## Persistence bridge

- `engine-overlay/scripts/seo-avengers-200-outbox.mjs:66-70` — lazy bypass occurs before repository discovery, mkdir, DB or network.
- `engine-overlay/scripts/seo-avengers-200-outbox.mjs:72-94` — deterministic SHA-256 envelope and atomic outbox write.
- `engine-overlay/scripts/nexus-client-pipeline-seo-avengers-200.mjs:1-50` — wrapper preserves the native pipeline result and only persists sidecar work after a real `RENDER PASS`.
- `apps/nexus-commander-dashboard/outbox.go` — Go goroutine consumes durable envelopes and calls FastAPI asynchronously.
- `packages/Semantic-Python-NLP/main.py:82-113` — validated M200 section envelope.
- `packages/Semantic-Python-NLP/main.py:491+` — deterministic semantic/vector profile and module evidence.

## 200-module catalog

- `packages/Core-Go-Backend/module-catalog.json:3` starts M001.
- M050 starts at line 738.
- M051 starts at line 753.
- M100 starts at line 1488.
- M101 starts at line 1503.
- M150 starts at line 2238.
- M151 starts at line 2253.
- M200 starts at line 2988.

The catalog preserves the attached source contract metadata (`execution_layer`, `category`, `contract_type`, `fail_safe_status`, `request_path_blocking`) for all 200 modules.

## Go dispatcher / PageRank

- `packages/Core-Go-Backend/activation.go:27+` — OFF returns before catalog loading; ON expands the 200-module policy-aware activation plan.
- `packages/Core-Go-Backend/dispatcher.go:35+` — asynchronous fan-out of M001–M200.
- `packages/Core-Go-Backend/pagerank.go` and `perron.go` — deterministic sparse stochastic matrix and damped Perron-Frobenius power iteration, context-cancelable.
- `packages/Core-Go-Backend/httpcache.go` — SHA-256 ETags and 304 representation equivalence helpers.

## Edge bridge

- `apps/edge-cloudflare-gateway/src/index.ts` — `false`/missing returns origin immediately before SEO KV or transformer access; origin/body materialization is outside the optional edge deadline; the native gateway uses a 50 ms KV + Rust deadline.
- `apps/seo-avengers-reverse-proxy/src/index.ts` — unknown/disabled tenants bypass without SEO KV/Service Binding; enabled external tenants materialize the origin body before starting the 4 ms KV + Rust deadline.
- `apps/edge-cloudflare-worker/src/lib.rs` — `lol_html` shadow-streaming transform. Rust does not fabricate Wikidata IDs and emits only tenant-scoped graph nodes supported by the semantic snapshot.

## External tenants

- `apps/seo-avengers-reverse-proxy/external-clients.json` — all entries ship `CONFIG_SEO_AVENGERS_200: false`.
- `scripts/add-external-client.sh` — atomic per-client registry update.
- `scripts/deploy-capability.sh` — the only supported activation command for a named tenant.
- `scripts/disable-capability.sh` — turns off one named tenant without enabling any other.

## End-to-end proof

- `scripts/verify.sh` — 12 static/unit gates, including 200/200 source-contract parity and global OFF state.
- `scripts/test-external-reverse-proxy.mjs` — regression proof that slow origin-body materialization does not consume the external 4 ms edge deadline.
- `scripts/local-mirror-e2e.sh` — exercises outbox → Go → Python → SQLite vectors, gateway fail-open, 200-module activation, and 200 asynchronous background jobs.
