# RMC-009 — Aave V3 Account and Position Universe Contract

Scope: the accounts holding a position in the Aave V3 core pool admitted by
D06 (Ethereum mainnet), at the observation anchor 25,437,474
(`0x0712ee92…e8bfc8`). RMC-009 starts only from D06's admitted outputs and
makes no economic claim.

Authorities reused:
- D01 identity: market ids from the D06 reserve manifest.
- D04 store and offline verifier.
- The shared `nqc-census-chain` layer.
- RMC-008's D06 reader, anchor plan, bounded untrusted-call helper, U256 and
  `UserConfiguration` decoder, mismatch ledger and generic store merge.

No core, store, chain or RMC-008 code changes in this node.

## 1. Inputs

`ci/nqc-census/account-inputs.json` pins the certified D06 source by exact
identity. That source is PR 521, commit `a33a0125` (tree `eda36fdc`), run
36627517591, artifact 11062164175. The pin records:
- the PR, code commit and tree, and workflow run id;
- the artifact id and name;
- the artifact ZIP digest;
- the sha256 of D06's closeout `evidence-manifest.json`.

It also pins by sha256 each consumed file:
- the current surface;
- the deployment manifest;
- the reserve manifest;
- the history report, whose `ReserveInitialized` records are the only source
  of token addresses and index start blocks;
- the evidence manifest.

Validation:
- The live workflow checks, through the GitHub API and before any file is
  used, that the run's head is the pinned commit and concluded `success`. It
  also checks that the commit's tree is the pinned tree, and that the
  artifact belongs to that run and has the pinned name and digest.
- Offline, both the workflow and every Rust stage, replay, candidates and
  reconcile binary (`inputs::verify_upstream`, shared with RMC-008) check
  the evidence manifest. It must be the declared one, it must have been
  written by the pinned commit and tree, and it must list every consumed
  closeout file with its pinned digest.
- The closeout's `evidence-manifest.json` records the sources as
  `upstream_sources` (provenance).
- The Rust readers require the D06 schemas, `HISTORY_RECONCILIATION_PASS`
  with zero unexplained deltas and zero provider mismatches, and the declared
  anchor.

While `status` is not `PINNED`, the default live workflow stops at
`RMC009_BLOCKED`. "Latest successful artifact" is never consumed.

For RMC-010's later-anchor full census, `workflow_dispatch` also accepts an
explicit alternate anchor plus the complete D06 run/artifact identity
(run id, artifact id/name/digest and D06 exact-head commit). All seven fields
are required together. The workflow verifies that identity through the GitHub
API, including the commit's tree and that the artifact belongs to the run.
It downloads only that artifact and hashes the five consumed D06 files, the
evidence manifest among them. It then binds them to that manifest exactly as
above and materializes a run-local `account-inputs.json`. Every stage, replay and
closeout consumes that immutable run-local pin file and is explicitly bound to
the supplied anchor. This path never resolves a "latest" run or artifact.

## 2. Completeness basis

Aave's tokens keep `_totalSupply` equal to the sum of every holder's scaled
balance:
- `_mint` and `_burn` change both by the same amount;
- `_transfer` moves balance between holders;
- `scaledTotalSupply()` returns `_totalSupply`, and `scaledBalanceOf(user)`
  returns the holder balance.

This is design rationale from the upstream source, not certified authority.

RMC-009 therefore proves completeness per token at the anchor. For every
aToken and variable debt token, in exact 256-bit integers:

    Σ scaledBalanceOf(a) over indexed accounts a
      + scaledBalanceOf(0x0)                        ==  scaledTotalSupply()

Balances are unsigned. If the equality holds, no account outside the index
holds a balance. If a holder is missed, a deficit remains and the census
blocks (`MISSING_HOLDERS`). A sum above supply is `EXCESS_OVER_SUPPLY`. An
unreadable zero-address term (`ZERO_ADDRESS_BALANCE_UNREADABLE`, with a
`ZERO_ADDRESS_SCALED_BALANCE` mismatch) blocks, and is never read as zero.
Nothing is inferred from the absence of a log.

