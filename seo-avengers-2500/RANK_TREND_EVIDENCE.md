# WALLE Rank Trend Evidence V1

## Purpose

Rank Feasibility V1 answers a bounded question from the current authorized Search Console snapshot: how far is an observed query/page pair from Top 10, Top 3, or Top 1 under an explicit operator-supplied rule profile?

Rank Trend Evidence V1 adds a separate question: across comparable historical Search Console windows, is the observed average position improving, stable, declining, or still insufficient to evaluate?

It does **not** convert either answer into a Google ranking probability.

## Authorized evidence contract

The existing provider snapshot boundary now accepts the additional Google Search Console dataset:

`search_performance_history_records`

Every record contains exactly:

- `query`
- `page_url`
- `clicks`
- `impressions`
- `average_position_milli`
- `window_start_unix_ms`
- `window_end_unix_ms`

The time interval is interpreted as a half-open window `[start, end)`. Integers are required throughout. Floating-point values, extra fields, invalid ranges, credential-shaped additions, unsupported providers, and digest mismatches fail closed through the same authorized-provider snapshot boundary.

The publisher still performs no Google API call itself. It accepts evidence already obtained through an authorized upstream integration and publishes deterministic, hash-bound records into the existing tenant evidence store.

## Trend profile

The engine requires an explicit hash-bound profile with:

- `minimum_windows`
- `minimum_endpoint_impressions`
- `improving_delta_milli`
- `declining_delta_milli`
- profile ID and provenance

There are no embedded Google ranking constants.

For a query/page pair, duplicate rows for the exact same historical window are aggregated deterministically. Historical windows must then be equal-duration and non-overlapping. This prevents comparing a 7-day window to a 90-day window as though they were equivalent observations.

The earliest and latest eligible windows are compared. Because lower average position is better, positive `positionImprovementMilli` means the observed position improved.

The result is one of:

- `IMPROVING`
- `STABLE`
- `DECLINING`
- `INSUFFICIENT_DATA`

Insufficient history or insufficient endpoint impressions remains explicit rather than being imputed.

## Combined feasibility + trend report

`buildRankFeasibilityWithTrendReport(...)` joins the current Rank Feasibility output to the longitudinal signal by exact normalized `query + page_url` identity.

The combined report is labeled:

`RULE_BOUND_SEARCH_EVIDENCE_WITH_OBSERVED_MOMENTUM_NOT_PROBABILITY`

The key decision boundary is:

`MOMENTUM_CONTEXT_ONLY_DOES_NOT_UPGRADE_FEASIBILITY_BAND`

An improving trend therefore cannot silently turn a `LOW` or `MEDIUM` Top 1 band into `HIGH`. The trend is additional observed context only.

Current opportunities without matching history are emitted with `NO_MATCHING_HISTORY`. Historical opportunities no longer present in the current snapshot are counted explicitly as `historyOnlyOpportunityCount` rather than being mistaken for current opportunities.

## Operational tenant path

`buildTenantRankFeasibilityWithTrend(...)` requires both:

- `search_performance_records`
- `search_performance_history_records`

It consumes them through `readTenantEvidenceSnapshot(...)`, performs the deterministic calculation, then rechecks tenant control and re-reads the evidence manifest. Control movement, kill-switch/authorization changes, or evidence replacement during the calculation returns `STALE` and suppresses the report.

## Explicit non-claims

V1 does not claim:

- probability of Top 10, Top 3, or Top 1;
- time to rank;
- future continuation of current momentum;
- competitor strength;
- backlink/domain authority;
- traffic, lead, client, or revenue guarantees;
- causal SEO lift.

Competition and authority must enter through their own explicit evidence contracts before they can influence any later calibrated rank model.

## Authority boundary

The longitudinal layer has no authority to:

- call or scrape Google Search;
- use provider/OAuth credentials;
- mutate tenant control or clear a kill switch;
- modify a website, CMS, DNS, redirects, links, GBP, or ads;
- activate a real tenant.

No real tenant is connected by this work.
