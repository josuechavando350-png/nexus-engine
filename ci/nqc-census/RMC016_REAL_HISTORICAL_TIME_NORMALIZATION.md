# RMC-016 — Actual historical Ethereum elapsed-duration of original market economics

**Goal:** establish how much *real clock time* passed between the original D16 source start/end blocks in order to describe the observed 139 competitor liquidation events / 127 winning txs in correct temporal units. This is **not** an estimate of actual or prospective Nexus profitability.

## Original immutable economic authorities

The prior original D16 Census source `ci/nqc-census/rmc016-production-evidence.json` has pinned Git blob SHA1 `5d5ed3635a426d686c8a98aa3547fd5b9d8b95aa` and authority commitment `0xa952f2a3af9c1cef8103a9ad9586f62bc3548d0bdee2c7c1c7ae60018490396c`. Window Ethereum blocks **25,880,316..26,095,351**, exact hashes respectively `0x0b29e0c8c1997f059f82e7fed67e047269f68422ab194d56546c1c9833469d96`, `0x0d7a15fbb72e69696a33c65bc20902fe08e5630862ada64b065a97405c70c781`. Observed only: **139 liquidations; 127 winning third-party transactions; USD 138,045.17469031 gross oracle margin; USD 1,144.134260592713842029 of winner-paid gas; USD 136,901.040429717286157971 partially reduced by that winner-paid gas alone**. This is *not exact total margin from every Aave protocol opportunity, and not the complete route/MEV/flash/infra/net calculation*.

The directly preceding [PR #652](https://github.com/josuechavando350-png/nexus-engine/pull/652), exact head `c5b22decc7356d3a1d4131f8524bdec0459aa1ac`, independently certifies necessary (not sufficient or likely achievable) original-window market gross shares for USD 15k/55k. Preserve its source code and arithmetic unchanged.

The original external NQC gas provider registry is **zero approved gas providers**, original Git blob SHA1 `a9c1427bb05828d08ade537899ee1b8e43b97ed2`. No signed nonrecourse gas sponsorship, no captures and no NQC net P&L are authenticated.

## New historical clock data: independently witnessed real Ethereum headers

Read exactly `eth_chainId` and `eth_getBlockByNumber(block,false)` at both source heights using **dRPC and BlastAPI**, distinct independent Ethereum historical archive operators. Validate chain 1, exact original source height+hash, both parent hashes, state roots, canonical hex quantities, and an actual monotone bounded elapsed duration. Both operators' full normalized headers MUST match exactly; otherwise fail closed and emit no report. No third-party estimates or assumed 12-second block duration in the primary observation.

Integer-only formulas:

- `elapsed_seconds = timestamp(last block) - timestamp(first block)`.
- `observed_daily_market_oracle_gross = floor(original_139_event_market_oracle_gross_WAD * 86400 / elapsed_seconds)`.
- `observed_daily_partial_after_original_competitor_gas = floor((oracle_gross - actually paid competitor gas) * 86400 / elapsed_seconds)`.
- `observed_30_day_equivalent_from_THIS_HISTORICAL_WINDOW = floor(oracle_gross * 30 * 86400 / elapsed_seconds)`.

The last two are historical normalization ONLY, not prices, forward rates, NQC capture opportunities or realized NQC proceeds. A 30-day equivalent from this one observed interval **does not** establish stationarity, repeated monthly flow, ability to enter a competitor's past block, execution of route/financing or a probability of capturing any share. The original $15k/$55k necessary-share bounds continue to apply to the exact original source interval only; their use for a future calendar month is not asserted.

## Source and terminal restrictions

- Original RMC016 D16 scope: observed market baseline / conservative realized NQC capacity LOWER BOUND 0, capture uncalibrated.
- RMC011 source: no authorized external native gas provider, no own capital.
- Original historical market gross and competitor-paid gas: **not Nexus profit**.
- Hist observed 30-day-normalized oracle margin: **not a forward expected value, robust upper bound on NQC profit or reliability forecast**.
- RMC011/015/016/017 terminal certification remains FALSE. No real user capital, API signup, paid service, wallets, signing, live transactions, main merge or claim that Census is closed.

**Falsification:** either exact hash, timestamp, block number, state root, original source blob, gas registry or independent RPC operator changes/disagrees; implausible time interval; noncanonical quantities; source economic WAD drift; altered zero-NQC-capture nonclaims; any provenance not reproduced -> FAIL CLOSED.
