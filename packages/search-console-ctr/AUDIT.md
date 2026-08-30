# Search Console CTR engineering audit

Status: implementation candidate; exact-head CI required before merge.

## Capability 2/20

Uses authorized first-party Search Console Search Analytics rows to build a deterministic site-specific CTR diagnostic curve and identify observational CTR opportunities.

## Fail-closed invariants

- API absence/credential absence is `UNAVAILABLE`, never PASS-by-fixture.
- HTTP/provider errors and malformed rows are `FAIL`.
- clicks, impressions, CTR and position must be finite and internally consistent.
- CTR must stay in [0,1], clicks cannot exceed impressions, and row keys must match requested dimensions.
- Search Analytics coverage is always labeled `TOP_ROWS_NOT_GUARANTEED_COMPLETE` because Google does not guarantee complete row retrieval.
- The fitted curve is impression-weighted PAVA and monotonic non-increasing by rounded position.
- zero baseline CTR yields `relativeCtrDelta = null`; Infinity/NaN are forbidden by canonicalization.
- opportunity results are explicitly `OBSERVATIONAL_NOT_CAUSAL`.
- analysis is digest-bound to the source dataset and can be deterministically replayed.

## Real provider surface

`fetchSearchAnalytics()` targets `POST https://www.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query`, uses bearer OAuth, validates documented rowLimit/startRow constraints and rejects malformed responses.

## Acceptance

Package lint/typecheck/test/build and all four NEXUS exact-head workflows must pass. Final diff must stay scoped to Capability 2 plus workspace metadata, with no TODO/FIXME/placeholders/mock production adapters.
