# WALLE Rank Feasibility Engine V1

## Purpose

Rank Feasibility V1 answers a narrow question from authorized Search Console evidence:

> Given the observed impression-weighted position of a query/page pair, how close is that observation to Top 10, Top 3 and Top 1 under an explicit operator-supplied distance policy?

It does not predict Google, assign a probability of ranking, estimate time-to-rank, or guarantee a target position.

## Interpretation

Every report is labeled:

`RULE_BOUND_SEARCH_EVIDENCE_NOT_PROBABILITY`

The output bands are:

- `ACHIEVED`: the observed impression-weighted position is already within the target.
- `HIGH`: the observed gap is positive and no larger than the explicit `high_gap_milli` assumption.
- `MEDIUM`: the gap is larger than the high band and no larger than the explicit `medium_gap_milli` assumption.
- `LOW`: the gap is larger than the explicit medium band.
- `INSUFFICIENT_DATA`: the query/page pair does not meet the explicit minimum-impression requirement.

`HIGH`, `MEDIUM` and `LOW` are deterministic policy bands. They are not calibrated probabilities.

## Evidence

V1 consumes only the existing authorized `search_performance_records` dataset:

- `query`
- `page_url`
- `clicks`
- `impressions`
- `average_position_milli`

Duplicate query/page observations are aggregated deterministically. Position is weighted by impressions. CTR is reported as integer PPM.

The operational wrapper consumes `readTenantEvidenceSnapshot(...)`, then rechecks both tenant control and the evidence manifest after calculation. Control generation movement or evidence replacement returns `STALE` and suppresses the report.

## Explicit assumption profile

The caller must provide:

- `schema_version`
- `profile_id`
- `provenance`
- `minimum_impressions`
- `high_gap_milli`
- `medium_gap_milli`

The profile is canonicalized and SHA-256 bound into the report. There are no hidden default distance bands.

## V1 limitations

V1 deliberately does not use or fabricate:

- competitor strength;
- longitudinal rank trend;
- backlink/authority estimates;
- SERP composition;
- content-quality scores;
- a probability of Top 10 / Top 3 / Top 1;
- time-to-rank.

Those signals require additional authorized, auditable evidence before they can influence feasibility. Until then they remain explicit limitations rather than guessed inputs.

## Safety and authority

The feasibility layer has no authority to:

- call Google or another provider;
- scrape Google Search;
- use OAuth/provider credentials;
- enable/disable tenant control;
- mutate a website, CMS, DNS, redirects, links, GBP or ads.

No real tenant is connected by this change. Cano, SOMA and Nexus Bot Studio remain outside the path.

## Relationship to Growth Scenario

Rank Feasibility and Growth Scenario answer different questions:

- Rank Feasibility: how close is observed search evidence to a target under an explicit rule policy?
- Growth Scenario: if a target rank bucket is assumed, what bounded downstream click/session/lead/client-equivalent/economic scenario follows?

A later Opportunity Prioritization layer may join both outputs. V1 does not automatically convert a feasibility band into a traffic or revenue forecast.
