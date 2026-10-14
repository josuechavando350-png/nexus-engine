# NQC V2 — Same-block public Aave dual-RPC latency: sequential vs paced three-lane A/B B/A

## Why this research is technically useful, and why it is not an SVR profit signal

PR727 certified in a hindsight-selected original Ethereum mainnet block that a one-shot contract-creation liquidation is locally EVM-feasible only AFTER a Chainlink tx0 oracle update and BEFORE the original winning competitor's transaction tx1. The same input reverts before the oracle and after the winner. PR728 then demonstrated a new, source-frozen nine-account public HEAD risk journal, but the first Aave nine-account read and local decision seal took **4.16 seconds** and another 4.11 seconds in its next real observation; both times the first decision seal was **AFTER** the next block's canonical timestamp, despite being before the process first *observed* the second header.

This experiment tests a narrow infrastructure hypothesis: **can a bounded, paced three-lane per-provider reader complete the exact same Aave nine-account snapshot faster than a sequential reader, WITHOUT losing canonical source parity, data or source completeness?** This is solely a read-only public API performance measurement. A faster query on an already-mined public block does NOT establish access to a private Chainlink SVR update or builder inclusion; even negative results are useful.

## Immutable selection and anti-lookahead gates

- Original PR728 specialized [run 38639157922](https://github.com/josuechavando350-png/nexus-engine/actions/runs/38639157922) SUCCESS, exact head **d41a4b36b8b4c1034a3e1cb669d8046166b103ca**, tree **25461395e94ff28bb7b72a8103d9013d4bab6073**, artifact **11928798163**, ZIP SHA256 **605211ce433d9e89af5f88ab97145450eb9338f94f202186207ededc21859193**. The ZIP has 20/20 complete SHA256 content-manifest files; included original PR718 complete 83 owner cohort artifact ZIP SHA256 **551b50b111a2451a487a8cd73c2597cf83b119030162e53c4195a66ef1b3b2bf**.
- Nine fixed borrowers were preselected in original PR718 from the **nine debt-positive of 83 old Withdraw owners**, using only the historical state before later observations. No current debt/HF/order selection, no historical winner selection. Old source at Ethereum block 26,191,690 is NOT today's full Aave borrower census. The new script re-authenticates the PR728 source archive, original fixed-cohort pre-network seal and prior source, and writes a NEW `cohort-sealed-before-new-network.json` SHA256 file **before** any current Ethereum RPC call.
- Only dRPC and PublicNode official public URLs, original canonical mainnet Pool and EIP-1898 `eth_call` for exactly the nine preselected borrowers. Require mainnet chainId1 and matching two-source tip within three blocks; pin one canonical min-tip-minus-two block, with exact two-provider number/hash/parent/stateRoot/timestamp parity and <=120 seconds age. This is ALREADY MINED state, not a fresh mempool or private oracle report.

## Deterministic A/B B/A controlled modes on identical blockHash

Four complete passes on the **SAME pinned block hash**:

1. SEQUENTIAL nine owner state calls/provider (two independent provider tasks).
2. THREE_LANES, nine owner state calls/provider partitioned into 3 deterministic nonoverlapping owner groups using separate per-worker RPC clients.
3. THREE_LANES again.
4. SEQUENTIAL again.

Each pass requires all 9 source ABI hex values identical between both RPCs. Every pass must ALSO produce identical exact 9 original ABI hex results across all four passes. Recheck the pinned original header on both providers at end and reject reorg. The entire experiment reports both raw ABI hashes and six-word decoded account states, UTC and monotonic completion times, per-provider RPC transcript, call counts, actual elapsed time per pass, one two-pair (A/B B/A) arithmetic mean, and whether concurrent was faster **only in this particular sample**. Never treat 2 pairs as a calibrated latency distribution or a promise of sustained improvement; ordering, shared underlying infrastructure, caches and network variability are confounders.

Source URL pacing is NOT optional. Both modes use the exact same **ProviderRateGate with a GLOBAL 400 ms minimum dispatch spacing for every request per provider, shared by all worker threads**, no burst/429 bypass and no retry/fallback after throttle errors. Separate clients prevent a thread-unsafe shared mutable per-RPC counter. Expected successfully bounded calls per public source ~40, under a 60-call hard aggregate cap. All method/argument allowlists come from the already source-reviewed PR728 Borrow reader.

## Decision rule and commercial boundary

**PASS** when exact source/precommit, 4 complete same-hash and same-accounts two-source reads, capped pacing, header no-reorg recheck and full artefact/CI integrity succeed. A pass need NOT show concurrency faster; it proves a valid comparable measurement. Relative measured speed may be positive or negative. **INCOMPLETE** when RPC 429/provider mismatch/missing ABI/canonical reorg/stale header, and MUST NOT be reclassified as no risk or a speed win.

No signs, transfers, deploys, Ethereum mainnet transaction, API bypass, user capital or MXN2,000 spend. No service/host purchase. Ownership remains exclusively NQC; no sale/license to competitors. PFT CLOSED; RMC OPEN; Shadow P2 uncertified; LIVE unauthorized; OWN_CAPITAL=0 including native-gas sponsor not proven; Commercial 5.9 unchanged and realized NQC P&L USD0.

Even an unexpectedly faster PUBLIC snapshot is still post-inclusion information. Astra's official SVR access investigation is the necessary separate prerequisite before measuring actual pre-inclusion signal-to-simulation timing. No claim of private-feed reception, opportunity capture, builder deadline, net P&L, monthly target or full DeFi census.
