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

## Source-universe truth

RMC-011 distinguishes **semantic capability** from **live censused coverage**.

The crate may model additional provider families or capital classes before a live discovery/import path exists for them. An adapter, enum variant, unit test, or synthetic fixture is never evidence that such a source was actually available at the certified block.

The current authoritative real-source build imports capital observations only through the exact RMC-008 admitted market/state bytes and the D11 deterministic capital importer. Therefore the real-source closeout MUST state:

- `source_universe_basis = RMC008_ADMITTED_MARKETS_AND_CAPITAL_IMPORT_ONLY`;
- `global_capital_source_completeness_claimed = false`;
- `GLOBAL_CAPITAL_SOURCE_UNIVERSE_NOT_CERTIFIED` in its non-claims;
- `terminal_capital_census_complete = false`;
- `actionable_requirement_coverage_complete = false`;
- terminal blockers for global source-universe completeness, actionable requirement coverage deferred to RMC-012, and repayment cash-flow sufficiency.

This means a successful RMC-011 real-source closeout proves the identity, terms, capacity and provenance of the sources it actually imported; it does **not** constitute terminal Capital Census completeness and does **not** prove that every possible flash-liquidity venue, gas sponsor, credit facility, collateral facility, builder deposit facility, or persistent-debt provider on the chain has been enumerated. A downstream terminal closeout MUST NOT reinterpret this scoped PASS as exhaustive capital-universe authority.

Any later phase that needs a source family outside this live-import basis MUST either add an evidence-backed discovery/admission path and recertify D11, or fail closed. Absence from the current source ledger MUST NOT be interpreted as authoritative proof that no such source exists.

The exhaustive family-discovery specification is `ci/nqc-census/rmc011-capital-family-discovery.json`. It defines, for each required family, the authoritative discovery surface, anchor semantics, completeness condition, negative-proof requirement, and implementation path. The discovery plan itself is not evidence. Terminal source-universe readiness requires an authenticated discovery result proving that every declared surface was actually executed to its completeness condition.

A family may be labeled `EXHAUSTIVELY_REJECTED_WITH_REPRODUCIBLE_EVIDENCE` only when its declared discovery surface was completed and the rejection evidence is content-addressed. “No result was found,” absence from an index, a historical test, or a model-only adapter is never an exhaustive rejection. Permissioned/off-chain capital families are exhaustive only relative to the authenticated NQC external-provider registry, the supported execution-plan requirement catalog, and—where collateralized or persistent permissionless debt is in scope—the declared permissionless debt-facility catalog; uncontracted third-party credit is not treated as capital available to NQC. A declared-empty registry/catalog is a bounded negative fact, not terminal evidence by itself. Terminal rejection of the nine bounded external/requirement families MUST be derived by the bounded-family rejection workflow, and promotion into the source-universe contract MUST be atomic across all nine families from one exact successful run/artifact with one distinct content-addressed per-family evidence file.

Balancer V2 and Uniswap V3 are permissionless on-chain discovery surfaces and therefore require fresh block-pinned D11 acquisition at the certified anchor. Historical T36 Balancer callback parity may justify implementation semantics but MUST NOT serve as current D11 availability/capacity evidence.

Balancer V2 now has a dedicated D11 live acquisition boundary in `nqc-census-capital::balancer_live`. It derives its actionable asset universe from the exact D08 admitted current Aave assets intersected with D08 `PROVEN_COMPATIBLE` token admission, verifies those consumed bytes against the D08 evidence manifest, requires the D11 authority-lock anchor to equal the D08 full observation anchor, and captures the canonical Balancer V2 Vault from two declared independent providers. The certification workflow preserves each provider's RMC-004 evidence store, independently verifies both stores offline, requires exact semantic agreement across the captures, and runs both the Python adversarial reconciler and the Rust CapitalSource admission path. Until a successful exact-head certification artifact binds those bytes and the reconciled source set is replay-bound into the canonical D11 ledger, the family remains `terminally_resolved=false`; implementation or a queued workflow is not availability evidence.