**The zero address is a conservation term, never an account.** Aave V3's
aToken `_transfer` and the Pool's `supply(onBehalfOf)` do not refuse the zero
address, so it can be credited a scaled balance that no key can move.
- Evidence of the contradiction: RMC-009 live run 36674256094 (head
  `38d5f77d`) indexed 3,791,094 logs on two agreeing providers. 13 of them
  name the zero address as account, and its candidates gate blocked on
  `zero_account_logs == 0`. That gate assumed the zero address never holds
  a balance; mainnet contradicts it.
- Probe run 36678968936 (read-only, both providers agreeing, anchor
  25,437,474) established the semantics:
  - the 13 logs are 5 Pool `supply`/`deposit` Mints with `onBehalfOf = 0x0`
    and 8 aToken `transfer(0x0, …)` BalanceTransfers, all on aTokens,
    across 7 aTokens;
  - exactly those 7 aTokens hold a nonzero `scaledBalanceOf(0x0)` at the
    anchor (for example `0x4c61…dd4c` holds 46,009,962,639,660,383,542
    scaled);
  - the other 127 tokens, all 67 variable debt tokens among them, hold 0.
- The design was corrected, not the evidence:
  - `ACCOUNT_TOKENS` reads `scaledBalanceOf(0x0)` for every aToken and
    variable debt token, whether or not a log names it;
  - the core `Address` type (non-zero by construction) keeps the zero
    address out of the account universe and the candidates;
  - every index log naming it is kept by coordinate (block, log index,
    transaction, token, event, topic 1) in the index job output, and in
    `acquisition-provenance.json`;
  - `token-conservation.jsonl` carries `zero_address_scaled_balance` per
    token;
  - `zero_address_holding_tokens` is a census metric, because it is anchor
    state. The zero-address log count and coordinates are history, so they
    are provenance: a full census holds all of them, an incremental refresh
    its delta's;
  - the independent recount re-derives the identity.

Stable debt: every stable debt token's `totalSupply()` must be `0` at the
anchor (probe run 36590720390 measured 67/67). Otherwise
`STABLE_DEBT_POSITIONS_PRESENT` blocks, because the universe does not cover
stable positions.

## 3. Acquisition

Every stage runs on one provider, persists every exchange and observation
in RMC-004, and emits a record that the reconciler replays byte for byte.

- **`ACCOUNT_INDEX` (candidate hints).**
  - For every admitted token it collects every `Mint` log, whose topic 2 is
    `onBehalfOf`. Mint covers supply, borrow, treasury accrual and interest
    minted on a burn.
  - For every aToken it collects every `BalanceTransfer` log, whose topic 2
    is `to`. This covers transfers and liquidation transfers; debt tokens are
    not transferable.
  - The range runs from the earliest reserve initialization to the anchor,
    on a global grid of 200,000-block jobs, partitioned by job index.
  - Every log's shape is checked: emitter, three topics, a canonical address
    word, data length, not removed. An undeclared shape fails closed.
  - Each job emits its candidate pairs, a digest of every log, and the
    coordinates of every log naming the zero address (job version 2).
  - Logs are not bound to headers, because nothing is concluded from them:
    completeness comes from section 2.
  - Tenderly uses 5,000-block log windows. MEV Blocker uses 2,500-block
    windows (up to four transported in one JSON-RPC batch). Live run
    36636132821 proved that a 10,000-block account-log request can exceed its
    10,000-result cap; the failing response suggested a 7,447-block maximum
    at that density. The 2,500-block bound is one third of that observed
    maximum, leaving room for substantially denser bursts rather than merely
    retrying an intrinsically oversized request. A failed range is never read
    as empty. Probe run 36590720390 found no other keyless endpoint serving
    these logs over this range.
  - **Result caps are refusals, not outages.** A fixed window cannot bound a
    result count, because log density is not bounded by block span. Live run
    36648778677 and probe run 36656954422 showed both declared windows
    refused near block 24,911,792:
    - Tenderly caps a response at 20,000 logs. It refused 24,911,792–24,916,791
      and 24,916,792–24,921,791 with `-32602 "invalid params"`, the count only
      in `data`. Every 2,500-block half of those windows was answered.
    - MEV Blocker caps at 10,000. It refused 2,500 blocks from 24,911,792 with
      `-32005 "query returned more than 10000 results"`, suggesting 2,350
      blocks.
    Each index job therefore runs on a declared log-window ladder: the
    provider's window, then up to five halvings (MEV Blocker 2,500 → 78,
    Tenderly 5,000 → 156). The stage record declares the ladder as
    `log_window_ladder`. Each rung is its own RMC-004 stream, because the
    provider descriptor, window included, is part of the job's stream kind.
    - A result-cap refusal descends one rung.
    - A result-cap refusal is `RangeTooLarge`, `RetryBudgetExhausted` whose
      last error names a result count, or a `-32602`/`-32005` provider
      error. The frozen RMC-003.2 transport retries `-32005` as a rate limit,
      and its typed error drops Tenderly's `data`.
    - Only a rung whose every sub-range was answered commits. A refused rung
      commits nothing.
    - A refusal at the last rung fails the job closed with
      `RMC009_RESULT_CAP_FLOOR`, and the stage stops at once.
    - Resume and offline replay find a job's committed rung read-only. Exactly
      one rung may hold a job; otherwise the job fails.
    - Rows carry only economic content, so providers that committed on
      different rungs still reconcile exactly.
  - **Deterministic refusals stop a stage.** In both stage loops:
    - `RMC009_RESULT_CAP_FLOOR` ends the stage on its first occurrence.
    - The same `-32600`/`-32601`/`-32602` error on two consecutive attempts,
      with no new committed checkpoint, ends it as
      `RMC009_DETERMINISTIC_PROVIDER_REFUSAL`.
    - Transport failures and rate limits keep the full retry budget.
