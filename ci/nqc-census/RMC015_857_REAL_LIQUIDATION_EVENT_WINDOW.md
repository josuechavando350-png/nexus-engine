# RMC-015 — 857 no-hindsight borrowers matched to real subsequent Aave liquidation receipts

This is a second independently audited complement to [PR #647](https://github.com/josuechavando350-png/nexus-engine/pull/647), which found **851 healthy and 6 debt-free at the second endpoint**, with zero accounts below HF 1 *at either measured endpoint*. Two endpoints can miss a genuine liquidation episode that happened in between. This experiment checks that failure mode using every real canonical Aave V3 LiquidationCall event in the complete **7,200-block successor window**.

## Fixed risk set and causal direction

The source is the complete immutable D08/D09 Ethereum Aave anchor **block 26095351**, original D08 ZIP SHA256 9431ea07144ae78e68e0ffcc7f650fa32068ee63fb53ca41ff8a062b87845913 and D09 ZIP SHA256 9aa6a4beb3ebc90f40d07d1889f84c1bcf94b3dea90b0e7b596dc6ff70fda0f6. The 857 healthy material borrowers (1 <= HF < 1.2, >=10k oracle base debt) are selected exclusively using the source material frontier PR #605 Git blob 5542bbec0840335994cbbab272e6228756ba6eb0.

The subsequent observed window is [26095352, 26102551] inclusive, strictly later than the selection block; no future winner determines inclusion in the source set. Source selection independently conserves all 857 original borrower identities privately, without uploading or exposing their addresses.

## Full public event census in the bounded window

Independently request **all Aave V3 LiquidationCall logs** from real Ethereum deployed pool 0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2 over 15 strictly disjoint consecutive 480-block partitions, via distinct dRPC and BlastAPI Ethereum archive providers. Require exact ERC event topic signature 0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286, contract address, three indexed addresses including borrower, exactly four ABI data words, positive actual debt collateral amounts, canonical event block number, block hash, transaction index, global log index and transaction hash. Reject removed/reorganized log entries and duplicates. Independently fetch canonical block hashes/state-root headers for every observed event block and verify exact log block hash; reject any operator disagreement on the **entire** event set, not just convenient matched logs.

The result reports all true observed liquidation logs in the window and the number of historical third-party liquidations that intersect the original 857 source borrowers. Aggregate classifications include WETH/WETH-style same-asset vs cross-asset events and distinct historical winner transactions/borrowers. Original addresses are not returned or published.

## What this does and does not prove

A matching liquidation event is a **genuine third-party included Aave liquidation** after original Census cohort selection. It demonstrates **the realized incidence within the original cohort**, which two endpoint HF snapshots alone cannot reconstruct. A zero matched event count does NOT prove the absence of fleeting opportunities that no one successfully liquidated. A nonzero count does NOT prove Nexus knew about it before its inclusion, could fund native ETH gas, would win a builder auction, profit after collateral swaps or capture any retained net income.

The actual event source includes third-party winners, not authorized NQC execution. No paid subscription, account creation, mainnet transaction, wallet, private key, trade or user funds used. Terminal RMC011/012/013/014/015/016/017 still blocked; NQC realized profits remain 0 proven.

## Next economic admission tests

If realized cohort-liquidation winners exist, determine real winning timestamp, exact predecessor state, token/route/gas/builder payments, source-first alarm timestamp and whether any bound before inclusion can be justified. Compare to true independent no-lookahead risk detection and the originally mandated zero-own-capital nonrecourse gas sponsor. Only successful net and capture evidence can feed full Shadow economic capacity.

**A superior system decides when NOT to compete.** This research measures actual future-event supply rather than claiming NQC can win every visible bonus.