### Bounded external/requirement-family evidence

The following nine families form one bounded authorization/requirement universe for the current NQC head:

- `EXTERNAL_GAS_CREDIT`
- `EXTERNAL_GAS_SPONSOR`
- `TRANSIENT_EXTERNAL_CREDIT`
- `COLLATERALIZED_BORROWING`
- `PERSISTENT_DEBT`
- `INVENTORY_REQUIREMENT`
- `BOND_OR_STAKE`
- `SOLVER_OR_BUILDER_DEPOSIT`
- `INTRA_BLOCK_TEMPORARY_LOCK`

Their negative-proof surfaces are machine-readable: `rmc011-external-capital-provider-registry.json`, `rmc011-execution-plan-requirement-catalog.json`, and `rmc011-permissionless-debt-facility-catalog.json`. Empty declared state means only that no provider/facility/plan is authorized or supported by this exact NQC head. It MUST NOT be restated as global market nonexistence.

`NQC RMC-011 Bounded Family Rejection Evidence` may emit per-family `EXHAUSTIVE_REJECTION` evidence only when all applicable catalogs independently validate and remain empty. The resulting nine promotions are all-or-none, MUST share the same repository/workflow/run/head/artifact identity, and MUST bind distinct `families/<FAMILY>/evidence.json` files by SHA-256. Any provider, permissionless debt facility, or supported execution plan entering scope invalidates the corresponding empty-universe rejection path and forces recensus.

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
- provider locators used by stable source keys MUST contain facility identity only; mutable runtime/configuration, commercial terms, capacity, activity flags, and blocker state belong to observation identity/evidence and MUST NOT rotate the stable source key
- fee model
- for external gas sponsors, any fixed fee asset MUST equal the sponsor's explicitly declared fee asset; contradictory fee metadata is non-canonical
- external gas credit MUST bind an authenticated delivery route proving native gas reaches the borrower before the execution transaction without operator prefunding; a facility that requires the borrower to spend gas to draw the gas credit is circular and is not admissible as `GAS_FUNDING`
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
- protocol execution-state blockers are part of observed truth; in particular a Balancer V2 Vault pause preserves observed balances but makes flash capital non-executable (`BALANCER_VAULT_PAUSED`)
- evidence references
- code/configuration identity where material

No floating-point representation is permitted for protocol-governed integer amounts, fees, ratios, or caps.

## Required candidate requirement fields

The D09 borrower-demand boundary MUST preserve the exact account risk state needed by later liquidation sizing rather than only a boolean health-factor classification: user configuration, eMode category when available, all six `getUserAccountData` integers, configuration divergences, and exact supply/debt positions. For every borrower with a boolean `health_factor_below_one`, D11 MUST recompute that boolean from the preserved health-factor WAD and reject contradictions. These exact fields are included in the D09 demand coverage commitment even while liquidatability remains unclaimed.

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