- **Candidates (offline).** Every index record is replayed. Both providers'
  partitions must tile the grid, and both providers must return identical
  logs for every job. Any difference fails closed; there is no union across
  disagreeing providers. The output is `candidate-accounts.jsonl`, bound into
  every state stage by digest.
- **`ACCOUNT_TOKENS`.** For each reserve initialization:
  - aToken and debt-token `scaledTotalSupply()`;
  - aToken and debt-token `scaledBalanceOf(0x0)` (section 2);
  - stable `totalSupply()`;
  - for current reserves, `getReserveData`, whose tokens must be the D06
    ones.
- **`ACCOUNT_STATE` (16 partitions of the candidates).**
  - For each (account, token) candidate: `scaledBalanceOf` and `balanceOf`.
  - For each account: `getUserConfiguration`.
  - For each account holding anything or flagged: `getUserEMode` and
    `getUserAccountData`. The latter consults untrusted oracle sources and
    runs under a fixed gas bound, and a revert or halt is kept as a status.
  - Providers are blastapi and mevblocker (`state-providers.json`, shared
    with RMC-008).

## 4. Verification and records

Two providers must return identical rows for every token supply and every
account. Any difference fails closed. On the agreed rows:
- per-token conservation (section 2);
- every scaled balance, balance and configuration must be a canonical
  `uint256`, otherwise it is an unexplained mismatch;
- a configuration bit for an unknown reserve id is an unexplained mismatch.

Configuration flags are compared with balances and every difference is
recorded in `configuration-divergences.jsonl`:
- `BORROWING_FLAG_WITHOUT_DEBT`;
- `DEBT_WITHOUT_BORROWING_FLAG`;
- `COLLATERAL_FLAG_WITHOUT_SUPPLY`.

These are exact protocol state, not reconstruction errors, so they do not
block. They are never hidden.

Metrics (`account-metrics.json`):

| metric | meaning |
|---|---|
| `indexed_accounts` / `indexed_pairs` | candidates from the agreed index |
| `state_verified_accounts` | accounts read at the anchor with two providers identical |
| `stale_accounts` | accounts read at any other anchor (must be 0) |
| `missing_holder_tokens` | tokens whose supply exceeds the indexed sum (must be 0) |
| `extra_accounts` | indexed accounts with no position and no flag at the anchor |
| `mismatched_accounts` | accounts with any unexplained mismatch (must be 0) |
| `actionable_accounts` | accounts carrying variable debt, with exact, conserved state |
| `health_factor_below_one` | of those, the protocol's own `getUserAccountData` health factor < 1e18 |
| `zero_address_holding_tokens` | tokens whose `scaledBalanceOf(0x0)` is nonzero at the anchor (a conservation term, never an account) |

