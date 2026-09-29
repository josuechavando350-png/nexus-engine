# RMC-008 — Exact State, Oracle and Token Admission Contract

Scope: the markets admitted by D06 (Aave V3 core pool, Ethereum mainnet) and
D07 (Uniswap V2 factory `0x5c69…aa6f`), at the observation anchor 25,437,474
(`0x0712ee92…e8bfc8`). RMC-008 starts only from their admitted outputs and
makes no economic claim.

Authorities reused: D01 identity (`CanonicalMarketKey`, market ids recomputed
from the admitted deployment keys), D03 typed observations, D04 store and
offline verifier, D05 admission (via the D06/D07 admission records), the
shared `nqc-census-chain` layer, and the census pipeline's `StageLedger`
(`CensusStage`, `RejectionReason`, `StageMetrics`). Protocol semantics come
from Protocol/Fork Truth: Aave income and balance arithmetic
(`nqc-aave-math`, PFT-SRC-003, PFT-COMPAT-008) and V2 fee semantics as
explicit configuration (`FEE_BPS_IS_EXPLICIT_CONFIGURATION_NOT_INFERRED`,
PFT-SRC-002). No core, store or chain code changes in this node.

## 1. Inputs

`ci/nqc-census/state-inputs.json` pins each upstream source by exact
identity — upstream code commit, workflow run id, artifact id, artifact name
and artifact digest — and every consumed file by sha256: the D06 current
surface, deployment manifest and reserve manifest, and the D07 current
surface, admission and pair manifest. Before any file is used the live
workflow checks, through the GitHub API, that the run's head is the pinned
commit and concluded `success`, and that the artifact's name and digest are
the pinned ones; then every file digest. The Rust readers additionally
require the upstream schemas and that both current surfaces were acquired at
the declared D08 anchor. "Latest successful artifact" is never consumed.
While `status` is not `PINNED` the live workflow stops at its first step
(`RMC008_BLOCKED`). Every market id is recomputed through D01 from the
admitted deployment key and must equal the admitted id.

## 2. Acquisition

Every stage is pinned to the declared anchor, runs on one provider, persists
every exchange and observation in RMC-004, and emits a small record that the
offline reconciler replays byte-for-byte. Two providers are required for
every fact; any difference fails closed (no voting).

- `AAVE_STATE`: Pool implementation runtime, from which the present getters
  are read (a PUSH4 selector is a necessary condition for a dispatcher
  entry; absent getters are never called). For every current reserve:
  `getReserveData`, `getConfiguration`, normalized income and variable debt,
  virtual balance, grace period, deficit, token getters; aToken and debt
  token facts; underlying `decimals`, `totalSupply`, `balanceOf(aToken)`;
  EIP-1967 / beacon / ZeppelinOS proxy slots; runtime code sha256 of every
  token, implementation and strategy; eMode categories 1..255; AaveOracle
  base currency, unit, fallback, every asset's source and price; each
  source's runtime and exposed getters (`latestAnswer`, `latestRoundData`,
  `decimals`, `latestTimestamp`).
- `V2_FACTORY`: factory runtime, `feeTo`, `feeToSetter`, `allPairsLength`,
  runtime of the first and last admitted pair.
- `V2_STATE` (16 index partitions): each pair's `getReserves`,
  `totalSupply`, `kLast`, `factory`; both tokens' `balanceOf(pair)`; each
  distinct token's `decimals()`.

Calls into contracts the census does not trust (tokens, oracle sources) run
under a fixed 5,000,000 gas bound. Providers were measured to omit the
`data` member of empty EVM reverts; such calls, and deterministic EVM halts
(invalid opcode or jump, stack violation, out of gas under the bound), are
isolated by bisecting the batch that contained them. Their exact replies are
recorded exchanges, so replay retraces the same requests. Rows keep only
the status `REVERTED` / `HALTED` (revert data is not material and providers
differ on transporting it). Any other provider error fails the stage.

## 3. Exact checks

Integer arithmetic only (256-bit, checked, 512-bit intermediate for
`mulDiv`; no floating point anywhere in the crate).

Aave, per current reserve:

- `getConfiguration` = configuration word of `getReserveData`; all fields
  decoded exactly (LTV, liquidation threshold and bonus, decimals, active,
  frozen, borrowing, paused, isolation, siloed, flash loans, reserve factor,
  caps, liquidation protocol fee, debt ceiling, virtual accounting); unknown
  high bits reject the reserve (`UNSUPPORTED_PROTOCOL_VERSION`);
- reserve id = D06 id; decimals of configuration = underlying = aToken =
  debt token; aToken and debt token name the asset and the pool;
- normalized income = linear-interest recomputation, `rayMul` half-up;
- aToken `totalSupply` = `rayMul`-floor(scaled, income); debt-token
  `totalSupply` = `rayMul`-ceil(scaled, normalized debt);
- oracle: `getAssetPrice` = base unit for the base currency, otherwise the
  source's `latestAnswer` when positive.

The normalized variable debt is taken from the protocol getter only. The
deployed compounding formula (pool revision 11) is not the PFT-recovered
three-term binomial (probe v6: 28/67 exact under it) and no candidate
reimplementation reproduced all 67 reserves, so no recomputation is claimed.

V2, per pair: the pair address is the CREATE2 derivation from the init code
located exactly once inside the admitted factory runtime (the declared
Uniswap init-code hash is only the search key); sample pair runtimes are
produced by that init code and contain no SELFDESTRUCT; `factory()` names the
factory; reserves, supply and `kLast` are canonical.