- every consumed upstream byte is bound through the upstream stage's admitted evidence manifest; for RMC-008 the authority artifact digest identifies `evidence-manifest.json`, whose exact code commit/tree, full observation anchor, anchor-derived generation time, and per-file SHA-256/size entries MUST match `market-state-manifest.jsonl`, `token-admission.jsonl`, and `pool-and-factory-facts.json` before import
- the same byte-binding rule applies to RMC-009: its authority artifact digest identifies `evidence-manifest.json`; the manifest is the code-identity provenance authority and MUST name the exact admitted code commit/tree and anchor-derived generation time, while the census-content `account-summary.json` intentionally omits code identity so full/incremental parity can remain byte-identical; the manifest SHA-256/size entries for `account-manifest.jsonl` and `account-summary.json` must match before borrower demand import, and the summary's block number/hash/timestamp/generation time MUST match the exact D11 observation anchor
- the verified RMC-008 source import and RMC-009 borrower-demand import MUST each emit a deterministic consumption receipt binding their coverage commitment to the exact admitted upstream authority artifact
- each receipt MUST also bind the exact consumed output set: sorted source IDs for RMC-008 and sorted certified requirement IDs for RMC-009, together with an exact output count; final certification MUST recompute those sets from the ledger and reject any missing, extra, substituted, or duplicated output
- D08 source evidence MUST be deterministic: every source imported from RMC-008 binds exactly the admitted RMC-008 authority artifact, whose evidence manifest transitively binds every consumed D08 file; arbitrary caller-supplied extra evidence MUST NOT change source identity
- real-source certification requires an external immutable authority lock for every RMC-006..RMC-010 stage (exact code commit, code tree, admitted artifact SHA-256, and the full block-pinned observation anchor including chain domain, block/parent hashes, timestamp, and state root), plus replay of the exact consumed RMC-008 and RMC-009 bytes through the same deterministic importers and exact equality with the committed consumption receipts; self-asserted upstream identities, substituted anchors, or internal consistency of a D11 artifact bundle alone are insufficient proof
- merely listing an admitted RMC-008 or RMC-009 authority is insufficient: certification MUST fail if either consumed-input receipt is absent, duplicated, references the wrong stage, references a different authority artifact, does not equal the ledger output set, or cannot be reproduced from the consumed upstream bytes
- deployment/source identity is admitted
- the observation is pinned to the same canonical block context required by the candidate
- executable capacity, not merely observed capacity, is sufficient at the requested size
- no execution blocker remains on any allocated source
- fee/cap semantics are explicit
- Aave V3 `flashLoanSimple` premium uses the deployed ceiling semantics certified by PFT-COMPAT-009; half-up percentage rounding is forbidden because it can understate repayment by one atomic unit
- repayment semantics, asset, deadline and exact source-derived settlement obligations are structurally compatible with the candidate declaration; RMC-011 does **not** prove that execution output cash-flow will contain enough of the repayment asset to satisfy those obligations
- exact repayment and funding-fee settlement obligations derived from the actual source allocations equal the declared settlement legs before the candidate may be labeled `FEASIBLE`
- settlement legs must authorize the actual capital-source classes that generated those obligations, and the declared settlement amounts must be exactly assignable across those authorized classes; matching only aggregate kind, asset, and amount is insufficient
- atomicity/collateral requirements are compatible
- action atomicity constrains action/principal funding, but a `GAS` leg may use authenticated external `GAS_FUNDING` with later explicit repayment because native gas must be acquired before EVM execution; that exception MUST NOT allow the same delayed source to fund an atomic action-principal leg
- external gas-credit evidence MUST bind `delivery_semantics = PRE_EXECUTION_NATIVE_GAS_TO_BORROWER_NO_OPERATOR_PREFUND_V1`, a non-zero content-addressed delivery-route commitment, and `operator_prefund_required = false`; credit capacity without this pre-submit delivery proof is not executable gas capacity
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

## Repayment truth boundary

Capital feasibility in RMC-011 is **source-side funding feasibility**, not a proof of post-execution cash-flow.

D11 proves that:
- principal and other pre-execution funding legs can be allocated from eligible external sources under exact capacities/terms;
- every allocation's repayment principal and funding fee are derived exactly;
- the requirement declares exactly matching settlement obligations with compatible source-class provenance.

D11 does not yet prove that seized collateral, swap proceeds, arbitrage output, or any other execution result will actually produce enough of the repayment asset at the required deadline. That requires exact execution/routing simulation downstream.

Therefore the authoritative real-source closeout MUST carry:
- `repayment_cashflow_sufficiency_claimed = false`;
- non-claim `REPAYMENT_CASHFLOW_SUFFICIENCY_NOT_CERTIFIED`.

No downstream stage may interpret D11 `FEASIBLE` alone as proof that a transaction can settle successfully end-to-end.

## Outputs

Target deterministic artifacts:

