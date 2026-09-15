# WALLE Opportunity Prioritization V2

Opportunity Prioritization V2 orders evidence-bound SEO opportunities without inventing a Google-rank probability, a 0–100 success score, or hidden weighted coefficients.

## Required inputs

The pure engine consumes:

- an exact `WALLE_RANK_CONTEXT_AUTHORITY_V1` report whose canonical SHA-256 is revalidated;
- aggregate first-party `revenue_funnel_records`;
- the explicit `WALLE_GROWTH_SCENARIO_V1` assumption profile;
- an explicit Opportunity Prioritization V2 policy profile.

The prioritization profile is schema version 1 and contains exactly:

- `profile_id` and `provenance`;
- `scenario_id`: `CONSERVATIVE`, `BASE`, or `UPSIDE`;
- `economic_objective`: `INCREMENTAL_CLIENTS_MILLI` or `INCREMENTAL_REVENUE_MICROS`;
- `minimum_feasibility_band`: `LOW`, `MEDIUM`, or `HIGH`;
- `target_selection_policy`: `HARDEST_UNACHIEVED_AT_OR_ABOVE_MINIMUM_FEASIBILITY`;
- `within_frontier_tie_break_policy`: `ECONOMIC_THEN_FEASIBILITY_THEN_MOMENTUM_THEN_COMPETITION_THEN_IDENTITY`;
- `require_momentum_evidence`;
- `require_competition_evidence`;
- `require_positive_incremental_value`;
- `maximum_candidates`;
- `max_results`.

The profile is canonicalized and SHA-256 bound. There are no `weights_ppm`, band-score tables, or equivalent hidden scalar weights.

## Target selection

For each query/page opportunity, V2 examines `TOP_1`, `TOP_3`, then `TOP_10` and selects the hardest target that is both unachieved and at or above the explicit minimum feasibility band.

`ACHIEVED` targets are not treated as incremental rank work. `INSUFFICIENT_DATA` is never upgraded or filled in. Target position, observed position, observed impressions, gap, feasibility band, and evidence status are cross-validated before selection.

## Economic mechanics

V2 does not duplicate the Growth Scenario business math. For each eligible opportunity it calls `WALLE_GROWTH_SCENARIO_V1` with the exact observed query/page row, normalized aggregate first-party funnel evidence, and the explicit Growth Scenario assumptions.

The engine independently validates the Growth profile and funnel schema before candidate selection, including when zero opportunities are eligible. It then requires its canonical Growth profile SHA-256 to match the normalized SHA-256 returned by Growth Scenario.

Incremental clicks, sessions, leads, client-equivalents, and economic value remain bounded hypothetical scenarios. They are not forecasts or attribution claims.

## Multi-objective prioritization

Each candidate retains four explicit dimensions:

1. selected scenario economic objective value;
2. ordinal rank feasibility;
3. observed longitudinal momentum;
4. authorized competition band.

V2 uses Pareto dominance rather than a weighted sum. Candidate A dominates B only when A is at least as strong on every dimension and strictly stronger on at least one.

The implementation computes deterministic non-dominated Pareto layers in O(n²). `paretoLayer: 1` is the current Pareto frontier. Later layers contain candidates dominated by earlier candidates.

Within the same Pareto layer, the only total-order policy is explicit and hash-bound: economic objective first, then feasibility, momentum, competition, and finally stable query/page/target identity. This tie-break creates deterministic work order; it is not a success probability.

## Authority boundary

Authority Evidence V1 remains global context only. The current evidence contract does not establish a provenance-bound query-to-topic mapping, so topical authority is forbidden as a per-query priority dimension.

A caller that attempts to inject query-level `authority` into an opportunity fails closed. The legacy weighted `priorityScorePpm` field is also explicitly rejected.

## Bounds and integrity

- hard engine candidate maximum: 2,000;
- operator `maximum_candidates` may set a lower explicit cap;
- exceeding the input cap fails closed rather than truncating;
- `max_results` is explicit, and output truncation is reported;
- the full ranked candidate set and returned set are independently SHA-256 bound;
- normalized Growth assumptions and normalized funnel evidence are SHA-256 bound;
- parent Rank Authority bytes are canonical-hash revalidated;
- contradictory target, momentum, or competition evidence fails closed.

## Tenant operational boundary

The tenant wrapper reuses `buildTenantRankContextWithAuthority`, then re-reads the evidence snapshot before prioritization. It requires aggregate `NEXUS_CRM -> revenue_funnel_records` provenance whose record count and canonical SHA-256 match the evidence bytes.

After calculation it rechecks both tenant control generation and evidence manifest. Concurrent authorization/evidence changes produce `STALE`; invalid CRM provenance produces `BLOCKED`; missing/empty required evidence remains `INSUFFICIENT_DATA`.

The layer has no provider network, Google Search scraping, browser/process execution, site/CMS mutation, or tenant-control mutation authority.

## Non-claims

V2 does not claim or guarantee Google rank, rank probability, time-to-rank, traffic, leads, clients, revenue, client quality, or causal SEO lift. Pareto rank is a deterministic decision-support ordering over explicit evidence and assumptions only.
