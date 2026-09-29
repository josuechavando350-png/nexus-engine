# RMC-011 — Capital Census Contract

## Authority

- Protocol/Fork Truth remains immutable and closed at:
  - commit: `5b4a0cb778cb4370cd54eb6fcba765dc8d7cecdf`
  - tree: `ef3498da528f85cdb9fdd82222d64773a557f853`
- This lane starts from Census authority parent:
  - commit: `8ebf6860e0a16964f5293df0ef40695b303b286d`
- RMC-011 is downstream of canonical identity, typed observations, durable evidence, deployment admission, discovery, state, and position truth.
- This PR may build protocol-agnostic Capital Census primitives before D06–D10 close, but it MUST NOT certify final capital feasibility until the upstream market/state/position artifacts it consumes are exact-head and admitted.

## Mission

Create a reproducible, block-pinned, evidence-backed Capital Census that answers, for every actionable candidate:

1. What execution capital is required?
2. Which capital sources were actually available at that block?
3. What is the maximum executable amount from each source?
4. What fees, repayment semantics, collateral, lockups, caps, and failure modes apply?
5. Can the candidate be funded atomically without operator-owned principal?
6. What non-principal funding remains required, including gas, builder deposits, bonds/stakes, and temporarily locked balances?

Zero-own-capital is a constraint to prove, never an assumption.

## Required capital classes

The model MUST represent, without collapsing distinct semantics:

- protocol-native flash loan
- atomic flash liquidity
- flash swap
- transient credit
- collateralized borrowing
- persistent debt
- inventory requirement
- gas funding
- bond/stake requirement
- solver/builder deposit
- intra-block temporary lock

Persistent debt MUST remain distinct from atomic liquidity and MUST carry interest, collateral, liquidation, health-factor / solvency, oracle, liquidity-withdrawal, and facility-disappearance risk where applicable.

## Required source fields

Every admitted capital source record MUST bind:

- canonical source identity
- chain/domain
- provider/protocol
- asset
- block-pinned observation anchor
- maximum_available
- zero-capacity sources remain explicit census records rather than disappearing; zero means observed-but-unavailable at that anchor
- fee model
- repayment semantics
- collateral_required
- liquidation_conditions
- utilization_constraints
- protocol_caps
- market_caps
- same_block_atomicity
- temporary_lock semantics
- failure modes
- evidence references
- code/configuration identity where material

No floating-point representation is permitted for protocol-governed integer amounts, fees, ratios, or caps.

## Required candidate requirement fields

Every candidate capital requirement MUST enumerate all required funding legs, including:

- liquidation / action principal
- gas asset requirement
- protocol fees
- flash / funding fees
- builder / solver deposits where required
- inventory required before transaction admission
- collateral posted or temporarily locked
- persistent debt principal if used
- repayment asset and deadline / atomicity

A candidate is NOT capital-feasible merely because liquidation principal can be flashed.

## Admission and feasibility rules

A source may be used only when:

- deployment/source identity is admitted
- the observation is pinned to the same canonical block context required by the candidate
- available capacity is sufficient at the requested size
- fee/cap semantics are explicit
- repayment can be satisfied under the candidate's execution semantics
- atomicity/collateral requirements are compatible
- no unresolved source mismatch remains

Feasibility MUST fail closed on:

- insufficient capacity
- unsupported asset
- stale or mismatched observation
- unknown fee semantics
- unknown repayment semantics
- unknown protocol / market cap
- collateral requirement not funded
- gas funding absent
- non-atomic requirement where atomicity is required
- persistent-debt solvency model absent
- unclassified capital failure

## Outputs

Target deterministic artifacts:

- `capital-sources.jsonl`
- `capital-requirements.jsonl`
- `capital-feasibility.jsonl`
- `capital-rejection-ledger.jsonl`
- `capital-census-summary.json`
- `capital-evidence-manifest.json`

Every artifact MUST include schema version, exact code commit/tree, observation anchor or block range, source provenance, and SHA-256/content-addressed evidence.

## Required tests

At minimum:

- source identity is deterministic and collision-resistant across chain/provider/asset/class
- same bytes under different capital classes do not alias
- zero and overflow amount/cap edge cases fail correctly
- atomic source cannot silently become persistent debt
- persistent debt cannot pass without collateral/solvency semantics
- gas funding is independently required when execution needs native gas
- insufficient source capacity fails closed
- incompatible repayment asset/semantics fails closed
- protocol and market caps bind maximum executable size
- stale/mismatched anchors fail
- unknown failure reason cannot pass certification
- deterministic canonical encode/decode and tamper rejection
- evidence refs are required for admitted real sources
- synthetic fixtures are explicitly non-evidentiary

## Certification gate

RMC-011 may be certified only when:

- all upstream inputs used by the final run are exact-head admitted artifacts
- every source used for feasibility has reproducible evidence
- zero unexplained source mismatches remain
- zero UNKNOWN failure reasons remain
- full rerun is deterministic
- offline verifier passes
- no downstream profitability, Shadow, Canary, or P&L claim is inferred from capital feasibility alone

Capital feasibility proves funding availability and constraints for each requirement independently. It does NOT prove that multiple individually feasible requirements can be funded concurrently from shared capital sources.

Portfolio-wide simultaneous capacity, source collision, and cross-candidate capital contention remain downstream non-claims until an explicit conflict-set / portfolio-capacity layer certifies them.

Capital feasibility does NOT prove positive net EV, capture probability, or realized P&L.
