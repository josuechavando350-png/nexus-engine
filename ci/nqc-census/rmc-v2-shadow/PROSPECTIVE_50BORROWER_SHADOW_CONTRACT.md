# NQC V2 — Prospectively observed Aave risk state for 50 source-authenticated historic liquidated borrowers

## Concrete business question

The PR712 economic gate demonstrated that *two* heavily contested historical Aave WETH/stable markets do not, by themselves, provide credible USD45k–55k monthly net-profit capacity under realistic competition assumptions. The next commercial source needs **current, block-pinned borrower risk state**. A list of 4 old borrowers is not a representative borrower census.

This gate extracts 50 distinct borrower addresses from the original 53 Blockscout-indexed, 89,390-block Aave LiquidationCall log corpus. It authenticates each original ABI topic[3] against the source-committed borrower SHA256; 18 of these 50 borrowers appeared in WETH/USDC or WETH/USDT liquidations. Selection is **hindsight-seeded**, not systematic active-account discovery. It cannot prove completeness, opportunity arrival frequency or first-party profitable capture.

## Trusted seed provenance

PR693 producer run 38489472232 SUCCESS; original source artifact 11861430884 SHA256 5a198ad15588e6e2ec692ef05ab16f51127141b3b00b0949b6ea7d945b20d1c4, head 219b8e97ee667c0797980e3e28edf34030ad1a03. The PR712 source adapter re-hashes the nested original Blockscout archive, original 139/127 positive control, 53/47/21 source census, complete member manifest and exact immutable producer source. This is not independently certified exhaustive Ethereum log discovery.

## New on-chain observation

One temporary GitHub Actions job, not a production deployment. At execution:
1. Read chain ID and tip heights from the existing public dRPC and PublicNode HTTP endpoints. Pin the **same** minimum height minus 3 confirmations. A source diverging by over 12 blocks is invalid.
2. Read block header including stateRoot/hash/ancestry/timestamp at the exact pinned height. Reject stale, changed, impossible or mismatched blocks.
3. For all 50 source-committed borrowers, call only the canonical Ethereum Aave V3 Pool getUserAccountData(address) at the exact EIP-1898 blockHash with requireCanonical=true. Reject malformed six-word ABI, LTV or liquidation threshold over 10000, or off-cohort values.
4. Re-read the exact header to detect reorgs. Require exact block/header and **all 50 raw borrower/account** readings to match across both endpoints. The two public URLs' backend-operator independence is NOT certified.
5. Record full JSON data, source-specific request digests/latencies, errors, a source-only HF classification: no outstanding debt, positive debt with HF<1, HF 1 to 1.005, 1.005 to 1.02, 1.02 to 1.10, HF>1.10 or zero-HF with debt requiring reconstruction.
6. The per-snapshot statistical denominator is exactly **50 historically selected accounts**, NOT 50 at-risk accounts, NOT 25k DeFi markets, not an estimate of all Aave active borrowers.
7. An endpoint failure means source coverage INCOMPLETE, not zero borrowers/candidates; report numerical counters as null without dual-source parity.

Limits: <=65 HTTP read-only calls per provider, <=50 account queries, <=1MiB per RPC payload, no signing, wallets, eth_sendRawTransaction, contract deployment, new cloud host, paid plan, inventory, flash borrow, gas payments or private data. Abort a rate-limited provider promptly. Production 24/7 service is NOT installed.

## Commercial status

A live HF<1 source reading is *state only*, not liquidationCall execution acceptance. A real route must still prove close factor, pool liquidity, collateral monetization, native gas payer, adversarial MEV inclusion, full cold transaction gasUsed and net margin after all costs. A lower HF below 1 is not necessarily an actionable trade (paused reserves, bad debt, unsupported tokens, etc.).

PFT CLOSED; RMC OPEN; Shadow P2 uncertified; LIVE unauthorized; OWN_CAPITAL=USD0 including gas unmet due no contracted nonrecourse payer; commercial 5.9 unchanged; NQC realized P&L USD0. No existing research paths frozen; no automatic market exclusion based on this hindsight-biased snapshot.

## What follows

Move from this known-historical cohort to a block-pinned **fresh active-Borrow/position event-derived cohort**, and only then estimate active-account coverage and prospectively observed HF candidate/route economics. If all 50 historical accounts are healthy or repaid, that is valid current state evidence for this narrow set—not a commercial failure for all markets.
