# SEO Avengers 2500 — strict white-hat local growth

This tree is the incremental build toward the final exact M001-M2500 composition.

Current reviewed implementation:
- M001-M1000: delegated to audited `seo-avengers-1000`.
- M1001-M1200: local demand/entity/content intelligence plus strict white-hat firewall.
- M1201-M1300: Local Opportunity Twin — query↔page↔content geometry, long-tail structure, service×location portfolio and funnel-weighted priority indices.
- M1301-M1400: Indexation Readiness / Proof Fusion — upstream technical proof verification, content/search observation readiness, demand-weighted proof risk and M1400 batch certification.
- M1401-M2500: `RESERVED_NOT_EXECUTABLE`; never counted as production capabilities.
- M2501: forbidden.

## Non-negotiable policy

Every local module is `SAFE_WHITE_HAT` and `OBSERVE_ONLY`.

The runtime does not publish pages, mutate client content, create links, scrape Google, call a new provider, write to a database, or require a new API/database/queue/service/cloud resource/secret/credential. Missing evidence returns `INSUFFICIENT_DATA`; malformed or contradictory evidence fails closed.

No module may infer a Google indexing state from absence of search-performance observations. The vocabulary is deliberately `SEARCH_UNOBSERVED` / `CONTENT_NOT_SUPPLIED`, never `UNINDEXED`, unless an authorized upstream producer eventually supplies explicit indexing evidence under its own reviewed contract.

## M1001-M1200

M1001-M1100 — `LOCAL_DEMAND`: ranking-band opportunities, zero-click demand, intent share, query/page fragmentation, Pareto opportunity frontiers, integer Gini concentration, service×location tensors, confidence-aware CTR gaps and click-efficiency lift.

M1101-M1150 — `LOCAL_ENTITY`: NAP/content corroboration, source quorum, query↔entity alignment, evidence completeness, geolocation corroboration and local-demand→page→identity bridges.

M1151-M1175 — `LOCAL_CONTENT`: service/location/commercial/question/urgency coverage and distribution plus co-occurrence/proximity metrics.

M1176-M1200 — `WHITEHAT_POLICY`: doorway/clone/repetition/thin-content/unsupported-location-or-service/identity and information-gain guards. M1200 binds the exact M1176-M1199 receipts and fails closed.

## M1201-M1300 — Local Opportunity Twin

This is an evidence-constrained digital twin of observed local search demand. It does not simulate Google internals and does not promise ranking lift.

Capabilities include:
- query→landing→content support geometry for six intent families;
- long-tail demand bands from short to deep queries;
- service×location portfolio cell coverage, click activity, zero-click exposure, page dispersion and content support;
- Pareto-like portfolio diagnostics and query-overlap/consolidation review signals;
- funnel-weighted opportunity priority using the repository's existing `revenue_funnel_records` contract.

The funnel-weighted indices are explicitly **not revenue forecasts**. They use supplied organic conversion/close/ticket evidence only to prioritize where observed search demand may deserve human review.

## M1301-M1400 — Indexation Readiness / Proof Fusion

This layer consumes the existing `upstream_evidence` contract and recomputes receipt hashes before trusting technical proofs. It verifies 40 concrete predecessor operations spanning canonical, robots, metadata, structured data, visible-text integrity, status/redirect/content parity and human/crawler parity.

It then composes 15 proof bundles, 20 content/search observation-readiness capabilities, 15 demand-weighted proof-risk capabilities, nine fail-closed readiness guards and terminal batch gate M1400.

M1400 requires the exact M1391-M1399 guard receipts plus the M1200 white-hat receipt. Missing/corrupt/error/finding evidence prevents a safe release state.

## Determinism and deduplication

NFC canonical JSON, SHA-256 receipts, int64-bounded integers and PPM fixed-point arithmetic are used. Floats are rejected. Import-time invariants require:
- exact current local range M1001-M1400;
- exact M2001-M2400 source map;
- 400 unique operation names;
- 400 unique functional fingerprints;
- at least 50 distinct analytical kernels;
- all modules white-hat and observe-only.

## Existing data only

This batch reuses existing repository contracts:
- `search_performance_records`
- `content_documents`
- `content_decay_records`
- `local_business_records`
- `revenue_funnel_records`
- `upstream_evidence`

No new external provider is necessary.

## Verification

```bash
bash seo-avengers-2500/scripts/verify.sh
```

The verifier chains `seo-avengers-1000/scripts/verify.sh`, compiles/tests the current suite, and rejects runtime float literals, direct network clients, volatile time/random/UUID calls and `pass` placeholders. Dedicated GitHub Actions checks out the exact event head.

This is deliberately **not** represented as final M001-M2500 certification. M1401-M2500 remain reserved until their reviewed algorithms, evidence contracts, tests and integration exist.
