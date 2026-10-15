# NQC V2 — Precommitted Morpho cbXRP / USDC Base borrower cohort, two public API observations

## Critical economic question

PR741 authenticated a **single-indexer** subset of 23 complete days of historical Morpho liquidations: Base cbXRP/USDC 418 Liquidate events, 227 unique third-party winning transactions, nominal 1,281,537.248484 USDC repaid. PR742 could **not** authenticate original Base receipts (HTTP403 on canonical deployed Morpho `eth_getCode`). PR743 independently obtained six present-time *unexecuted* exact-size cbXRP→USDC route quotes; comparing a quote now against old debt is a cross-time sensitivity, never historical profit. No permitted inference from these studies is NQC's prospective eligibility or capture probability.

## New source-test, deliberately independent of retrospective winners

The [official Morpho API](https://docs.morpho.org/developers/api/morpho/) documents `marketPositions` queries and the GraphQL endpoint. [Morpho's public blue liquidation bot](https://github.com/morpho-org/morpho-bots/blob/main/bots/blue-liquidation/README.md) already uses `healthFactor_lte` and asc health-factor pagination, then recomputes accrued risk onchain through a lens. That bot explicitly requires a **funded gas EOA**; merely querying this same free API does **not** establish a unique searcher advantage. Its fork broadcast test is fixture-gated.

The next test will *actually query* public Morpho GraphQL, chain Base 8453, market ID `0xd4a903dc6d949519060c7707f9604fdc9772c046e05c2e3a8fce0bd7196e4109`:

1. **BEFORE looking for any next-market outcome**, query and preserve top-30 borrowers by `BorrowShares` and up to 30 `HealthFactor <= 1.08` borrowers, two bounded public GraphQL requests. Validate market ID, address, nonnegative integer raw shares, debt and collateral and source `pageInfo` agreement. An API-censored page or moved pagination is not silently assumed complete.
2. Deduplicate and freeze **at most 60** `(market ID, borrower)` public onchain identities and source debt/collateral snapshots. Write SHA-256 of frozen JSON **before** any second observation and preserve original timestamps and source, with no retrieval of already-known liquidation winners as the cohort-selection mechanism.
3. Wait **35 seconds** within this **one-shot read-only GitHub Actions job**, then query only these 60 already-frozen addresses, do not expand to newly seen borrowers. Preserve raw deltas as *two Morpho indexer observations*; missing rows are **not** evidence of liquidations, changes can result from debt accrual, market state, API lags, or user behavior. Check the frozen artifact still matches its precommit digest after follow-up.
4. Publish terminal status `TWO_TIME_ORDERED_MORPHO_API_SNAPSHOTS_INDEXER_ONLY`, `SOURCE_CENSORED_UNIVERSE_BUT_FIXED_COHORT_VALID`, or `INCOMPLETE_MORPHO_PROSPECTIVE_SOURCE`. The code **must never certify canonical Base block state** or profitable/competitive liquidations solely from this indexer. A negative universe with zero borrowers is narrow source observation and does not imply no global market opportunity.
5. Source-sensitive adversarial offline tests challenge wrong market, invalid addresses/amounts, duplicates, mutable freeze, protocol schema, malformed page, no capital underwriting, post-freeze cohort leakage, wrong timing, 402/403/429 refusal, and false net-P&L promotion. The workflow admits at most four read-only HTTP POST requests, fixed host, no retries, no GraphQL mutation, no blockchain JSON-RPC and no wallet.

## Explicit lack of promotion

Even if the near-risk API query finds `HF <= 1.00` borrowers, it cannot establish true eligibility without authenticated same-block Morpho `market()`/`position()` and oracle/IRM state; indexer timestamps and ordering are not builder cutoff. No profits can be inferred from collateral values without DEX quote at the same block, atomic Morpho flash + liquidation + swap + repay, all L2/L1 gas and bid fees, failed operations, signer/bundler acceptance and third-party no-recourse native gas.

No exploit attempts, privileged RPC, rate-limit evasion, account setup, trading, gas expenditure, capital deposit, new subscription, repository merge, or sign. NQC realized P&L USD 0, OWN_CAPITAL USD0 incl gas, owner's MXN2000 remains untouched. No new Chainlink contact; Astra's independent underwriting research continues outside this PR. Commercial 5.8/10 and economic validation 4/10 are **not automatically raised** by successful tests or two API observations. Evidence must *lower* confidence if official API fails or publicly accessible discovery proves no defensible edge.

If authentic source yields useful cohort rows, the next decisive step is one **authorized**, frozen block-specific deployed Morpho/IRM/oracle read-only state interrogation to reproduce HF. Without a permitted provider, remain `NOT_CANONICAL` rather than relaxing evidence standards.
