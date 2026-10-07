# RMC-014 — Structural Census Chain Contract

## Authority boundary

RMC-014 authenticates the exact structural chain from RMC-006 through RMC-013.

RMC-014 MUST NOT emit the formal marker `REAL_MARKET_CENSUS_CLOSED`, set
`real_market_census_closed=true`, or otherwise represent the Real Market Census
as terminally closed.

Final Census authority is reserved for RMC-017 and is reachable only after:

1. RMC-014 has certified the structural RMC-006..RMC-013 chain;
2. RMC-015 has certified temporal opportunity authority from complete,
   censored, no-look-ahead historical episodes; and
3. RMC-016 has certified conservative non-double-counted physical/economic
   capacity over those episodes.

Until RMC-017 independently authenticates all three authority families:

`REAL_MARKET_CENSUS_CLOSED = false`

Protocol/Fork Truth remains immutable at commit
`5b4a0cb778cb4370cd54eb6fcba765dc8d7cecdf` and tree
`ef3498da528f85cdb9fdd82222d64773a557f853`.

## Mission

RMC-014 proves that the structural Census evidence chain is internally
consistent, content-addressed, reproducible and fail-closed:

```
discovery
→ canonicalization
→ state reconstruction
→ account/position truth
→ capital-source truth
→ actionability and conflict truth
→ exact execution economics
→ deterministic Shadow handoff
```

This is necessary but not sufficient for final Census closure. A structural
snapshot does not prove temporal arrival rate, opportunity lifetime,
time-to-first-competitor, recurrence, censoring, regime dependence, or
conservative daily/monthly capacity.

## Required structural stages

Exactly one admitted proof is required for each of RMC-006 through RMC-013.

Every stage proof binds the exact code commit/tree, canonical workflow name,
workflow run id, artifact id/name/digest, authority commitment, coverage
commitment, admission state, mismatch/UNKNOWN/blocker counts and a non-empty
content-addressed evidence set.

Structural admission requires, for every stage:

```
admitted = true
coverage_complete = true
unresolved_mismatch_count = 0
unknown_failure_count = 0
blocker_count = 0
```

Mutable "latest successful", synthetic substitutions, hand-authored authority
claims and artifacts from non-canonical workflows are forbidden.

## Structural pipeline conservation

RMC-014 keeps market and opportunity populations separate.

Market funnel:

```
markets_discovered
>= markets_canonicalized
>= markets_state_reconstructable
>= markets_economically_active
>= markets_borrowable
```

Opportunity funnel:

```
actionable_candidates
>= capital_feasible_candidates
>= execution_simulatable_candidates
>= positive_gross_value_candidates
>= positive_success_path_net_candidates
>= capacity_material_candidates
>= shadow_eligible_candidates
```

No artificial inequality is imposed between borrowable markets and actionable
candidates. Their identity relationship is carried by the RMC-012 coverage
commitment.

RMC-013 economics coverage must exactly match the execution-simulatable
candidate set. Shadow-handoff counts must be internally conserved.

## OWN_CAPITAL = 0

If capital-feasible candidates exist, structural certification requires the
upstream evidence to prove that operator-owned capital was not used to make
those candidates feasible.

This is a source/feasibility fact, not a profitability claim.

## Economic scope boundary

RMC-014 may bind exact pre-capture execution economics produced by RMC-013.
It does not certify realized capture probability or realized income.

The structural certificate MUST preserve:

```
realized_profitability_proven = false
monthly_target_probability_proven = false
conservative_realizable_capacity_only = true
global_capital_source_completeness_claimed = false
global_route_venue_completeness_claimed = false
```

The current Month-1 USD 300,000 floor is a falsifiable target. It is not an
input to structural certification and cannot be inferred from RMC-014.

## Explicit non-authorities

RMC-014 does not certify:

- temporal opportunity arrival rates;
- opportunity lifetime or censoring;
- competitor-arrival latency;
- recurrence or regime dependence;
- temporal conflict scheduling;
- daily/monthly conservative capacity;
- empirical capture probability;
- Shadow capture performance;
- Canary performance;
- realized P&L;
- Month-1 target reliability.

Those facts are downstream.

## Determinism

The RMC-014 structural commitment is input-order independent and binds all
eight stage proofs, structural pipeline counts, the economic scope boundary and
the structural evidence references.

Changing any admitted artifact, code identity, stage coverage commitment,
count or bound scope must change the structural commitment.

## Structural marker

A successful RMC-014 materialization emits only:

`RMC_014_STRUCTURAL_CHAIN_CERTIFIED`

The generated archive contains:

- `rmc014-structural-certificate.json`;
- `rmc014-structural-certificate.sha256`.

The certificate MUST contain:

```
status = RMC_014_STRUCTURAL_CHAIN_CERTIFIED
structural_chain_certified = true
real_market_census_closed = false
final_census_authority_stage = RMC-017
downstream_authorities_required = [RMC-015, RMC-016, RMC-017]
```

The source authority lock remains unable to self-certify either structural or
final closure. When `status=PINNED`, the workflow independently
re-authenticates every exact GitHub run/artifact/head/tree/digest before the
Rust structural verifier is executed twice from identical bytes.

Any code path, workflow assertion, test, artifact or summary that allows
RMC-014 to emit `REAL_MARKET_CENSUS_CLOSED` is a certification failure.
