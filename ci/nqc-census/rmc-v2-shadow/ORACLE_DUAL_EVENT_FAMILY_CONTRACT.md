# NQC V2 — Chainlink ETH/USD dual-path oracle event truth

## The falsified assumption

Earlier #703/#704 used a hardcoded topic 0xf6a97944f31ea060dfde0566e4167c1a1082551e64b60ecb14d599a9d023d451, labeled NewTransmission. The source-bound #705 audit later authenticated two Ethereum receipts of oracle updates that caused Aave liquidation eligibility and established that **neither** emitted that topic. Therefore the old zero-event count cannot demonstrate a lull in actual ETH/USD feed updates, and any monitoring based solely on that event is wrong.

On #705 authenticated source artifact 11872860122 (SHA-256 4f817f9b9c889ffb983c395d2f6e2d9bc3aed387ec34bfc70dafdb60bfd53121), exactly validated:
- Ethereum block 26,142,067 / index-0 transaction 0x20dd5bccadb185dbac34c94c8d00bf363a4a0b779fe1fddcdcfd8a3066d96c8b emits SecondaryRoundIdUpdated(uint32 indexed secondaryRoundId), topic0 0x8d530b9ddc4b318d28fdd4c3a21fcfecece54c1a72a824f262985b99afef009b. It **does not** emit a local primary NewTransmission event from this aggregator.
- Ethereum block 26,149,038 / index-0 transaction 0x8195ce367cbf91e713b487af24dcb004def69e1c7ac9f62ce2aaedba04c4566b emits that secondary event **and** the actual NewTransmission(uint32 indexed aggregatorRoundId,int192 answer,address transmitter,uint32 observationsTimestamp,int192[] observations,bytes observers,int192 juelsPerFeeCoin,bytes32 configDigest,uint40 epochAndRound), topic0 0xc797025feeeaf2cd924c99e9205acb8ec04d5cad21c41ce637a38fb6dee6016a.
- The same #705 source showed two public RPCs agreed that Aave WETH oracle source currently pointed to the historical DualAggregator at the pinned block 26,188,663. This does not prove the configuration remains unchanged at any future block.

## Why event family matters

The primary NewTransmission event contains a real int192 report answer. Parse its first unindexed ABI data word as an integer only after validating the event signature and indexed round, and never infer borrower HF from it alone. SecondaryRoundIdUpdated has an indexed round ID **but no price answer**; it denotes a secondary-path synchronization that can change the proxy's effective price without a NewTransmission at this same aggregator. Never fabricate a price delta from this event. The upstream ETH/USD feed can have different report channels.

## Evidence workflow

1. SHA-authenticate the original #705 ZIP, exactly bound to commit 7a0f089c69a288f81089df7d7c51809d99f24b2e, complete internal manifest and PR705 two-RPC historical receipt witnesses. Any mismatch keeps the new gate closed.
2. Choose the stable Ethereum latest-minus-16 block at test initiation and fix the preceding 720 contiguous blocks before reading **any** event data. Read the same start/end block identity from dRPC and BlastAPI.
3. Query exactly 23 non-overlapping 32-block-or-smaller eth_getLogs shards **for each family individually** on each provider. No unconstrained filter, aggregator change, paid key, private RPC, any write method or range fallback.
4. Validate family topic0, indexed uint32 round, payload shape, source address, block number/hash and global log index. Independently fetch each event-bearing block header and verify identity, require endpoint boundary hash stability. Deduplicate by canonical content identity and record mismatch or provider errors explicitly.
5. Report primary and secondary counts, unique transaction union and co-occurrence without double counting, primary-only/secondary-only paths, interarrival distributions by event-bearing block, primary-only signed price deltas and uncertainty. Do not extrapolate mean event arrival to next-hour or monthly capture probability.
6. Recheck all no-claims flags: RMC OPEN, Shadow P2 uncertified, LIVE not authorized, OWN_CAPITAL=0 gas sponsor unproven, realized NQC P&L 0. Old PR703/704 zero results are specifically invalidated as evidence of *no oracle activity*.

## Quality categories

TWO_ENDPOINT_DUAL_FAMILY_PINNED_CENSUS_NO_CAPTURE: complete two-source same-window agreement. Not production-ready or proof of preinclusion visibility.
SINGLE_SOURCE_DUAL_FAMILY_DESCRIPTIVE_ONLY: one source fully checked while other is rate-limited/incomplete. Useful to redesign but not cross-operator certified.
MISMATCH_DUAL_FAMILY_NO_SOURCE_AUTHORITY: complete source event sets disagree.
INCOMPLETE_DUAL_FAMILY_ORACLE_SOURCE_CENSUS: producer artifact/source/header/integrity failure, no valid complete source.

CI PASS only means the evidence experiment and its negative classifications are structurally authentic. It never proves early detection, builder ordering, exact native gas, nonrecourse external sponsor, net PnL or real revenues. Historical selected outcomes have hindsight bias. No signing, chain mutation, broadcast, contract deployment, added servers or paid RPC plans.

Next after source correction: a separately time-pinned prospective dual-family WebSocket log+pending/hash/receipt overlap, with source availability and censorship, before any economic win-rate claim.
