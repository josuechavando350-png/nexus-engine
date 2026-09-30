# RMC-014 — Real Market Census Terminal Closeout Contract

## Authority

RMC-014 is the only Census layer allowed to emit the formal terminal marker
`REAL_MARKET_CENSUS_CLOSED`.

It is downstream of the immutable RMC-001..RMC-005 truth stack and requires
content-addressed terminal proofs for RMC-006 through RMC-013. A passing unit
test, synthetic fixture, prior head, mutable "latest" artifact, or inferred
success is not terminal authority.

Protocol/Fork Truth remains closed and immutable at:

- commit: `5b4a0cb778cb4370cd54eb6fcba765dc8d7cecdf`
- tree: `ef3498da528f85cdb9fdd82222d64773a557f853`

## Mission

Close Real Market Census only when the repository can prove, from exact
content-addressed evidence, the complete chain:

```
discovery
→ canonicalization
→ state reconstruction
→ economically active / borrowable state
→ exact actionable opportunity derivation
→ zero-own-capital feasibility
→ portfolio conflict/capacity truth
→ execution economics
→ deterministic Shadow handoff
```

RMC-014 is a certification layer. It does not discover markets, size
liquidations, invent capture probability, execute transactions, or claim
realized P&L.

## Required terminal stages

Exactly one admitted proof is required for each:

- RMC-006
- RMC-007
- RMC-008
- RMC-009
- RMC-010
- RMC-011
- RMC-012
- RMC-013

Every stage proof binds:

- exact code commit;
- exact code tree;
- exact artifact SHA-256;
- authority commitment;
- coverage commitment;
- admitted status;
- coverage-complete status;
- unresolved mismatch count;
- UNKNOWN failure count;
- blocker count;
- content-addressed evidence references.

Terminal admission requires:

```
admitted = true
coverage_complete = true
unresolved_mismatch_count = 0
unknown_failure_count = 0
blocker_count = 0
```

## Critical RMC-012 actionability requirement

RMC-011 intentionally preserves the RMC-009 boundary
`LIQUIDATABILITY_NOT_CLAIMED`. Therefore RMC-012 is not terminal authority
merely because its conflict-graph primitives pass synthetic tests.

Before RMC-012 may be pinned as admitted terminal evidence, an exact
liquidation/actionability bridge MUST:

1. consume the admitted D08 state/oracle/configuration bytes;
2. consume the admitted D09 borrower/position bytes;
3. bind the certified PFT liquidation semantics;
4. derive every actionable candidate deterministically;
5. preserve explicit blockers for every rejected borrower/debt/collateral
   combination;
6. emit a coverage commitment proving no below-one borrower or supported
   position disappeared;
7. construct exact capital requirements only after actionability and sizing are
   certified;
8. produce zero unexplained mismatches and zero UNKNOWN reasons.

A D12 proof built only from hand-authored or synthetic `CapitalRequirement`
fixtures is FOUNDATION evidence and MUST NOT satisfy RMC-014.

## Critical RMC-013 economics requirement

RMC-013 terminal evidence must consume the real RMC-012 candidate set and cover
every execution-simulatable candidate with exact economics.

Required economic truth includes:

- complete cost taxonomy;
- cost incidence split into unconditional / on-capture / on-failure;
- exact gas valuation;
- exact route/price-impact/fee evidence where applicable;
- nonlinear measured/simulated size curves;
- explicit tail reserve/evidence;
- deterministic pre-capture prediction commitment;
- no interpolation or extrapolation beyond measured curve points;
- no invented capture probability.

Capture calibration may legitimately remain absent at RMC close. In that case
RMC-013 must hand the exact ex-ante prediction to Shadow and MUST NOT label
capture-adjusted profitability as empirically proven.

## Pipeline conservation

RMC-014 keeps two population domains separate. A market is not an opportunity:
one borrowable market may contain many borrowers and one borrower may expose
multiple debt/collateral execution candidates. Treating the whole Census as one
monotonic counter would therefore undercount or fabricate conservation.

