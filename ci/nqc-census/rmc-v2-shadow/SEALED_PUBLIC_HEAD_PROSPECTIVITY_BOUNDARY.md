# NQC V2 — Real wall-clock source-frozen public-head Aave risk journal

## The commercial question

PR727 proves a ONE-SHOT funded Aave liquidation is mechanically eligible ONLY in the original historical oracle tx0→competitor winner tx1 transaction-prefix state. No pre-inclusion public/MEV-Share signal, prospective builder cutoff, or profitable capture was proven. Do not manufacture timing from historical timestamps or say a GitHub Actions source scan is continuous 24/7 monitoring.

This new one-shot CI experiment makes a **predeclared cohort decision and actual recent public Ethereum observations**. It seeks to measure what can be read and sealed from public canonical heads, not to claim the already mined public block was an advance private oracle signal.

## Immutable preselection BEFORE a single new blockchain RPC

The one allowed old source is PR718 [run 38591219786](https://github.com/josuechavando350-png/nexus-engine/actions/runs/38591219786), commit 4f790b91df324565e71bfa4f6002f46ae27f575b, tree dc49712f1711d759e6d2aa4614240720c431b4ab, artifact **11908200180**, ZIP SHA256 **551b50b111a2451a487a8cd73c2597cf83b119030162e53c4195a66ef1b3b2bf** with complete **20/20 content SHA256 member manifest**.

That ZIP contains the nested original PR717 archive ZIP SHA256 **0cf05f5acf279948dbdf92b5b52183c129175850fdd311c13e3356d7ede289a2**, 149 authentic Aave Withdraw events selecting 83 distinct owners, 83/83 complete dual-URL Aave risk reads at old Ethereum block 26,191,690; **9 had active debt and 74 did not**. The nine older debt-positive owners are selected deterministically by their prior source HF, **NOT by any new/future HF**. This is a biased tiny historical Withdraw-owner subset, NOT all Aave borrowers; the old snapshot could be stale and some accounts may since have repaid.

Before instantiating or contacting either provider, write an immutable `cohort-before-network.json` file containing exact source SHA, original nine addresses and original HF, UTC/monotonic timestamps and no-future-knowledge declaration. Preserve its SHA and full bytes. Invalid source ZIP, code/tree, nested ZIP, duplicate JSON, incomplete 83/83 state parity, 9/74 counts or commercial scope MUST hard-reject before network.

## Two actual public Ethereum HEADs

- Only Ethereum mainnet dRPC https://eth.drpc.org and PublicNode https://ethereum-rpc.publicnode.com, read-only Ethereum calls (eth_chainId, eth_blockNumber, eth_getBlockByNumber, EIP-1898 eth_call to canonical Aave V3 Pool getUserAccountData for exactly the nine preselected owners). The inherited RPC method/argument allowlist prevents signing, modifying state, broadcasting, arbitrary-address reads, paid endpoint switching or quotas above **110 calls/provider**. No repeated 429 retries.
- Observe the current height (tip drift <=3) and require both full block number/hash/parent/stateRoot/timestamp headers agree, head age <=45 seconds and complete 9/9 raw six-word risk parity. Reject missing accounts or provider mismatch.
- Record local UTC-nanosecond and local monotonic-nanosecond first HEAD observation and state-seal completion. Write `first-public-state-seal.json` and SHA before intentionally polling the next publicly observed canonical head.
- Poll boundedly for a direct successor B+1 on both sources (max 40 polls/160 seconds). Require both providers' next exact headers agree and B+1.parentHash equals B.hash; independently re-read BOTH headers again *after* the second snapshot to reject a shallow reorg. Read the exact SAME nine owners on successor B+1 with EIP-1898 and dual-URL parity, save `second-public-state-seal.json` and SHA.
- Report HF<1 count, HF/debt transitions, all errors and provider transcript with real UTC and measured round-trip nanoseconds. A purported HF<1 is **Aave borrower state only**, NOT a verified executable route, flash capacity, builder slot, prospective signal or native-fee payer. A non-complete report must not report zero candidates as absence of market opportunities.

## Critical temporal anti-claims

**Public mined HEAD is already after inclusion.** Even if the local first decision seal was written before the process FIRST SAW a successor header, this does NOT prove the seal predates the successor block's actual mining time or a builder deadline. We cannot restore prospectivity for a hidden oracle event with post-inclusion data. All statements of SVR/MEV-Share private first-seen, access, inclusion and capture MUST remain false. This watch is a bounded public observability and decision-journal baseline; the missing pre-inclusion feed is an Astra-owned commercial access item, not silently filled in by this engineering experiment.

This is only **two observed heads** of nine previously debt-positive historical Withdraw owners, NOT a 14-day observation, a complete market census or a recurrent strategy. No real-world outgoing Ethereum tx, user key, paid API, cloud server changes, coin movements, merges or spent MXN 2,000. OWN_CAPITAL=USD0 including gas, PFT CLOSED, RMC OPEN, Shadow P2 uncertified, LIVE unauthorized, Commercial 5.9 unchanged, NQC P&L USD 0. No operator data sold/shared. All source and failures remain content-addressed for independent verification.
