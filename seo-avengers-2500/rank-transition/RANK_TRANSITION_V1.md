# WALLE Rank Transition V1

## Purpose

Rank Transition V1 adds a conservative empirical transition layer on top of the certified rank context stack. It does not invent a generic Google-ranking probability and it does not smooth sparse history into a synthetic confidence score.

The engine answers a narrower question:

> Among historical transitions that had the same starting rank state, momentum band, competition band, and internal authority-strength context, how often was each rank target observed after the same explicit horizon?

The output is an empirical historical frequency only. It is not a causal SEO-lift estimate, a Google model, a time-to-rank guarantee, or a confidence interval.

## Inputs

### Current rank context

The current side must be a hash-valid `WALLE_RANK_CONTEXT_AUTHORITY_V1` report produced from the existing rank-feasibility, longitudinal, competition, and authority layers.

The engine uses:

- current observed position and impressions
- momentum band: `IMPROVING | STABLE | DECLINING | INSUFFICIENT_DATA`
- competition band: `LOW | MEDIUM | HIGH | INSUFFICIENT_DATA`
- global internal authority strength: `WEAK | MODERATE | STRONG | INSUFFICIENT_DATA`

Authority remains internal/global context. V1 does not infer a query-to-topic authority mapping and does not treat internal authority as Google authority.

### Historical transition export

`WALLE_RANK_TRANSITION_EXPORT_V1` is an imported, privacy-minimized, hash-bound history contract. Every record contains:

- a transition ID
- a SHA-256 opportunity identity rather than raw historical query/client identity
- the historical rank-context report SHA-256
- context capture time and outcome observation time
- start position and impressions
- outcome position and impressions
- momentum, competition, and authority context captured at the historical start
- an explicit observation-complete flag

The snapshot is bound to:

- site ID
- control generation
- current evidence manifest hash
- source capture SHA-256
- canonical records SHA-256
- snapshot SHA-256

The tenant wrapper rejects cross-tenant snapshots, stale control generations, stale evidence manifests, malformed digests, source-authority drift, and history that claims to be newer than the current authorized evidence snapshot.

## Comparable empirical cohorts

Historical transitions are grouped by the exact tuple:

`start rank state + momentum band + competition band + authority strength`

Starting rank states are deterministic:

- `TOP_1`: position <= 1.000
- `TOP_3`: position <= 3.000
- `TOP_10`: position <= 10.000
- `OUTSIDE_TOP_10`: position > 10.000

There is no fallback across buckets in V1. If the exact comparable cohort is too small, the answer is `INSUFFICIENT_DATA`.

The operator-defined transition profile is hash-bound and requires:

- one exact transition horizon
- minimum comparable transition count
- minimum distinct opportunity count
- minimum start/outcome impressions

The distinct-opportunity requirement prevents repeated observations from one opportunity from pretending to be broad evidence.

## Empirical probability semantics

For a ready cohort and an unachieved target:

`empiricalProbabilityPpm = observed historical successes / accepted comparable transitions`

The output always exposes the raw numerator and denominator:

- `successCount`
- `sampleCount`
- `distinctOpportunityCount`
- `empiricalProbabilityPpm`

No Bayesian prior, Laplace smoothing, interpolation, regression, hidden weighting, or extrapolation is used in V1.

If a target is already achieved in current evidence, V1 emits `ALREADY_ACHIEVED` and does not restate it as a future probability.

## Data-quality exclusions

A historical row is excluded from the empirical sample when:

- `observation_complete` is false
- start impressions are below the profile minimum
- outcome impressions are below the profile minimum

Chronology is fail-closed:

- outcome observation must be after context capture
- every accepted/exported row must match the exact configured horizon
- snapshot observation time must not precede any contained outcome

Duplicate transition IDs and duplicate opportunity-plus-context observations are rejected so sample counts cannot be inflated by duplicate evidence.

## Tenant boundary

`buildTenantRankTransitionModel` first rebuilds the existing authorized rank context through `buildTenantRankContextWithAuthority`.

It then:

1. re-reads the authorized tenant evidence snapshot,
2. confirms control generation and manifest identity did not drift,
3. validates the transition snapshot and exact tenant bindings,
4. confirms historical export time does not exceed the current evidence observation time,
5. builds the empirical transition report,
6. re-reads control and evidence after computation,
7. returns `STALE` if control/evidence moved during the run.

No provider network client, Google scraper, process execution, publishing path, site/CMS mutation, external link creation, or tenant-control mutation authority is added by this layer.

## Status model

### Engine report

- `TRANSITION_READY`: at least one current opportunity has an eligible empirical transition estimate, or is already at the hardest target.
- `INSUFFICIENT_DATA`: no current opportunity has enough exact comparable history.

### Tenant decision

- `READY`: transition report is ready and all control/evidence checks remain stable.
- `INSUFFICIENT_DATA`: evidence is valid but comparable transition history is insufficient.
- `STALE`: control generation or evidence identity changed.
- `BLOCKED`: malformed, unauthorized, cross-tenant, future-dated, or otherwise invalid evidence.

## Explicit non-claims

Rank Transition V1 does **not** claim:

- a Google ranking guarantee
- causal SEO lift
- universal probability of reaching Top 10, Top 3, or Top 1
- a time-to-rank guarantee beyond the exact observed horizon
- a confidence interval
- a calibrated machine-learning model
- Google private ranking signals
- Google/domain authority

Its interpretation string is deliberately explicit:

`EMPIRICAL_HISTORICAL_TRANSITION_FREQUENCY_NOT_CAUSAL_RANK_FORECAST`

## Why this layer exists

Earlier rank layers answer whether an opportunity is currently feasible under explicit rule bands and what observed momentum, competition, and internal authority context exists.

Rank Transition V1 adds the first permitted probability-like quantity only when enough historical comparable observations exist. Sparse history remains sparse history; it is never converted into an invented percentage.

This is the evidence discipline required before a future Decision Engine is allowed to consume transition likelihoods as one constrained input among economic value, capacity, budget, dependencies, risk, and white-hat policy.
