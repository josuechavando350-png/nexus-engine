# NQC V2 — Authenticated ETH/USD NewTransmission arrival cadence

## Question

How frequently has the *specific* Ethereum ETH/USD DualAggregator contract actually emitted Chainlink NewTransmission events in a recent, pinned, contiguous sample? This determines an evidence-based minimum run horizon for the next prospective pending-to-confirmed overlap experiment. It does not itself demonstrate detection in advance or any profitable liquidation.

The prior PR #703 prospectively received 6,819 full pending transactions in 240.04 seconds, 20 verified newHeads, and sampled 24 ex-ante pending controls. Fifteen controls had matching receipts within the witnessed 20-block span, with median process-pending-to-local-head observation time 7,688ms. The exact ETH/USD NewTransmission topic emitted **zero** events in that bounded 20-block span in both WebSocket and scoped canonical RPC. Therefore oracle preinclusion overlap is not estimable from #703.

## Input, reproducibility and censorship

- Chain ID Ethereum mainnet 1 only.
- Choose latest height at run initiation, subtract 16 blocks to reduce reorg exposure, and fix precisely the preceding **720 contiguous blocks** (about 2.4 hours, measured exactly from authenticated endpoint timestamps).
- Require starting/ending block hash, parent hash, height, timestamp, and equality across dRPC and BlastAPI; query the **same** immutable target address and NewTransmission topic only.
- Fetch exactly 23 read-only eth_getLogs shards of at most 32 blocks per provider; any error or gap keeps the source INCOMPLETE. Maximum 150 logs and 75 event-bearing block headers. Authenticate the event against the block hash at its height, deduplicate exact tx/block/log/answer identity and re-read boundary headers to catch reorg.
- Parse the NewTransmission first data word as signed int192 answer raw, but do NOT claim that observed price changes guarantee HF<1 for any borrower. Report integer basis-point direction, event count, event block/time intervals and descriptive per-hour rate, explicitly NOT a statistical forecast.
- Rate limit requests, record provider-specific request hashes/failures and retain exactly source/commit/tree in content-addressed CI artifacts.
- Two matching public RPC URLs do not prove backend operator independence; one provider failure does not erase authenticated partial evidence from the other.

A completed source window with no events is a time-scoped zero event result, not absence of future price reports. Incomplete data and source mismatches stay explicit.

## Status classes

- TWO_ENDPOINT_PINNED_ORACLE_EVENT_PARITY_DESCRIPTIVE_ONLY: all 720 blocks checked by both endpoints, complete log parity, event timestamps validated, no commercial authority.
- MISMATCH_NO_EVENT_AUTHORITY: provider event lists diverge.
- INCOMPLETE_ORACLE_CADENCE_CENSUS: incomplete shards, rate limit, unverified source, missing headers, or unknown errors.

## What this does not certify

No native gas sponsorship, pre-inclusion visibility, private builder access, causal borrower HF crossing during this recent window, Shadow P2, canary/LIVE, realized settlement, monthly profitability, or RMC closure. PFT CLOSED; RMC OPEN, commercialization score 5.9 unchanged, P&L real USD 0; goal USD 45,000–55,000 net/month remains unproven.

After an authenticated cadence estimate, compare prospective observation sample size with observed oracle inter-arrival distribution. Never infer a win probability from historical event density.