- `capital-sources.jsonl`
- `capital-requirements.jsonl`
- `capital-feasibility.jsonl`
- `capital-rejection-ledger.jsonl`
- `capital-census-summary.json`
- `capital-upstream-authority.json`
- `capital-evidence-manifest.json`
- `capital-upstream-authority-lock.json` (archived canonical copy of the certification authority lock used by the build)
- `capital-real-source-closeout.json` (only after external authority locking plus exact upstream replay passes)
- `capital-archive.sha256` (deterministic SHA-256 inventory over the seven D11 artifacts, archived external lock, and real-source closeout)
- final CI evidence package containing the exact downloaded RMC-006..RMC-010 artifact bytes used for semantic admission, the exact `rmc011-real-source-inputs.json` transport declaration, the complete D11 real-source archive, and `CERTIFICATION-PACKAGE-SHA256SUMS` over every packaged file

The real-source build path MUST start from a canonical certification authority lock constructed from the exact authenticated RMC-006..RMC-010 transport identities and authority-file SHA-256 values, reconstruct its certification context, replay RMC-008/RMC-009, build the D11 ledger, export the seven canonical D11 artifacts, regenerate the closeout from those exact bytes, and verify the closeout again before writing the archive. The certification runner MUST derive the D11 code commit and tree from the checked-out exact `HEAD`, require a clean tracked working tree, refuse a non-empty output directory, and finish by verifying the archive SHA-256 inventory. A manually assembled D11 bundle is not the certification path.

Every artifact MUST include schema version, exact code commit/tree, observation anchor or block range, source provenance, and SHA-256/content-addressed evidence. `generated_at` is evidence time, not wall-clock time: it MUST equal the exact observation-anchor block timestamp and MUST carry `generated_at_basis=OBSERVATION_ANCHOR_BLOCK_TIMESTAMP`, so identical evidence and code regenerate byte-identical artifacts. The ordinary D11 bundle remains explicitly `real_source_certification=false`; only the separate closeout produced by the external-lock + exact-replay verifier may assert `real_source_certification=true`.

## Required tests

At minimum:

- source identity is deterministic and collision-resistant across chain/provider/asset/class
- changing gas-credit active/blocker state, runtime/configuration, or commercial terms changes observation identity as applicable but cannot rotate the stable facility source key
- same bytes under different capital classes do not alias
- zero and overflow amount/cap edge cases fail correctly; public enum/struct construction cannot bypass the same fee, ratio, repayment-deadline, collateral, utilization, temporary-lock, or nonzero-evidence validations enforced by canonical decode
- atomic source cannot silently become persistent debt
- persistent debt cannot pass without collateral/solvency semantics
- collateral and temporary-lock dependencies are aggregated across all distinct sources used by one candidate; one declared leg cannot be reused to satisfy multiple source dependencies
- gas funding is independently required when execution needs native gas, and the `requires_native_gas` flag must equal the presence of a native-gas requirement leg in both directions
- a same-transaction action with exact flash principal plus deadline-bound external gas credit must remain feasible when repayment is explicitly declared, while the same deadline-bound source must fail atomicity if used as action principal
- external gas credit must fail closed when delivery requires operator prefunding, when the draw itself requires borrower gas, or when the authenticated delivery-route commitment is changed without a matching terms commitment
- insufficient source capacity fails closed
- Aave V3 flash-premium regression MUST include the exact PFT-COMPAT-009 callback witnesses (`83727306811 @ 5 bps -> 41863654` and `186298226 @ 5 bps -> 93150`)
- incompatible repayment asset/semantics fails closed
- exact repayment/funding-fee settlement mismatch, including source-class provenance or per-class amount-assignment mismatch, is classified as a feasibility rejection rather than surviving as a provisional `FEASIBLE` result until certification
- protocol and market caps bind maximum executable size
- stale/mismatched anchors fail
- unknown failure reason cannot pass certification
- deterministic canonical encode/decode and tamper rejection; offline verification reports total feasibility records, feasible requirements, and rejected requirements as distinct conserved counts; arbitrary or wall-clock artifact generation times and mismatched artifact anchors are rejected
- evidence refs are required for admitted real sources; substituting even an unconsumed prerequisite authority such as RMC-006, RMC-007, or RMC-010 must fail against the external authority lock
- synthetic fixtures are explicitly non-evidentiary

