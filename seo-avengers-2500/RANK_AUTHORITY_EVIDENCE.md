# WALLE Rank Authority Evidence V1

## Purpose

Rank Authority Evidence V1 adds **internal topical authority context** to the existing WALLE rank context. It does not claim Google authority, Domain Authority, PageRank, backlink equity, rank probability, time-to-rank, or ranking causality.

The source contract is the existing NEXUS topical-authority diagnostic. Its non-claim must remain exactly:

`INTERNAL_TOPICAL_AUTHORITY_DIAGNOSTIC_NOT_SEARCH_ENGINE_RANKING_EVIDENCE`

## Evidence contract

Authorized authority snapshots publish the dataset `topical_authority_records` under provider `NEXUS_AUTHORITY_SNAPSHOT`.

Each record has exactly:

- `topic_id`
- `assessment_status`: `READY`, `NEEDS_WORK`, or `BLOCKED`
- `coverage_ppm`
- `intent_coverage_ppm`
- `primary_evidence_ppm`
- `cohesion_ppm`
- `centrality_ppm`
- `authority_ppm`
- `source_non_claim`

All metrics are integer parts-per-million in `[0, 1_000_000]`. Floating-point values are rejected rather than rounded.

The provider dataset is provenance-bound with:

- canonical `records_sha256`
- `source_authority`
- `source_capture_sha256`
- capture ID and observed timestamp recorded in `upstream_evidence`

The tenant wrapper recomputes the canonical records digest before accepting authority provenance.

## Classification

The operator supplies an explicit, hash-bound authority profile containing:

- `minimum_topics`
- `weak_authority_ppm_max`
- `moderate_authority_ppm_max`

The engine reports `WEAK`, `MODERATE`, `STRONG`, or `INSUFFICIENT_DATA`. These bands are NEXUS decision-support bands, not Google constants.

A source assessment of `BLOCKED` is never promoted into an authority report.

## Rank boundary

Authority V1 is intentionally contextual only.

`AUTHORITY_CONTEXT_ONLY_DOES_NOT_UPGRADE_OR_DOWNGRADE_FEASIBILITY_BAND`

The existing Top 10 / Top 3 / Top 1 feasibility, momentum, and competition fields are carried forward unchanged. V1 does not infer a query-to-topic relationship from query text. A future semantic/cluster layer may bind queries to authority topics only when that mapping is explicit and evidence-bound.

## Operational path

`buildTenantRankContextWithAuthority(...)`:

1. consumes the already revalidated competition rank context;
2. requires the same evidence manifest and control generation;
3. requires non-empty `topical_authority_records`;
4. validates authority provenance and recomputes the canonical records SHA-256;
5. builds the pure authority report;
6. attaches authority as context without mutating rank bands;
7. rereads tenant control and evidence before release;
8. returns `STALE` if control/evidence changes during the operation.

The authority engine and tenant wrapper have no provider-network, process-escape, site-mutation, or tenant-control mutation authority.

## Explicit non-claims

V1 carries explicit warnings for:

- no rank guarantee;
- no rank probability claim;
- internal authority is not Google authority;
- not Domain Authority;
- no backlink authority claim;
- no external link-equity claim;
- no time-to-rank claim;
- no causal SEO-lift claim.

Calibrated ranking probability remains deferred until sufficient longitudinal outcomes and additional evidence are available.
