# NQC V2 — Canonical Aave WETH price path for verified primary/secondary oracle transactions

## Critical falsifiable economic-state question

PR #707 corrected the historical ETH/USD oracle log identity and found exactly two primary NewTransmission and two secondary SecondaryRoundIdUpdated events in a preselected 720-block sample. PR #709 proved four real receipts and their exact position:
- Chainlink round 24872: primary block 26188304 tx index 71; secondary block 26188305 index 53 (one-block/12-second separation).
- Round 24873: primary block 26188605 tx index 51; secondary same block index 52.
- PR #709 positive source run 38519386037, artifact 11873371179, ZIP SHA-256 5e5684fb4a98b87b1d9e2f15facb03ddb093e50a6e75ff4553b79fc192e69d38, producer SHA 635a10da08bb5b4cea7639c555cb2ddf7b38c551. dRPC receipts/source status verified, BlastAPI 429: **single RPC receipt authority** only.

Event-level ordering is insufficient to know when Aave's actual WETH price changes. The source contract has a primary reported answer and a secondary synchronization pathway; these may affect the Aave-facing proxy differently. Do not identify a liquidation trigger based on an event alone.

## New deterministic fork gate

1. Authenticates PR709 ZIP byte SHA-256 and every member of its content-addressed manifest; authenticates the nested PR707 event corpus against its original source SHA and inherited historical positive controls; forbids promotion of the failed Blast RPC receipt source to parity.
2. Selects exactly the four PR709-confirmed transactions with canonical block, transaction index, global event index, Chainlink round and event-family source identity. No candidate choice based on observed poststate or profit.
3. For each case and public endpoint, checks the exact block header against the archived hash and timestamp before and after the fork. On the fork, createSelectFork(rpc, txHash) starts at the *exact transaction prestate*, not at the block's final state. The original historical transaction is then replayed once with vm.transact(txHash).
4. Reads Aave V3 Pool.ADDRESSES_PROVIDER -> PriceOracle -> getSourceOfAsset(WETH) and requires the WETH source's underlying aggregator equals the archived historical ETH/USD DualAggregator. Before and after replay, reads Aave's exact getAssetPrice(WETH) and the Chainlink proxy's latestRoundData answer/round; requires the canonical indexed round/event family was emitted exactly once. No oracle mutation or test-only fake report.
5. Logs canonical integer values and detects whether Aave's asset price actually changed. The primary event may or may not change the Aave-facing price; the secondary event does not contain a price answer in its event data. Every negative is preserved.
6. Exact-head GitHub Actions verifies all source SHA identities and offline adversarial tests, tests all four cases with timeouts and conservative RPC throughput, archives source, fork logs, positive and negative outcomes. If source limits prevent a fork test, it remains UNKNOWN_INCOMPLETE_PRICE_PATH, never zero impact.

## What a positive fork means, and what it does not

A positive price-path measurement demonstrates only the historical prestate/poststate effect of a transaction on the Aave WETH price observable to an EVM call. It does **not** prove that any real active borrower crossed HF<1 at those blocks, that the pending report was observable with sufficient lead, that a liquidator could be included in between two reports, that a route had positive net EV, or that a native gas sponsor covers all operator recourse.

An Aave price change may produce no liquidation opportunity in the actual market. If a secondary event changes the Aave price after a primary event has already landed, this is a potential signal for *future study*, not a financial edge to assume.

PFT CLOSED; RMC OPEN; Shadow P2 uncertified; LIVE not authorized; Comercial 5.9 unchanged; OWN_CAPITAL=0 USD including native gas, obligations and failure paths not proven; realized NQC P&L USD 0. No signing, broadcast, builder payment, contract production deployment, server access change, or new cloud/API charges.
