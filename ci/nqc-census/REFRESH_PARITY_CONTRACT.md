# RMC-010 — Incremental Refresh and Full-Census Parity Contract

Scope: reaching the census at a target anchor A1 from a certified census at a
base anchor A0, so that the result is byte-identical to a full census at A1.
This PR covers the RMC-009 account universe. The RMC-006 reserve lifecycle
and the RMC-007 pair universe follow the same rule once those nodes are
merged and their anchors are parameterized. RMC-010 makes no economic claim.

Authorities reused: RMC-009's stages, candidate derivation, verifier and
closeout, used unmodified; RMC-008's stage anchor, replay owner and manifest
helpers; the shared `nqc-census-chain` layer and the RMC-004 store. No core,
store, chain, RMC-008 or RMC-009 code changes in this node.

## 1. What a refresh may reuse

Only what a certified base can vouch for.

- **Event-derived universes** are the base plus a delta. The account
  candidates at A1 are the certified base candidates united with the
  candidates of a delta index over `(A0, A1]`, which starts at A0 + 1 via
  RMC-009's `index_start`.
- **Time-dependent facts are re-read at A1**, exactly as a full census reads
  them: supplies, balances, configurations, eMode and account data. Nothing
  is carried over from A0.

The base is a certified RMC-009 closeout. It must meet all of these:
- its summary is `RMC_009_PASS_CANDIDATE`;
- every artifact matches its evidence-manifest digest;
- its candidates are the ones its summary names;
- it states its anchor (number and hash).

`delta_plan` refuses a target plan in any of these cases:
- a base token is missing from it;
- a base token has another initialization block;
- it has a token initialized at or before A0 that the base never indexed.

## 2. Base canonicality

`BASE_CANONICALITY` runs on two providers, pinned to A1. It reads the
verified header at the base height, and its hash must be the certified base
hash on every provider.

- A different hash is `BASE_REORGED`: the refresh is refused and a full
  census is required.
- Providers that differ fail closed.
- A provider that cannot serve A1 fails the stage. It is stale, and it is
  never read as empty.

## 3. Incremental reconciliation

`reconcile_incremental` replays every record from the store, byte for byte:
- the canonicality records;
- the delta index records, on the delta plan;
- the token and state records, on the target plan.

Then:
- the delta candidates are derived exactly as RMC-009 derives them: two
  providers, identical logs, and partitions tiling the delta grid;
- base ∪ delta must equal the candidates the state stages were run for;
- RMC-009's verifier runs unchanged, including per-token conservation at A1.

A base that forgot a holder is refused against the certified candidates.
Used consistently, it leaves a conservation deficit.

## 4. Parity

`census_parity(full, incremental)` requires the same set of census artifacts
and byte-identical contents. The full side must be a `FULL_CENSUS` and the
other an `INCREMENTAL_REFRESH`.

Only two files are excluded from the comparison, because they are
provenance and not census content:
- `acquisition-provenance.json`: mode, base, delta counts and record count;
- `evidence-manifest.json`: records and store.

## 5. Adversarial coverage (synthetic, `refresh_parity.rs`)

| requirement | test |
|---|---|
| parity with a new market, new accounts, a transfer to a new account, repaid debt, flag changes, accrual | `incremental_refresh_equals_a_full_census_byte_for_byte` |
| position, liquidity and config changes reflected at A1, not carried from A0 | same test (the base differs from both) |
| idempotency; a refresh to the base anchor is the identity | `a_refresh_to_the_base_anchor_is_the_identity_and_reruns_are_idempotent` |
| reorg below the base anchor | `a_reorged_base_refuses_the_refresh_while_a_full_census_succeeds` |
| stale provider | `a_stale_provider_fails_the_refresh_and_is_never_read_as_empty` |
| provider disagreement, duplicate event, missing range | `delta_disagreement_duplicates_and_missing_ranges_fail_closed` |
| incomplete, forged or tampered base; dropped market | `an_incomplete_or_tampered_base_is_refused` |
| crash and resume, retry after rate limit | `an_interrupted_delta_resumes_and_rate_limits_are_retried` |

Not yet covered here, and owned by the nodes they belong to:
- oracle and token-code changes at the RMC-008 state layer;
- reserve and pair lifecycle deltas for RMC-006 and RMC-007;
- a crash between evidence write and head update, which is RMC-004's
  existing crash matrix.

## 6. Live certification

Blocked. A live refresh needs:
- certified RMC-006 and RMC-009 closeouts at A0;
- an RMC-006 run at A1, for the target plan;
- a second anchor declared for both the full and the incremental path.

Synthetic tests prove implementation behavior only. They are not chain
evidence.

## 7. Non-claims

Not claimed:
- lifecycle refresh for RMC-006 and RMC-007;
- live parity;
- liquidatability, profitability or execution.
