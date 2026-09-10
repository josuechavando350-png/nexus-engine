# SEO AVENGERS 200

Premium multi-tenant SEO/semantic sidecar for Nexus Bot Studio. This package expands the prior M001–M050 catalog to **M001–M200** while preserving Nexus' deterministic native pipeline as the authority.

## Shipping state: OFF

`CONFIG_SEO_AVENGERS_200` is **OFF for every tenant in source control**. No tenant, including Nexus Bot Studio, is implicitly activated. A missing property is also OFF. The legacy `CONFIG_SEO_AVENGERS_50` flag is not an alias and cannot enable this suite.

The attached source specification declares the same deny-by-default switch, a 4 ms edge guard and 200 non-blocking module contracts. Those 200 source contract fields are preserved exactly in `packages/Core-Go-Backend/module-catalog.json`. The implementation hardens unsafe/incomplete sample snippets rather than copying them blindly—for example, there is no hard-coded secret, no fabricated Wikidata identity, and the Python semantic worker contains real persistence/analysis logic rather than a `pass` placeholder.

## Isolation model

```text
OFF tenant
  manifest/registry lookup
  └─ false or missing -> return immediately
       ├─ no SEO outbox
       ├─ no seo_vectors DB/KV read
       ├─ no SEO subprocess/goroutine fan-out
       └─ no Rust Service Binding

ON tenant (only after explicit operator activation)
  committed/rendered content
  -> deterministic outbox
  -> Go Commander background worker
  -> Python FastAPI / Google NLP v2 + deterministic vector profile
  -> isolated seo_vectors
  -> Edge KV snapshot
  -> origin HTML
  -> 4 ms optional KV + Rust/lol_html shadow transform
       ├─ success -> transformed response
       └─ timeout/error/miss -> untouched origin response
```

The 4 ms figure is an **optional transform wait budget after the origin response exists**, not an end-to-end network SLA.

## Module families

- **M001–M050:** existing core/edge SEO contracts preserved.
- **M051–M100:** NLP, entity salience, semantic intent and deterministic vector evidence.
- **M101–M150:** crawl/cache/topology mechanics, sparse link graph, SHA-256 ETags and 304 safety.
- **M151–M200:** cognitive/vector, RUM/CrUX-informed advisory contracts, adaptive delivery evidence and final attestations.

All catalog entries have `request_path_blocking=false`. Policy-sensitive modules remain gated/advisory rather than being force-enabled by the premium switch.

## Operator commands

```bash
./scripts/verify.sh
./scripts/local-mirror-e2e.sh

# Explicit activation of ONE tenant only:
./scripts/deploy-capability.sh <site_id>

# Explicit deactivation of ONE tenant:
./scripts/disable-capability.sh <site_id>
```

External WordPress/Shopify sites are registered in `apps/seo-avengers-reverse-proxy/external-clients.json`; checked-in entries are disabled and Cloudflare routes are generated only for explicit `true` tenants.

See `INTEGRATION_MAP.md` for exact insertion points and `OPERATIONS.md` for deployment details.
