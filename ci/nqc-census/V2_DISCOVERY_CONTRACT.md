# RMC-007 — Reconciled V2 Discovery Contract

Scope: exactly one declared deployment — the Ethereum-mainnet Uniswap V2
factory `0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f` — from its earliest-code
block to the observation anchor `25,437,474`
(`0x0712ee92e6c2e2359c792e7aadc5bc35b9db392a2a5dc02f4575096437e8bfc8`).
RMC-007 does not claim any other V2 deployment, fork, chain or DEX, and makes
no economic claim of any kind.

Authoritative parent: `8ebf6860e0a16964f5293df0ef40695b303b286d`, plus the
generic RMC-003.2 LogTopic prerequisite `519e5f6f7a4d42ff1cab67fef8306cfef9aab120`
(zero-permitting EVM topic words). Core, store and chain crates are pinned to
that authority and may not change in this node.

## Authorities reused

- D01 canonical market identity (`CanonicalMarketKey::v2_pair`)
- D03 typed observations (`LOG`, `CONTRACT_CALL`, `RUNTIME_CODE`, `BLOCK_HEADER`)
- D04 durable evidence, checkpoints, `certify_range`, offline verifier
- D05 deployment registry and admission (`ProxyKind::Direct`)
- the shared `nqc-census-chain` acquisition / replay layer

No parallel identity, evidence, checkpoint, transport or admission model is
permitted. The crate contains no network client; every byte on the wire is an
RMC-004 exchange.

## Discovery surfaces

- **A — enumeration.** `allPairsLength()` and `allPairs(i)` for every
  `0 <= i < allPairsLength` at the anchor.
- **B — creation history.** Every canonical
  `PairCreated(address indexed token0, address indexed token1, address pair, uint256)`
  log emitted by the factory from its earliest-code block through the anchor.
  The last word is the 1-based ordinal (`allPairs.length` after the push).
- **C — direct lookup and runtime.** For each enumerated pair, the pair's own
  `token0()` / `token1()` at the anchor (proves runtime code answering the
  pair interface and binds its token identity) and the factory's
  `getPair(token0, token1)` round trip.

Selectors and the topic are derived from exact signatures. A CREATE2
address check is not used: the pair init-code hash is not part of Protocol/Fork
Truth, so it cannot be an authority here.

## Acquisition

Both surfaces and the creation boundary are exact-anchor, multi-provider:

- `nqc-rmc007-v2-current` / `nqc-rmc007-v2-boundary` read the factory
  surface (length, runtime, interface evidence) and the earliest-code
  boundary on the three shared census providers; they must agree.
- `nqc-rmc007-v2-stage` runs one **stage** on one provider and one
  partition. The two stage providers are the batch-capable endpoints in
  `v2-discovery-providers.json` (distinct declared operators; infrastructure
  independence is not claimed).
  - `pair-created`: the block range `[boundary, anchor]` is split by
    `partition_plan` into 8 contiguous block partitions. Each partition
    binds both boundary anchors and checkpoints every `log_span` blocks.
  - `pairs`: the index range `0..allPairsLength` is split into 16 contiguous
    index partitions, in resumable jobs of `job_size` indices.
- Every stage is resumable from committed RMC-004 checkpoints; CI retries a
  stage after a provider outage and the retry resumes rather than restarts.
- Each stage emits a small record: `{schema, stage, provider, parameters,
  manifests, row_count, data_sha256}`.

## Offline reconciliation

`nqc-rmc007-v2-merge` merges every stage store into one RMC-004 store.
`nqc-rmc007-v2-reconcile` then runs with no network namespace and:

1. replays the surface and boundary reports and every stage record from the
   merged store (`ReplayTransport`), requiring each replayed record to be
   byte-identical to the recorded one;
2. per provider, requires the `pair-created` partitions to tile
   `[boundary, anchor]` exactly and to link by parent hash, and the `pairs`
   partitions to cover `0..N` exactly;
3. requires both stage providers to return identical logs and identical rows
   (any disagreement is a consensus failure — fail closed);
4. reconciles A, B and C.

PASS requires, with `N = allPairsLength` at the anchor:

- `|A| == |B| == |C| == N`, and `A ∩ B ∩ C == A ∪ B ∪ C`;
- PairCreated ordinals are exactly `1..N`, contiguous, in canonical log order;
- no duplicate pair, ordinal or `(token0, token1)` tuple;
- enumeration index `i` names the pair with ordinal `i + 1`;
- every pair answers `token0()` / `token1()` with the logged tokens, and
  `getPair(token0, token1)` returns that pair;
- zero source-only deltas, zero unexplained deltas, zero mismatches.

Uniswap V2 factory pairs are append-only in the supported semantics, so a
source-only pair is never auto-explained as lifecycle drift; it is
UNEXPLAINED unless concrete evidence proves another cause.

Findings the reconciler can raise include `ENUMERATION_ZERO_PAIR`,
`RUNTIME_MISSING`, `RUNTIME_IDENTITY_MISMATCH`, `DIRECT_LOOKUP_ZERO`,
`DUPLICATE_ORDINAL`, `DUPLICATE_PAIR`, `DUPLICATE_TOKEN_TUPLE`,
`ORDINALS_NOT_CONTIGUOUS` and `ORDINAL_ORDER`; any finding blocks PASS.

## D05 admission

The factory is admitted through `DeploymentRegistry::admit` from observed
evidence only: chain domain, creation and observation anchors, factory
runtime sha256, a configuration hash over the discovery selectors and topic,
and an explicit no-oracle configuration hash. Only `MarketDiscovery` is
admitted; every downstream capability stays `false` until its own node.

## Closeout artifacts

Written twice from the merged store and compared byte for byte:

- `v2-discovery-run.json`
- `v2-pair-manifest.jsonl` (one row per pair: D01 key, index, ordinal,
  token0, token1, creation block/log coordinate, direct lookup, runtime)
- `v2-deltas.jsonl`, `v2-mismatch-ledger.jsonl` (must be empty for PASS)
- `v2-deployment-admission.json`
- `v2-discovery-summary.json`
- `evidence-manifest.json`

`generated_at` is derived from the observation anchor block timestamp, so
reruns are byte-identical; the code commit and tree are passed explicitly.

## Non-claims

No claim of: coverage beyond the declared factory, profitability, liquidity,
token quality, route availability, execution, or any downstream capability.
