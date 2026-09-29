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

Zero-own-capital is a constraint to prove, never an assumption. Provider kind/class MUST NOT be used as a proxy for economic ownership; every admitted source carries explicit ownership, and any `OPERATOR_OWNED` source is ineligible for zero-own-capital feasibility regardless of provider kind or capital class.

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
- capital_ownership (`EXTERNAL` or `OPERATOR_OWNED`), independently of provider kind/class
- asset
- block-pinned observation anchor
- maximum_available
- zero-capacity sources remain explicit census records rather than disappearing; zero means observed-but-unavailable at that anchor
- observed/effective capacity and executable capacity are distinct: upstream execution blockers MUST NOT erase observed liquidity, but executable capacity MUST be zero while any blocker remains
- execution blocker codes are preserved exactly; blocker-state changes alter the observation-specific source ID but MUST NOT alter the stable source key
- fee model
- repayment semantics
- collateral_required
- liquidation_conditions
- utilization_constraints
- protocol_caps
- market_caps
- utilization limits, minimum-remaining reserves, protocol caps, market caps, and observed availability are independent upper bounds on the same executable draw; effective capacity is their minimum and MUST NOT compound them by scaling a cap or subtracting a reserve floor after scaling
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

- every consumed upstream byte is bound through the upstream stage's admitted evidence manifest; for RMC-008 the authority artifact digest identifies `evidence-manifest.json`, whose exact code commit/tree and per-file SHA-256/size entries MUST match `market-state-manifest.jsonl`, `token-admission.jsonl`, and `pool-and-factory-facts.json` before import
- the same byte-binding rule applies to RMC-009: its authority artifact digest identifies `evidence-manifest.json`; the manifest and `account-summary.json` must name the exact admitted code commit/tree, and the manifest SHA-256/size entries for `account-manifest.jsonl` and `account-summary.json` must match before borrower demand import
- the verified RMC-008 source import and RMC-009 borrower-demand import MUST each emit a deterministic consumption receipt binding their coverage commitment to the exact admitted upstream authority artifact
- each receipt MUST also bind the exact consumed output set: sorted source IDs for RMC-008 and sorted certified requirement IDs for RMC-009, together with an exact output count; final certification MUST recompute those sets from the ledger and reject any missing, extra, substituted, or duplicated output
- merely listing an admitted RMC-008 or RMC-009 authority is insufficient: certification MUST fail if either consumed-input receipt is absent, duplicated, references the wrong stage, references a different authority artifact, or does not equal the ledger output set
- deployment/source identity is admitted
- the observation is pinned to the same canonical block context required by the candidate
- executable capacity, not merely observed capacity, is sufficient at the requested size
- no execution blocker remains on any allocated source
- fee/cap semantics are explicit
- repayment can be satisfied under the candidate's execution semantics
- exact repayment and funding-fee settlement obligations derived from the actual source allocations equal the declared settlement legs before the candidate may be labeled `FEASIBLE`
- settlement legs must authorize the actual capital-source classes that generated those obligations; matching only kind, asset, and amount is insufficient
- atomicity/collateral requirements are compatible
- no unresolved source mismatch remains

Feasibility MUST fail closed on:

- insufficient capacity
- observed capital blocked from execution by unresolved upstream semantics
- unsupported asset
- stale or mismatched observation
- unknown fee semantics
- unknown repayment semantics
- settlement requirement mismatch, including wrong repayment amount, wrong settlement asset, missing funding fee, an extra settlement leg, or a settlement leg that does not authorize the allocated source class
- unknown protocol / market cap
- collateral requirement not funded, including the aggregate collateral required by every distinct source allocated to the candidate
- temporary-lock requirement not funded, including the aggregate lock amount required by every distinct source allocated to the candidate
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
- `capital-upstream-authority.json`
- `capital-evidence-manifest.json`

Every artifact MUST include schema version, exact code commit/tree, observation anchor or block range, source provenance, and SHA-256/content-addressed evidence.

## Required tests

At minimum:

- source identity is deterministic and collision-resistant across chain/provider/asset/class
- same bytes under different capital classes do not alias
- zero and overflow amount/cap edge cases fail correctly; public enum/struct construction cannot bypass the same fee, ratio, repayment-deadline, collateral, utilization, temporary-lock, or nonzero-evidence validations enforced by canonical decode
- atomic source cannot silently become persistent debt
- persistent debt cannot pass without collateral/solvency semantics
- collateral and temporary-lock dependencies are aggregated across all distinct sources used by one candidate; one declared leg cannot be reused to satisfy multiple source dependencies
- gas funding is independently required when execution needs native gas, and the `requires_native_gas` flag must equal the presence of a native-gas requirement leg in both directions
- insufficient source capacity fails closed
- incompatible repayment asset/semantics fails closed
- exact repayment/funding-fee settlement mismatch, including source-class provenance mismatch, is classified as a feasibility rejection rather than surviving as a provisional `FEASIBLE` result until certification
- protocol and market caps bind maximum executable size
- stale/mismatched anchors fail
- unknown failure reason cannot pass certification
- deterministic canonical encode/decode and tamper rejection
- evidence refs are required for admitted real sources
- synthetic fixtures are explicitly non-evidentiary

## Certification gate

Foundation artifacts MUST encode `real_source_certification=false` until every real source class used by feasibility has a semantic admission path that proves the source terms from content-addressed evidence. An admitted artifact hash alone is not proof that arbitrary source semantics (especially external gas funding, credit, collateral facilities, builder deposits, or persistent debt risk terms) were present in that artifact.

RMC-011 may be certified only when:

- all upstream inputs used by the final run are exact-head admitted artifacts
- exact RMC-008 and RMC-009 consumption receipts are present and their coverage commitments, output counts, and output-set commitments are bound into `capital-upstream-authority.json` and its commitment
- every source used for feasibility has reproducible evidence
- zero unexplained source mismatches remain
- zero UNKNOWN failure reasons remain
- full rerun is deterministic
- offline verifier passes
- no downstream profitability, Shadow, Canary, or P&L claim is inferred from capital feasibility alone

RMC-009 explicitly does not certify liquidatability. Therefore a fully admitted upstream run may legitimately contain zero actionable capital requirements. In that case RMC-011 MAY certify the observed capital-source census and the conserved D09 demand-import coverage with `requirement_count = 0`, but it MUST report `zero_own_capital_proven = false` and MUST NOT claim opportunity-level capital feasibility. A non-empty source census remains mandatory.

Capital feasibility proves funding availability and constraints for each requirement independently. It does NOT prove that multiple individually feasible requirements can be funded concurrently from shared capital sources.

Portfolio-wide simultaneous capacity, source collision, and cross-candidate capital contention remain downstream non-claims until an explicit conflict-set / portfolio-capacity layer certifies them.

Capital feasibility does NOT prove positive net EV, capture probability, or realized P&L.