## Certification gate

The ordinary `NQC RMC-011 Capital Census` foundation workflow is a code/fixture/invariant gate only and MUST NOT be interpreted as real-source authority. The separate `NQC RMC-011 Real Source Certification` workflow certifies the exact observed source subset and upstream provenance, but while `terminal_capital_census_complete=false` it MUST NOT be interpreted as exhaustive terminal Capital Census authority. Real-source certification requires to bind **every** RMC-006..RMC-010 authority to an exact successful GitHub Actions workflow run and immutable transport tuple: workflow name, run id, exact head SHA, exact Git tree SHA, artifact id, artifact name, GitHub artifact SHA-256 digest, authority-file path, and SHA-256 of that authority file. From those already-authenticated transport facts, the runner MUST deterministically build the canonical RMC-006..RMC-010 authority lock before semantic admission. The generated lock is then checked against the downloaded content-addressed bytes; its `artifact_sha256` values MUST equal the exact authority-file SHA-256 values and its code commit/tree MUST equal the observed run head/tree. If a repository-declared `rmc011-authority-lock.json` is present, it MUST be byte-identical to the independently derived canonical lock; a handwritten or stale declaration can never override the derived transport/content truth. D08/D09 consumed bytes are then taken from those same verified artifacts, `run-rmc011-real-source-closeout.sh` is executed, `capital-archive.sha256` is re-verified, and the resulting closeout is archived. If any authoritative input is absent or inconsistent, the final certification workflow MUST fail closed with `RMC011_BLOCKED_UPSTREAM_REAL_SOURCE`.

The final RMC-011 certification artifact MUST be self-contained with respect to the upstream bytes and bounded-universe contracts actually used by this gate: it MUST preserve the exact downloaded RMC-006..RMC-010 artifact trees alongside the D11 closeout and transport declaration, plus the capital-family discovery contract, external-provider registry and verifier report, execution-plan requirement catalog and verifier report, permissionless debt-facility catalog and verifier report, and bounded-family rejection report. It MUST generate and re-check a deterministic package-wide SHA-256 inventory before upload. GitHub Actions retention is transport retention, not permanent evidence storage; expiry of the hosted copy MUST NOT be treated as evidence invalidation, and durable retention outside the ephemeral Actions store remains an operational requirement rather than a capital-truth claim.

The certification authority lock is a **normalized commitment, not semantic source truth**. Its canonical bytes may be deterministically derived by the certification runner from exact authenticated transport metadata plus the full D08 observation anchor; semantic admission still comes only from the independently verified upstream artifact bytes. A repository-declared lock is optional redundancy and, when present, must byte-match the derived lock. For every RMC-006..RMC-010 row, final certification MUST derive admission from the downloaded content-addressed artifact itself and cross-check the lock against those bytes. This derivation MUST verify the stage-specific PASS state, zero unexplained mismatch/delta state, zero UNKNOWN state where that stage defines UNKNOWN, conservation/coverage predicates, exact observation anchor to the maximum precision emitted by that stage, and the SHA-256/byte entries of every summary or ledger used for those conclusions against the authority evidence manifest. RMC-010 additionally MUST prove that its full-census evidence-manifest SHA-256 is the exact locked RMC-009 authority and that its incremental evidence manifest and parity record match the hashes in the RMC-010 certification record. A lock row with `coverage_complete=true` or `admitted=true` that is not derivable from authenticated upstream bytes MUST be rejected.