`actionable` means "in scope for a later liquidation-truth layer". It is not
a claim that a liquidation is possible or profitable.

Uniswap V2: `NOT_APPLICABLE`. Pairs carry no borrower, debt or collateral
positions, and nothing is fabricated for them.

## 5. Public RPC load

Live acquisition runs only from `workflow_dispatch` on the exact branch head,
in RMC-009's own concurrency group `nqc-rmc009-live-<ref>`, and concurrency
never cancels it. GitHub keeps one pending run per group, and a newer pending
run replaces an older one. The repository-wide group `nqc-census-public-rpc`
therefore let one Census node's dispatch evict another node's pending
certification; RMC-010 left it for the same reason. Each provider client
still keeps its declared request interval. A `pull_request` run verifies the
pinned inputs only, in a per-ref group.

Load limits:
- the index matrix runs at most 4 jobs at once, and the state matrix at
  most 6;
- transient failures are retried by the chain layer, then by up to ten
  attempts that resume from committed RMC-004 checkpoints;
- a failed range is never read as empty, and a semantic disagreement is
  never retried.

Every stage artifact is uploaded even on failure. Its name carries stage,
provider, partition, exact head, run id and attempt. The replay consumes
the latest attempt of each stage and lists every attempt.

Stage stores are never gathered on one runner. RMC-007 run 36589054151
showed why: a reconcile that downloaded all 49 stage artifacts at once
failed with "Artifact download failed after 5 retries". Instead:
- **replay, one offline job per stage** (`nqc-rmc009-account-replay`, no
  network namespace). It downloads that stage's artifact only and restores
  the store's documented empty directories, which artifact upload drops.
  It verifies the store before and after, and replays the record
  byte-for-byte (state records with the candidates). It then replays the
  record's bootstrap and anchor manifests and writes an extract: the record
  and its sha256, the replayed rows and their digest, the chain domain and
  anchor, and the store's evidence root.
- **candidates** are derived from the index extracts, and the
  **reconciler** holds extracts only. Both recompute every digest and require
  one chain domain, the plan's anchor, and the plan's pool and token digest in
  every record. They then run the same derivation and verification as before
  (`reconcile_extracts` and `reconcile_offline` share it).

## 6. Closeout

Written twice offline, with no network namespace, and compared byte for byte
(`evidence-manifest.json` lists each stage's own store summary when stages
were replayed one store at a time):
`account-manifest.jsonl`, `token-conservation.jsonl`, `reserve-tokens.jsonl`,
`configuration-divergences.jsonl`, `mismatch-ledger.jsonl`,
`candidate-accounts.jsonl`, `account-metrics.json`, `account-summary.json`
and `evidence-manifest.json`.

These are the census artifacts, except `evidence-manifest.json`. They depend
only on the anchor, so they must be byte-identical whether the anchor was
reached by a full census or by an incremental refresh from a certified base.
The provenance is mode-dependent and kept out of them:
- how the anchor was reached (mode, index log counts, record count) goes in
  `acquisition-provenance.json`;
- exact producer code commit/tree, input pins, records and store support go
  in `evidence-manifest.json`. Code identity is deliberately not copied
  into `account-summary.json`, because it is provenance rather than census
  state and would make a correct full/incremental parity proof impossible
  across distinct exact-head producers.

The plan's `index_start` defaults to the earliest reserve initialization. An
incremental refresh sets it to the block after its certified base anchor.

`generated_at` is the anchor block timestamp. An independent Python pass,
`recount_account_universe.py`:
- re-hashes every artifact first, and uses no content whose digest differs;
- re-sums every scaled balance per token and requires it, plus the zero
  address's scaled balance, to equal the supply;
- requires that no account is the zero address, and that every zero-address
  log in provenance is unique and names a census token;
- recounts the classifications.

PASS requires:
- every token conserved, zero-address term included;
- zero unexplained mismatches;
- no blocking finding;
- two-provider agreement everywhere.

## 7. Non-claims

Not claimed:
- liquidatability, profitability or execution;
- oracle freshness;
- positions outside the D06-admitted pool;
- any Uniswap V2 account universe.
