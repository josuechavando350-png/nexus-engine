# NQC V2 — PREINCLUSION-003, canonical WETH oracle denominator for Flashbots SSE

## A falsifiable question, not another generic connectivity check
PR734 authenticated one read-only SSE HTTP200 connection, 144 process-local hints, zero decoded WETH target. That 24-second target zero cannot estimate detection because the WETH aggregator may not have updated at all. A separate post-window, single-provider chain read found WETH updatedAt 2026-10-14 23:10:47 UTC, before the PR734 stream at 23:23:25–23:23:50 UTC. The previous read was not a certified exhaustive log census.

We now **freeze WETH source identities before any RPC or SSE request**, read its canonical price/round at a safely pinned block, observe ONE public Flashbots SSE GET for up to 180 seconds, and read its exact canonical price/round at a later height. This supplies a time-scoped, round-based price update denominator without falsely treating silence as an unavailable market.

## Frozen target and instrumentation
- Ethereum mainnet Chain ID 1. WETH Aave source proxy: 0x5424384b256154046e9667ddfaaa5e550145215e, aggregator: 0x7c7fdfca295a787ded12bb5c1a49a8d2cc20e3f8. Prior NQC PR732 verified the Aave Pool source path and exact aggregator at block 26193763. A further read-only onchain typeAndVersion check at the same block returned DualAggregator 1.0.0. This identity fact does not prove that a private SVR report is delivered in advance.
- Two public providers only: dRPC and PublicNode. For EACH before/after snapshot choose min observed tips minus 2, require tips within 3 blocks, chain 1, identical numbered headers with hash/parent/stateRoot/time, EIP-1898 requireCanonical=true calls and runtime bytecode for the declared proxy and aggregator only. Positive signed integer price, round ID, timestamps, matching proxy/aggregator answer and updatedAt. Re-read the original header after each snapshot to detect reorg. Fail closed on transport error, 403/429, RPC disagreement or too-old/stale tip.
- One documented public SSE GET to https://mev-share.flashbots.net, bounded to 180 seconds / 20 MB / 8,000 data frames / 200k event bytes; no retries, no evasion or alternate identity. Existing PR734 parser defaults of 24 seconds and 512k bytes remain unchanged; this run passes explicit larger finite budgets. Received third-party hints are never uploaded raw: only SHA256 and bounded data-independent verdicts, at most 40 sample digests.
- Local UTC and monotonic timestamps are process reception times only, NOT first-seen network times. The finite SSE observation is between two source snapshots, so its edges are left/right censored relative to potential oracle round updates. No construction of competitor transactions or use of outcome to select borrowers.

## Exact decisions
- NO_WETH_ROUND_ADVANCE_BETWEEN_PINNED_BOOKENDS: canonical WETH round ID and updatedAt unchanged across two later Ethereum blocks; no positive oracle-update denominator during the full bookended range, and detection recall remains NOT ESTIMABLE.
- WETH_FEED_CHANGED_IN_BOOKENDS_NOT_PREINCLUSION_PROOF: a round change occurred between snapshots and source-local SSE frame collection completed without error. This is a positive round observation but still cannot prove that any report was received before builder deadline or that NQC can submit an eligible bid.
- WETH_FEED_CHANGED_BUT_SSE_OBSERVATION_CENSORED, INCOMPLETE_*: explicit blockers, not zeros. New oracle round could be a primary/public fallback, not necessarily a private Chainlink SVR report.
- A green GitHub workflow certifies source instrumentation and reproducible censoring only. NQC target detection/capture probabilities, builder cutoff, auction winning bids, full atomic liquidation profitability and fees, sponsoring gas without recourse, and realized revenue all remain unproven.

## Financial and ownership controls
PROTOCOL_FORK_TRUTH CLOSED; REAL MARKET CENSUS OPEN; SHADOW P2 UNCERTIFIED; CANARY/LIVE UNAUTHORIZED; OWN_CAPITAL USD 0 including gas and all contingent liabilities. MXN 2,000 owner reserve untouched. No paid providers, new host, persistent watcher, signing, transaction submission, private key, bundle, gas, relay bid, capital arrangement, merge, or setting change. NQC intellectual property stays exclusively under operator control. Commercial rating 5.9/10 unchanged; NQC realized P&L USD 0.

First exact-head attempt at commit fcd5c6a1ca0ab26c0a7d4571da9f741eed7277e6 obtained complete dual-RPC canonical source parity in both snapshots and 879 SSE frames, but its 6MB byte cap halted the stream early: BOUNDED_SSE_BYTE_CAP_INCOMPLETE. Although WETH did not advance between bookends, that was NOT a full 180-second SSE sample. The next revision increases the finite byte cap to 20MB and explicitly labels an incomplete stream as censored even when WETH round is unchanged.

This is one ephemeral GitHub Actions observation, NOT 24/7 monitoring or a new ongoing obligation.