## 4. Decisions and records

Stage decisions (`StageLedger`, evidence basis `PROVEN`, citing the job
manifests of both providers). RMC-008 decides one stage only,
`MARKETS_STATE_RECONSTRUCTABLE`:

- Aave reserve: advance iff every check of section 3 holds;
  `NO_ACTIVE_STATE` for D06 historical (dropped) reserves, which stay in the
  manifest; `STATE_UNRECONSTRUCTABLE` on any mismatch; `UNSUPPORTED_TOKEN_BEHAVIOR`
  when the aToken's underlying balance is below the virtual balance;
  `UNSUPPORTED_PROTOCOL_VERSION` for unknown configuration bits.
- V2 pair: advance iff identity, CREATE2, factory and canonical state hold and
  both tokens answer `balanceOf(pair)` ≥ reserve; otherwise
  `STATE_UNRECONSTRUCTABLE` / `UNSUPPORTED_TOKEN_BEHAVIOR`.

Economic activity, borrowability and actionability are later
classifications. RMC-008 records their inputs as exact facts only: Aave
`protocol_facts` (active, paused, frozen, borrowing and flash-loan flags,
available liquidity, total debt, cap-reached flags) and the V2
`liquidity_state` (`LIQUID` / `ZERO_LIQUIDITY_NOT_ROUTABLE`). A market is never
called active because its runtime exists.

Every manifest field carries a declared basis (`field-basis.json`):
`AUTHORITATIVE_GETTER`, `AUTHORITATIVE_STORAGE`, `AUTHORITATIVE_ORACLE`,
`DERIVED_EXACT`, `DECLARED_CONSTANT`, `UNSUPPORTED` or `REJECTED`.

Token admission records are tri-state per behavior — fee on transfer,
rebasing, transfer hooks, upgradeability — `PROVEN_ABSENT`, `PRESENT` or
`UNPROVEN`. Nothing is assumed: transfer semantics are not proven by this
node, so every token's execution compatibility is `BLOCKED` with named
blockers. Concrete evidence raises a behavior to `PRESENT` (a holder balance
below the protocol-accounted balance ⇒ rebasing present; a standard proxy
slot set ⇒ upgradeable). V2 token runtimes are identified by answering calls
(`PRESENCE_BY_CALL`); their code bytes are not acquired, which is itself an
execution blocker.

Oracle freshness is recorded, never assumed: update time and age at the
anchor when the source exposes `latestRoundData`, otherwise
`UPDATE_TIME_NOT_EXPOSED_BY_SOURCE`; Aave V3 does not enforce staleness.

## 5. Public RPC load

Live acquisition runs only from a `workflow_dispatch` on the exact branch
head, in the repository-wide concurrency group `nqc-census-public-rpc`
(`cancel-in-progress: false`): at most one live Census acquisition runs at a
time and a running one is never cancelled. GitHub keeps one pending run per
group, and a newer pending run replaces an older one, so a `pull_request` run
of the live workflow never enters the group: it verifies the pinned inputs
through the GitHub API only (no RPC), stops at `RMC008_BLOCKED` while they
are not pinned, and certifies nothing. Within an acquisition the stage
matrix is bounded (`max-parallel: 6`, providers interleaved). Transient provider failures (rate limit, "temporarily
unavailable", transport) are retried by the chain layer and then by up to ten
resumable attempts from committed RMC-004 checkpoints; a semantic
disagreement is never retried, it fails closed. Stage evidence is uploaded
even when a stage fails, under names carrying stage, provider, exact head,
run id and attempt; re-running a failed stage adds evidence beside the failed
attempt's, and the reconciler consumes each stage's latest attempt and lists
every attempt in `stage-selection.json`. The fast gate (`nqc-census-state-gate.yml`) runs no RPC and is not in
the group.

## 6. Closeout

Written twice offline (no network namespace) and compared byte for byte:
`market-state-manifest.jsonl`, `oracle-manifest.jsonl`,
`emode-manifest.jsonl`, `token-admission.jsonl`, `mismatch-ledger.jsonl`,
`rejection-ledger.jsonl`, `stage-metrics.json`, `pool-and-factory-facts.json`,
`field-basis.json`,
`state-summary.json`, `evidence-manifest.json` (input pins, stage manifests,
store evidence root, artifact digests). `generated_at` is the anchor block
timestamp.

Both the summary and the evidence manifest carry one canonical
`observation_anchor` — `chain_id`, `genesis_hash`, `fork_lineage`,
`block_number`, `block_hash`, `parent_hash`, `timestamp`, `state_root` —
taken from the replayed stage records: every stage record names its chain
domain and verified anchor block, all of them must be identical, and the
block must be the declared anchor; otherwise reconciliation fails.
`pool-and-factory-facts.json` names the raw `FLASHLOAN_PREMIUM_TOTAL()`
getter outcome as `flashloan_premium_total` (status `NOT_EXPOSED_BY_IMPLEMENTATION`
when the implementation's selectors do not include it); it is never
decoded, inferred or defaulted here. An independent Python pass recounts markets, re-derives every V2
balance excess and re-hashes every artifact.

PASS requires zero unexplained mismatches, zero `UNKNOWN` rejections,
conserved stage metrics and a decision for every admitted market.

## 7. Non-claims

Not claimed: token transfer semantics, oracle freshness, liquidity depth
beyond exact state, profitability, execution, or any market outside D06/D07.
