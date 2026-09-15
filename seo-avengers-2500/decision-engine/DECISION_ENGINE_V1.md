# WALLE Decision Engine V1

## Purpose

Decision Engine V1 is the evidence gate between analysis/prioritization and the future Optimization Problem Builder.

It does **not** execute SEO changes, choose a budget-constrained portfolio, or invent a success score. Its job is narrower and auditable:

> A prioritized opportunity may be promoted into the optimization layer only when its selected rank target has an empirical comparable transition frequency and the exact current Growth Scenario assumption profile has sufficient historical outcome-calibration evidence.

The fixed policy is:

`PROMOTE_ONLY_WITH_PRIORITIZATION_EMPIRICAL_TRANSITION_AND_EXACT_PROFILE_CALIBRATION`

There is no operator-defined hidden weighting in V1.

## Required upstream reports

Decision Engine V1 consumes three existing, hash-valid reports:

1. `WALLE_OPPORTUNITY_PRIORITIZATION_V2`
2. `WALLE_RANK_TRANSITION_V1`
3. `WALLE_OUTCOME_CALIBRATION_V1`

Every report hash is recomputed before use. A copied or stale hash cannot authorize a decision.

### Shared rank-context binding

The prioritization report carries the exact `rankAuthorityReportSha256` used to create its candidates.

The transition report carries the exact `currentRankContextReportSha256` used to create its empirical transition estimates.

Decision Engine requires those hashes to match. It will not combine prioritization from one rank-context snapshot with transition frequencies applied to a different current rank-context snapshot.

## Prioritization input

The engine preserves the upstream Pareto decision boundary. It does not replace Pareto layers with a scalar score.

For every returned prioritization candidate it preserves:

- query and page identity
- explicit priority rank
- Pareto layer/frontier membership
- selected Top 10 / Top 3 / Top 1 target
- feasibility band and gap
- economic objective ID
- bounded scenario value
- exact Growth Scenario assumption-profile SHA-256

The bounded economic scenario remains hypothetical. Decision Engine does not rewrite it into a forecast.

## Empirical rank-transition requirement

For the exact query/page and selected target, the corresponding Rank Transition V1 target must be:

`EMPIRICAL_TRANSITION_FREQUENCY_READY`

The decision output preserves:

- explicit transition horizon
- success count
- sample count
- distinct-opportunity count
- empirical probability in fixed-point PPM

If the exact target lacks a ready comparable cohort, the opportunity becomes:

`HOLD_FOR_EVIDENCE`

No interpolation, smoothing, cross-cohort fallback, or invented probability is permitted.

## Exact Growth Scenario calibration requirement

Global calibration readiness is not enough.

Decision Engine filters Outcome Calibration accepted records to the exact pair:

- current prioritization `scenarioId`
- current `growthAssumptionProfileSha256`

The exact profile/scenario sample must contain at least the calibration profile's declared `minimumRecords`.

If it does not, candidates are held even when Outcome Calibration has enough records globally from other assumption profiles.

This prevents historical calibration of one model configuration from being silently applied to another.

## Calibration is a qualifier, not a correction

For the exact matched records, Decision Engine exposes descriptive absolute-error statistics for:

- lead conversion PPM
- close-rate PPM
- average ticket micros

The report includes nearest-rank P50/P90 and maximum absolute error where evidence exists.

Those values are context only. V1 does not:

- modify the scenario economic value
- generate an accuracy score
- produce a confidence interval
- create a causal lift estimate
- multiply economic value by rank probability into a hidden expected-value score

The explicit boundary is:

`CALIBRATION_QUALIFIES_EVIDENCE_BUT_DOES_NOT_REWRITE_SCENARIO_VALUE`

## Decision semantics

Each candidate receives one of two statuses.

### `PROMOTE_TO_OPTIMIZATION`

All required evidence is ready:

- candidate exists in Opportunity Prioritization V2
- exact selected target has a ready empirical transition frequency
- exact current Growth Scenario assumption profile/scenario has sufficient calibration history

### `HOLD_FOR_EVIDENCE`

At least one required evidence gate is missing.

Reasons are explicit, currently:

- `EMPIRICAL_TRANSITION_NOT_READY`
- `EXACT_GROWTH_PROFILE_CALIBRATION_NOT_READY`

The engine report is `DECISION_READY` when at least one candidate is promoted. Otherwise it is `INSUFFICIENT_DATA`.

## No autonomous action

Promotion means only that the candidate is allowed to enter the future Optimization Problem Builder.

It is **not** authorization to:

- modify a website or CMS
- create pages
- create external links
- spend money
- publish content
- change tenant control state
- execute a provider/network action

The Optimization Problem Builder must still model budget, capacity, dependencies, risk, white-hat policy and action constraints before any portfolio can be selected.

## Tenant composition

`buildTenantDecisionReport` composes the real upstream tenant boundaries rather than accepting disconnected green badges.

It executes:

1. tenant Opportunity Prioritization
2. tenant Outcome Calibration
3. tenant Rank Transition
4. cross-check of common control generation and evidence manifest
5. Decision Engine report construction
6. final control re-read
7. final evidence re-read

Any control/evidence drift becomes `STALE`.

Blocked/off upstream layers are never promoted. Calibration and transition may return valid `INSUFFICIENT_DATA` reports; Decision Engine uses those reports to produce explicit holds rather than fabricating readiness.

## Security and capability boundary

Decision Engine V1 adds no:

- provider network client
- Google Search scraper
- browser/process execution
- publishing path
- site/CMS mutation authority
- external-link creation authority
- tenant-control mutation authority

It reads current authorized evidence through existing tenant boundaries and produces an immutable decision-support report only.

## Explicit non-claims

Decision Engine V1 does **not** claim:

- Google ranking guarantee
- causal SEO lift
- future lead/client/revenue guarantee
- calibrated universal rank probability
- time-to-rank guarantee beyond the exact empirical transition horizon
- confidence intervals
- Google private ranking signals
- autonomous SEO execution
- a solved budget/capacity portfolio

Its interpretation is:

`EVIDENCE_GATED_OPTIMIZATION_ELIGIBILITY_NOT_AUTONOMOUS_ACTION_OR_OUTCOME_FORECAST`

Its downstream boundary is:

`NO_HIDDEN_SCORE_NO_AUTONOMOUS_SITE_ACTION_OPTIMIZATION_BUILDER_MUST_ENFORCE_BUDGET_CAPACITY_DEPENDENCIES_RISK_AND_POLICY`

## Why this layer exists

Earlier layers answer different questions:

- Rank Feasibility: is a target mechanically plausible under explicit evidence rules?
- Trend / Competition / Authority: what observed context exists?
- Opportunity Prioritization: which opportunities dominate others across explicit economic/feasibility dimensions without hidden weights?
- Outcome Calibration: how wrong have modeled funnel components been historically?
- Rank Transition: how often did exact comparable rank states reach specific targets over a fixed horizon?

Decision Engine V1 connects those answers without pretending they are stronger than the evidence.

The next layer, Optimization Problem Builder, may use promoted candidates to construct a formal portfolio problem with explicit decision variables, objective terms and constraints. Decision Engine itself stops before that boundary.
