# NQC V2 — Fresh Aave Borrow-event cohort, two-RPC canonical HF read

## Authorized handoff / continuity timestamp

**User requested continued work:** 2026-10-14T07:04:25-06:00 (Mexico local time), equivalently 2026-10-14T13:04:25Z. The instruction was to continue deeply while the user is away, preserve every source and failure, do not freeze research, and continue focusing on measurable commercial progress. This record is for user continuity; it does not authorize live trading, merging, deploying, signing, spending, using proprietary data, or modifying servers.

## Why this gate is necessary

PR713 authenticated 50 Aave borrowers drawn from earlier liquidation events and reconstructed all 50 current health factors on two read-only RPC endpoints at the same block. No borrower had HF below 1 or within 2% above it. This does **not** show a lack of new on-chain borrowing opportunities: that was a *hindsight-selected historical liquidation survivor cohort*.

This PR starts an entirely separate cohort from **fresh Aave V3 Borrow events**, not liquidator winners or future HF outcomes. Aave's canonical Borrow event ABI in Aave V3 origin IPool is:

Borrow(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint8 interestRateMode,uint256 borrowRate,uint16 indexed referralCode)

Keccak256 topic0: 0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0. The event is actually emitted by the Pool when borrowing occurs, and the **onBehalfOf** indexed topic determines who owes the debt, not necessarily the initiator in data word0. This topic/ABI matches known real Ethereum mainnet Aave Pool Borrow receipt logs. The mode parameter is uint8, not uint256 in the canonical event signature. Do NOT filter by user_initiator instead of onBehalfOf.

Sources:
- Aave V3 origin interface: https://github.com/aave-dao/aave-v3-origin/blob/main/src/contracts/interfaces/IPool.sol
- Aave pool borrower/recipient distinction: https://aave.com/docs/aave-v3/smart-contracts/pool
- Known real Aave Ethereum receipt topic: https://etherscan.io/tx/0x39eeef80f5a336aa39124db3b9d60c2f38926d8fb1d2b5a3d1c05dd3a7419bdb

## Ex-ante rule and source contract

1. At one bounded GitHub Actions run, query Ethereum mainnet chain IDs and current tips from public dRPC and PublicNode. Reject missing sources or tips differing by more than 12 blocks; choose minimum tip minus three confirmations. This is a delayed read-only observation, **not** predictive pending monitoring.
2. Fix exactly the latest **384 contiguous blocks** ending at that pinned height; the window cannot be expanded or cherry-picked after inspecting events.
3. Scan only Aave Pool Borrow topic/address with exactly 16 contiguous, nonoverlapping shards of <=24 blocks per provider; no transaction submission. Reject unrelated events, wrong indexed topics, malformed four-word unindexed data, noncanonical indexed address padding, invalid uint16 referral, unsupported interest-rate mode, negative/zero amount, missing block hash or removed log.
4. Authenticate every event-bearing block against exact numbered Ethereum canonical header hash and re-check both boundary headers, no silent reorg fallback. For up to two events, independently verify the entire original receipt, status, precise log index, transaction index and event ABI.
5. Require both provider complete event lists and block hashes to match **exactly**. Two URLs do not establish independent operators. Partial/429/timeout state remains explicit and never becomes a zero-event observation.
6. Before reading any current HF, select up to the **48 most recent unique onBehalfOf accounts** by (block, transactionIndex, logIndex) descending. Record the number of additional borrower accounts not read when the cohort is truncated. No future winner information is involved.
7. For every selected account, query the six-word Aave V3 Pool getUserAccountData(address) at the exact EIP-1898 blockHash (requireCanonical=true) from both RPC endpoints. Reject mismatched/partial state; no backfilled or estimated HF may qualify.
8. Classify: no debt, debt with zero HF (unknown), HF<1, 1–1.005, 1.005–1.02, 1.02–1.10, HF above 1.10. Retain pinned block, decoded counts, event refs, raw ABI digests, source transcript, failures and code commit/tree.

Hard safety budgets: 384 blocks, maximum 320 Borrow events, 105 event-bearing block headers per source, 48 accounts read, 2 positive-control receipts, at most 200 read-only calls/provider and 4MB/response. On source limits, fail closed and preserve the raw processing transcript/error; do not bypass rate limiting or switch to paid endpoints.

## What is / is not proved

This measures only **recent debt creation** and current block-pinned HF in those accounts. It is *not* the entire Aave borrower universe (accounts that opened earlier can remain active), not a complete census of markets, not a trigger before canonical inclusion, not a promise that a HF<1 borrower could be liquidated, and not profit. Real execution needs close factor, reserve configuration, oracle freshness, liquidity, flash capital, route slippage, native gas payer, failed attempts, builder bidding, competition/collision, inclusion and nonrecourse sponsorship.

The selection is event-derived and prospectively observable *after* canonical Borrow inclusion, but the new data is not an ex-ante liquidation opportunity forecast or proof of lower latency vs competitors.

## Decision classes

- TWO_URL_RECENT_BORROW_COHORT_STATE_ONLY_NOT_P2: complete both-source Borrow event parity and identical canonical account reads; numerical HF counts admitted **for that exact cohort only**.
- TWO_URL_ZERO_BORROW_EVENTS_ONLY_IN_FIXED_WINDOW: both providers completely attest zero matching Borrow events in exactly the window. Not absence of older active borrowers or future opportunities.
- INCOMPLETE_RECENT_BORROW_SOURCE_NOT_MARKET_ABSENCE: missing/contradictory events, receipts, headers, account state, RPC tip, rates, excessive sources or counts; no numerically authoritative HF result.

## Commercial gate after this PR

If true HF candidates appear, next step is **shadow-only** borrower-specific route simulation (Aave liquidation gate, actual pool liquidity, route exact output and all costs). For near-HF accounts, track their state changes across future windows and correlate with a **new, separately sourced** price trigger rather than treating healthy accounts as already profitable. Use the combined evidence to compare capture feasibility and failure costs, not to upgrade 5.9 based on snapshots.

No research is frozen. PFT remains CLOSED; RMC OPEN; Shadow P2 NOT CERTIFIED; LIVE NOT AUTHORIZED; OWN_CAPITAL=0 including gas unfulfilled absent a nonrecourse provider; Comercial 5.9 unchanged; NQC realized P&L USD0. No merge, contract deployment, transaction signature, inventory, or paid RPC/infrastructure.
