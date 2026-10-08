# RMC-016 — Read-only historical Aave WETH oracle / gas USD input probe

## Purpose

Aave V3 Ethereum's certified D08 closeout/oracle-manifest.jsonl at block 26095351 contains exactly one WETH oracle witness, with underlying WETH 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2, Aave oracle 0x54586be62e3c3580375ae3723c145253060ca0c2, USD base unit 100000000, and raw WETH price 270926731143 (2709.26731143 USD/WETH). Immutable D08 artifact 11237887761, SHA-256 9431ea07144ae78e68e0ffcc7f650fa32068ee63fb53ca41ff8a062b87845913, exact D08 commit 36c732a36789e1967ce7178010889427ad7cf0f2. These values were read from the ZIP's WETH row, not estimates.

RMC-016 reconstructed the 139 events / 127 winner transaction hash universe via Blockscout run 37718661409; three actual event-block examples are 25883783, 26001680, 26085027. This auxiliary probe queries block n-1 for each (25883782, 26001679, 26085026), plus end anchor 26095351 for exact D08 price parity. It uses immutable oracle identity and the Ethereum EVM getAssetPrice(address) function selector 0xb3596f07.

## Conservative admission

1. dRPC and BlastAPI must independently return chain 1, exact historical block headers, matching block hashes and identical integer getAssetPrice(WETH) results for all four sampled heights.
2. End anchor must independently match the exact D08 certified WETH oracle price. A mismatch is a source-coherence failure; never modify the D08 record or override an oracle value to pass.
3. Sample is read-only and does not establish 127 per-transaction prices, exact intra-block prestate, individual received gas/USD costs, or any trade net.
4. At best, a block n-1 oracle price is ex-ante relative to block n. It is NOT guaranteed to be the exact pre-transaction oracle state when updates happen earlier within the same block; reconstruct historical PRE_TX state separately.
5. Gas in wei is not USD and ETH/WETH market price cannot be inferred by applying the fixed end-anchor price to all 127 transactions. Day/time-specific source observations are needed.
6. No liquidation is assigned to Nexus, no capital or gas sponsorship is inferred, capture probability remains uncalibrated, and OWN_CAPITAL = 0 USD is a hard constraint. real_market_census_closed and realized Nexus profit remain false.

This probe must never sign, broadcast, store private keys, write to a deployed Oracle, modify Canon Penal or affect D14/D17 authority.
