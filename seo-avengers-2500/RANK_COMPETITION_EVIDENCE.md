# Rank Competition Evidence V1

## Purpose

Rank Competition Evidence V1 adds explicit competitive context to WALLE Rank Feasibility without turning competitor observations into a Google ranking probability, domain-authority score, traffic forecast, or causal SEO claim.

The layer is evidence-bound and fail-closed. It reuses the existing Avengers `keyword_coverage_records` contract already consumed by M301/M302 rather than creating a parallel competitive ontology.

## Authorized dataset

The authorized provider snapshot boundary accepts this pair:

- provider: `NEXUS_COMPETITIVE_SNAPSHOT`
- dataset: `keyword_coverage_records`

Each record has exactly:

- `keyword`
- `site_ranked`
- `competitor_ranked_count`
- `search_volume`

The dataset additionally requires provenance on the dataset descriptor:

- `source_authority`
- `source_capture_sha256`

`source_authority` identifies the explicitly authorized upstream observation/export authority. `source_capture_sha256` binds the normalized dataset to the exact upstream artifact supplied by that authority. Avengers does not fetch that artifact and does not receive provider credentials.

The existing provider boundary still requires a canonical `records_sha256`, validates exact row schemas, rejects floats/extra fields, and publishes the resulting evidence under the tenant evidence manifest.

## Competition engine

`rank-feasibility/competition-engine.mjs` exposes:

- `buildRankCompetitionReport(...)`
- `buildRankFeasibilityTrendCompetitionReport(...)`

The standalone competition engine normalizes keyword identity deterministically and classifies observed competitive pressure as:

- `LOW`
- `MEDIUM`
- `HIGH`
- `INSUFFICIENT_DATA`

Thresholds are not Google constants. They come from an explicit operator-supplied assumption profile containing:

- `minimum_search_volume`
- `low_competitor_count_max`
- `medium_competitor_count_max`
- profile identity and provenance

The canonical profile is SHA-256 bound into the report.

Conflicting normalized duplicate keyword observations fail closed. Equivalent duplicate observations collapse deterministically. Input ordering must not change report bytes or report hash.

## Combined rank context

The combined engine joins the existing current-position + longitudinal trend report to competitive keyword evidence by normalized keyword identity.

Critical decision boundary:

`COMPETITION_CONTEXT_ONLY_DOES_NOT_UPGRADE_OR_DOWNGRADE_FEASIBILITY_BAND`

Competition therefore remains evidence context. V1 does not silently mutate the existing Top 10 / Top 3 / Top 1 feasibility band.

Current search queries without a matching competition record are retained with explicit `INSUFFICIENT_DATA` competition context. Competition-only keywords are counted rather than silently dropped.

## Operational tenant path

`rank-feasibility/tenant-competition.mjs` exposes `buildTenantRankContextWithCompetition(...)`.

It:

1. reads the existing revalidated tenant evidence snapshot;
2. requires current Search Console, longitudinal Search Console, competitive keyword coverage, and upstream provenance;
3. requires exactly one valid competition provenance record;
4. recomputes the canonical SHA-256 of `keyword_coverage_records` and requires it to match `upstream_evidence.records_sha256`;
5. builds the combined rank context;
6. re-reads tenant control;
7. re-reads the evidence snapshot;
8. returns `STALE` and suppresses the report if control generation or evidence manifest moved during evaluation.

Missing required datasets return `INSUFFICIENT_DATA`. Invalid provenance or invalid model input fail closed.

## Non-authority and safety

This layer has no authority to:

- call or scrape Google Search;
- use Search Console, ads, browser, provider, OAuth, access-token, or refresh-token credentials;
- mutate tenant authorization or kill switches;
- mutate website, CMS, DNS, redirects, links, Google Business Profile, ads, or external sites;
- activate a production tenant.

Warnings explicitly preserve these non-claims:

- no rank guarantee;
- no ranking probability claim;
- no time-to-rank claim;
- competitor count is not domain authority;
- search volume is not a traffic forecast;
- no causal SEO-lift claim.

## What V1 does not prove

Competition Evidence V1 does not prove that a query will reach Top 10, Top 3, or Top 1. It does not estimate a calibrated probability and does not infer competitor authority from count alone.

A calibrated transition probability requires outcome history plus additional independently evidenced signals. Authority Evidence is intentionally a separate future layer.