Canonical `Hash32` values in the authority lock are serialized with a `0x` prefix, whereas `sha256sum` emits plain hex. Comparison code MUST normalize representation only (strip an optional `0x` prefix) and compare all 32 digest bytes exactly; the canonical lock bytes themselves MUST remain unchanged.

### Temporal coherence of final upstream authority

RMC-011 final certification is a **single-snapshot claim**, not a union of independently valid stages observed at different blocks. The canonical RMC-006..RMC-010 authority lock therefore MUST carry one exact `StateAnchor` shared by all five stages.

RMC-010 is a transition/parity proof from A0 to a strictly later A1. For RMC-011, its `target_anchor` is the required final snapshot. The final certification gate MUST prove all of the following from the exact downloaded authority artifacts:

- RMC-006 discovery carries the exact A1 chain domain, block header, state root and timestamp.
- RMC-007 discovery independently carries the same exact A1 anchor.
- RMC-008 state/oracle/token admission carries the same exact A1 `observation_anchor`.
- RMC-009 account census carries the same A1 block number/hash/timestamp.
- RMC-010 is `RMC_010_LIVE_PARITY_CERTIFIED`, has `base_anchor < target_anchor`, and its target number/hash equal the D11 A1 anchor.
- RMC-010's `target_d06` and `full_d09` source identities are exactly the same D06 and D09 workflow artifacts transported into RMC-011.
- RMC-010's committed full-D09 evidence-manifest SHA-256 equals the RMC-009 authority SHA-256 admitted by RMC-011.

A valid RMC-006 artifact from A0, a valid RMC-007 artifact from A0, a valid RMC-008 artifact from A0, and valid RMC-009/RMC-010 artifacts from A1 MUST NOT be composed into one D11 certificate. If D10 advances the target to A1, D06-D09 must be re-certified at A1 as necessary before RMC-011 can certify.

Foundation artifacts MUST encode `real_source_certification=false` until every real source class used by feasibility has a semantic admission path that proves the source terms from content-addressed evidence. An admitted artifact hash alone is not proof that arbitrary source semantics (especially external gas funding, credit, collateral facilities, builder deposits, or persistent debt risk terms) were present in that artifact.

Model support is not source-universe coverage. The current real D08 importer has semantic admission for Aave V3 flash liquidity and Uniswap V2 flash-swap liquidity. D11 now also contains semantic admission/acquisition implementations for Balancer V2, Uniswap V3, external gas sponsorship, transient external credit, collateralized borrowing, and persistent debt. Those implementations are still **not availability evidence**: each family remains unresolved until an exact successful authenticated acquisition artifact proves live terms/capacity at the certified anchor, or an applicable bounded discovery surface produces an authenticated exhaustive rejection. Inventory, bond/stake, solver/builder deposit, and intra-block temporary-lock families are requirement-driven and remain unresolved until the authenticated execution-plan/provider surfaces justify either a real external funding path or bounded exhaustive rejection. A real-source closeout may certify the exact observed source set it consumed, but MUST NOT claim exhaustive capital-source-universe coverage or system-wide maximum zero-own-capital capacity until every missing source family is either admitted or exhaustively rejected with reproducible evidence.

RMC-011 may be certified only when:

