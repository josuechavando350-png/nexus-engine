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

## Public RPC load

Live acquisition runs only from a `workflow_dispatch` on the exact branch
head without `stages_run_id`, in the repository-wide concurrency group
`nqc-census-public-rpc` (`cancel-in-progress: false`). At most one live
Census acquisition runs at a time, and a running one is never cancelled.

GitHub keeps one pending run per group, and a newer pending run replaces
the older. So the runs that use no RPC stay out of the group, each in its
own group:
- a `pull_request` run, which runs the gate only;
- an offline replay of an earlier acquisition (`stages_run_id` set).

Each stage matrix is bounded (`max-parallel: 6`, providers interleaved).
Run 36526877390 showed the need. With 20 of this workflow's jobs loading
the same endpoints, one blastapi PairCreated partition exhausted the shared
public capacity (HTTP 429 "compute units per second") across four attempts.

Retries:
- Transient failures (rate limit, transport, "temporarily unavailable") are
  retried by the chain layer, then by up to ten attempts that resume from
  committed RMC-004 checkpoints.
- A retry never masks missing data: a range that cannot be acquired fails
  the stage.
- A semantic disagreement fails closed without retry.

Stage evidence is uploaded even when a stage fails. Its name carries stage,
provider, partition, exact head, run id and attempt. A failed partition can
be re-run alone ("re-run failed jobs"), and the replay consumes each stage's
latest attempt.

## Offline reconciliation

The stages of one acquisition hold about 20 GB of evidence: 48 stage stores
from run 36589054151, the largest 1.3 GB compressed. That run's reconcile
job downloaded all 49 artifacts at once and failed twice with "Artifact
download failed after 5 retries". The runner had disk to spare (a runner of
the same image showed 106 GB free), so the failure was the one bulk
transfer, and one failed download failed the whole reconcile. The stores are
therefore never gathered or merged: each stage is downloaded and replayed
alone, and a failed download fails, and re-runs, only its own stage.

Artifact upload drops empty directories. Before a downloaded store is used,
the workflow recreates the store's documented, always-present directories
(`tmp/`, which only ever holds staging files, `objects/chunks`,
`objects/artifacts`, `streams`, and each stream's `checkpoints`). Evidence
is never created: the store is verified (RMC-004) before replay.

**Replay, one job per stage** (`nqc-rmc007-v2-replay`, no network
namespace). Each job:
- downloads only its own stage artifact, the latest attempt;
- verifies the store (RMC-004) before and after;
- replays the record from that store, and the replayed record must be
  byte-identical to the recorded one;
- replays the record's bootstrap and anchor manifests;
- writes an extract: the record and its sha256, the replayed rows and
  their digest, the replayed chain domain and anchor, and the store's
  evidence root. The replay may not move the evidence root.

**Reconcile** (`nqc-rmc007-v2-reconcile --extracts`, no network namespace).
It holds only the surface store and the 48 extracts, and:

1. replays the surface and boundary reports from the surface store;
2. recomputes every extract's record and data digests and row count, and
   requires every extract's chain domain and anchor to equal the
   current-surface anchor;
3. per provider, requires the `pair-created` partitions to tile
   `[boundary, anchor]` exactly and to link by parent hash, and the `pairs`
   partitions to cover `0..N` exactly;
4. requires both stage providers to return identical logs and identical rows
   (any disagreement is a consensus failure — fail closed);
5. reconciles A, B and C.

The reconciler trusts one thing without recomputing it: that each extract
was produced by the exact-head replay job of the same workflow run. Every
extract names the stage artifact it replayed and that store's evidence
root, and `extract-selection.json` lists every attempt. A dispatch with
`stages_run_id` replays an earlier acquisition. It first checks through the
GitHub API that the run is this workflow's, and that its surface, 16
PairCreated and 32 pairs jobs all succeeded. The run's jobs and artifacts
are recorded.

`nqc-rmc007-v2-merge` and the merged-store path (`--records`) remain for
acquisitions small enough for one disk. Both paths feed the same checks the
same replayed data.

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

Written twice offline and compared byte for byte (`v2-discovery-run.json`
names each stage's own store summary when stages were replayed one store at a
time):

- `v2-discovery-run.json`
- `v2-pair-manifest.jsonl` (one row per pair: D01 key, index, ordinal,
  token0, token1, creation block/log coordinate, direct lookup, runtime)
- `v2-deltas.jsonl`, `v2-mismatch-ledger.jsonl`: PASS requires zero
  delta/mismatch finding entries. Each file contains exactly one canonical
  metadata sentinel row (`status: "EMPTY"` and a zero counter), so an empty
  ledger remains schema/version/code-bound and content-addressable.
- `v2-deployment-admission.json`
- `v2-discovery-summary.json`
- `evidence-manifest.json`

`generated_at` is derived from the observation anchor block timestamp, so
reruns are byte-identical; the code commit and tree are passed explicitly.

## Non-claims

No claim of: coverage beyond the declared factory, profitability, liquidity,
token quality, route availability, execution, or any downstream capability.