The **market funnel** is non-increasing:

```
markets_discovered
>= markets_canonicalized
>= markets_state_reconstructable
>= markets_economically_active
>= markets_borrowable
```

The **opportunity/candidate funnel** is independently non-increasing:

```
actionable_candidates
>= capital_feasible_candidates
>= execution_simulatable_candidates
>= positive_gross_value_candidates
>= positive_success_path_net_candidates
>= capacity_material_candidates
>= shadow_eligible_candidates
```

No artificial inequality is imposed between `markets_borrowable` and
`actionable_candidates`. Their relationship is instead proved by the
RMC-012 actionability coverage commitment over the exact borrower/position
universe.

The RMC-012 real actionability candidate count must equal
`actionable_candidates`.

The RMC-013 exact economics quote count must equal
`execution_simulatable_candidates`.

The deterministic Shadow prediction count must equal
`shadow_eligible_candidates`.

Capture-adjusted and tail-adjusted expected-value counts are deliberately NOT
part of the RMC monotonic funnel. RMC-013 may close with capture calibration
absent; Shadow Execution is the empirical authority that observes competitor
arrival, inclusion and miss outcomes and calibrates capture probability.
Therefore requiring positive capture-adjusted or tail-adjusted EV before Shadow
would either fabricate a probability or circularly require Shadow evidence to
close Census. RMC closes on exact success-path economics plus deterministic
Shadow handoff; capture-adjusted/tail-adjusted gates belong to Shadow.

## OWN_CAPITAL = 0

If `capital_feasible_candidates > 0`, the terminal evidence must prove that no
operator-owned capital was used to make any such opportunity feasible.

A zero-opportunity census may close without fabricating
`zero_own_capital_proven=true`; it simply makes no opportunity-level
zero-own-capital feasibility claim.

## Profitability boundary

RMC-014 MUST NOT claim either:

- realized profitability; or
- `P(monthly_net_pnl >= 45,000 USD) >= 0.90`.

Those claims require empirical Shadow/Canary/real-P&L evidence.

The $1,500–$3,000/day and $45,000+/month figures remain falsifiable economic
targets, never closeout assumptions.

RMC may close while those targets remain unproven, lower than desired, or even
falsified. Truth has priority over the target.

## Determinism

The terminal commitment is input-order independent and binds:

- all eight exact terminal stage proofs;
- all pipeline counts;
- the economic boundary;
- terminal evidence refs.

Changing any admitted artifact, code identity, coverage commitment, count or
economic boundary must change the terminal commitment.

## Formal marker

The literal marker:

`REAL_MARKET_CENSUS_CLOSED`

may appear as a certified state only after every requirement above passes.

Until then:

`REAL_MARKET_CENSUS_CLOSED = false`

No workflow, PR body, comment or summary may infer closure from partial green
checks.

## Terminal certificate materialization

The source authority lock is schema version 2 and never self-certifies closure.
When `status=PINNED`, it MUST additionally bind:

- a non-empty evidence array for every RMC-006..RMC-013 stage proof;
- the complete market and opportunity pipeline counts;
- the economic boundary consumed by the closeout verifier; and
- non-empty terminal evidence commitments.

The terminal workflow authenticates the exact GitHub run/artifact identities
before materialization. It then executes the Rust closeout verifier twice from
the same pinned lock and requires byte-identical output. The verifier calls the
same `CloseoutCertificate::certify` invariants tested by the crate; a Python or
shell summary cannot manufacture the terminal marker independently.

The generated immutable archive contains:

- `real-market-census-certificate.json`;
- `real-market-census-certificate.sha256`.

Only the generated certificate may set
`real_market_census_closed=true` and emit `REAL_MARKET_CENSUS_CLOSED`.
Its terminal commitment binds all eight stage proofs, pipeline counts, economic
boundary and terminal evidence. The generated certificate must keep realized
profitability and the monthly-target probability explicitly false; those remain
downstream Shadow/Canary/P&L claims.