- all upstream inputs used by the final run are exact-head admitted artifacts
- exact RMC-008 and RMC-009 consumption receipts are present and their coverage commitments, output counts, and output-set commitments are bound into `capital-upstream-authority.json` and its commitment
- every source used for feasibility has reproducible evidence
- zero unexplained source mismatches remain
- zero UNKNOWN failure reasons remain
- full rerun is deterministic
- offline verifier passes
- the D11 upstream authority equals the external RMC-006..RMC-010 authority lock exactly, and exact upstream-consumption replay passes for RMC-008 and RMC-009; without the external lock or consumed upstream bytes, the result remains internally consistent only and MUST NOT claim real-source certification
- a deterministic `capital-real-source-closeout.json` is generated from that combined proof and binds the D11 capital commitment, upstream-authority commitment, external-lock commitment and SHA-256, exact observation anchor, source/requirement counts, zero-own-capital truth, RMC-008 candidate/admitted/rejected conservation counts, RMC-009 borrower/classification/blocker counts, and the exact RMC-008/RMC-009 authority-artifact, coverage, and output-set commitments reproduced by replay; archived closeout bytes MUST be re-verifiable only by regenerating them from the exact capital bundle, external lock, and consumed RMC-008/RMC-009 bytes
- if no certified requirement is actually `FEASIBLE` (including an empty requirement set or a non-empty set containing only rejections), the real-source closeout MUST keep `zero_own_capital_proven=false` and MUST explicitly refuse any opportunity-level capital-feasibility claim
- an EVM gas requirement MUST use `NativeGas` and MUST be fundable only by the `GAS_FUNDING` capital class; in-transaction flash liquidity MUST NOT be treated as transaction gas because gas purchasing occurs before contract execution
- `zero_own_capital_proven=true` requires at least one feasible requirement, zero operator-owned allocations, and `feasible_external_gas_count == feasible_count`; a gasless synthetic requirement may prove zero operator-treasury usage but MUST NOT prove full zero-own-capital execution
- no downstream profitability, Shadow, Canary, or P&L claim is inferred from capital feasibility alone

RMC-009 explicitly does not certify liquidatability. Therefore a fully admitted upstream run may legitimately contain zero actionable capital requirements. In that case RMC-011 MAY certify the observed capital-source census and the conserved D09 demand-import coverage with `requirement_count = 0`, but it MUST report `zero_own_capital_proven = false` and MUST NOT claim opportunity-level capital feasibility. The same non-claim applies whenever `feasible_count = 0`, even if rejected requirements exist. A non-empty source census remains mandatory.

Capital feasibility proves funding availability and constraints for each requirement independently. It does NOT prove that multiple individually feasible requirements can be funded concurrently from shared capital sources.

Portfolio-wide simultaneous capacity, source collision, and cross-candidate capital contention remain downstream non-claims until an explicit conflict-set / portfolio-capacity layer certifies them.

Capital feasibility does NOT prove positive net EV, capture probability, or realized P&L.


## Terminal D11 closure is stricter than real-source package certification

`RMC011_REAL_SOURCE_CERTIFICATION=PASS` proves only the authenticated, replayed source set actually consumed by D11. It is **not** the terminal Capital Census state.

The machine-readable source-universe authority is `ci/nqc-census/rmc011-capital-source-universe.json`. That file has **readiness authority only** and is forbidden from emitting `D11_TERMINAL_CLOSED`. Its strongest possible state is `CAPITAL_SOURCE_UNIVERSE_COMPLETE`, which requires every required capital-source family to be terminally resolved by authenticated real-source admission or exhaustive rejection **and** the family-universe discovery itself to be `AUTHENTICATED_COMPLETE`.

Every terminally resolved family MUST carry content-addressed resolution evidence. `AUTHENTICATED_REAL_SOURCE` requires a real-source path plus an authenticated evidence locator and SHA-256; `EXHAUSTIVELY_REJECTED_WITH_REPRODUCIBLE_EVIDENCE` requires an exhaustive-rejection evidence locator and SHA-256. Changing a status string without those bindings never resolves a family.

Model support, an adapter implementation, or a semantic parser without authenticated acquisition evidence does not resolve a source family. In particular, `gas_credit.rs` being able to validate two-provider external gas-credit observations does not certify that such a facility exists or is available at the anchor.

`CAPITAL_SOURCE_UNIVERSE_COMPLETE` is necessary but not sufficient for D11 closure. Final D11 authority must combine that readiness proof with the authenticated D11 source/certification evidence in a separate terminal gate. Until source-universe readiness is complete, the source-universe state remains `BLOCKED_INCOMPLETE_SOURCE_UNIVERSE`, even if the narrower real-source package passes.
