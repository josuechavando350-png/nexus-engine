# NQC V2 PREINCLUSION-005B — Certified PR700 price/HF causal witnesses vs public MEV-Share history

## Why this is the next non-redundant experiment

The original PR700 source-run evidence (GitHub Actions run **38512327192**, artifact **11871075488**, commit `9208aa3cb29325ecb3a90557d1c62114c697bf02`, tree `cc19baf261e33fdcbd8ac765fcc5e446af322d86`) was produced and sealed **before** this archive test. The ZIP SHA-256 is `ca495ebdb9b8c7f8ed8438e5c3226b58b9c31c0d50e44ef35d6fce2cec232dde` and contains 93 original content-addressed members. The historical dRPC/Blast local-fork source witnesses certify WETH proxy/Aave Oracle price decreases and a corresponding Aave borrower health-factor threshold crossing after two predeclared index-zero oracle transactions.

The newly attempted PREINCLUSION-005 read-only *historical public RPC* reconstruction in PR738 was `INCOMPLETE`, not negative evidence: PublicNode returned `null` for the first original receipt; a separately predeclared dRPC+Blast trial showed the original TX but **direct `DualAggregator.latestRoundData()` does not substitute for the effective WETH proxy price**; after correcting the read path Blast returned a historical RPC HTTP error. Never silently recast these limitations as success. Rather than consume more public historical RPC bandwidth or alter the original fork inputs, verify the immutable PR700 evidence directly and test archival hint linkage with only a bounded public Flashbots historical GET.

## Strict source and sample contract

The two cases are preselected before any new Flashbots request and selected retrospectively from *known original winner cases*, so there is **no out-of-sample/capture-rate inference**:

1. Ethereum block `26142067`, original index-zero WETH/USDC oracle update transaction `0x20dd5bccadb185dbac34c94c8d00bf363a4a0b779fe1fddcdcfd8a3066d96c8b`.
2. Ethereum block `26149038`, original index-zero WETH/USDT oracle update transaction `0x8195ce367cbf91e713b487af24dcb004def69e1c7ac9f62ce2aaedba04c4566b`.

Authenticate BEFORE fetching archive bytes:
- Official old PR700 ZIP SHA-256; precise code commit/tree; unique safe member paths, maximum file count and decompression size; all manifest member SHA-256 checks; old `HISTORICAL_ORACLE_PRICE_CAUSALITY_ONLY`, zero source errors and BOTH cases present.
- Historic dual-provider fork metrics and original forwarding identities identical; exact original TX hashes, B heights, tx index 0, WETH dual-aggregator address, outer `forward(address,bytes)` selector `0x6fadcf72`, inner `transmitSecondary` selector `0xba0cb29e`.
- Exact source Aave price before > after > 0, matching WETH proxy feed answer, and integer HF WAD crossing `HF_before >= 1e18 > HF_after`, with PR700's original price-freeze causal counterfactual successful. Freeze each historical consensus-block timestamp from the original signed source public-inputs, **NOT a wall-clock receive timestamp**.
- Bind historical event to MEV-Share double Keccak of included TX hash using independent already-tested Keccak implementation. No new `eth_call`, `eth_getLogs`, Ethereum RPC, EVM simulation or wallet.

## Flashbots only (bounded, read-only historical lookup)

A single GET to `https://mev-share.flashbots.net/api/v1/history/info`, then at most 8 pages × 400 rows for each original transaction, bounded to exact `blockStart=B-8` / `blockEnd=B+1`. At most 17 HTTPS GET requests in total, 8 MB per page and fixed approved hostname/path/parameters. Fail closed on HTTP 403/429, unsupported historical range, malformed response, missing pages, size limit or any supplier error. Never retry access controls, use alternate identities/hosts, or create infrastructure. Never publish third-party raw private hint calldata/hash or personal addresses; retain bounded counters, hashes and source-generated timestamps only.

For each control classify: complete archive range, exact double-hash matched hint, decoded WETH price from matching `transmitSecondary`, and exact integer report median equal to PR700 after-price. Source `hint.timestamp` and its historical block tip are not NQC local first-seen, do not share a calibrated clock with builder deadlines, and cannot certify a slot, timely response or profitable inclusion. A missing match in a complete limited archive window does NOT disprove private stream delivery; a matching hint does NOT prove our own real-time access.

## Status and audit discipline

- `TWO_CERTIFIED_HF_TRIGGER_HINTS_FOUND_RETROSPECTIVE_ONLY`: two source-hash and decoded-price matches to original immutable HF-trigger reports. This would be a significant **historical archival disclosure** fact, not captured profit.
- `ONE_CERTIFIED_HF_TRIGGER_HINT_FOUND_NOT_CAPTURE_RECALL`: partial link, no rate inference.
- `ZERO_COMPLETE_MATCHES_IN_TWO_BOUNDED_ARCHIVE_WINDOWS_NOT_PRIVATE_DENIAL`: complete bounded negative only.
- `INCOMPLETE_*`: any source or archive gap, not zero markets. If the old ZIP cannot be downloaded at the exact required digest, preserve the failure and DO NOT use substitute values.

CI runs on a new commit of **the existing DRAFT PR738** only; the original PR700 and PR736 archives remain immutable. One exact-head specialized workflow must include offline source tests, original producer artifact validation, bounded historical lookups and SHA-256 content manifest. A green GitHub Actions job is only a faithful source-evidence gate; require review of the actual JSON findings and immutable ZIP.

## Immutable user controls / commercial truth

`PROTOCOL_FORK_TRUTH_CLOSED`, `REAL_MARKET_CENSUS_OPEN`, Shadow P2 not certified, Canary/LIVE not authorized; operator `OWN_CAPITAL=USD0` **including native ETH gas, builder payments, reverts and contingent liabilities**; MXN 2,000 operator reserve untouched. No blockchain transaction/bid/signature/bundle, paid RPC, deployed contract/host, account setup, merge, repo configuration change, contact with external entities or transfer of NQC algorithms. No nonrecourse gas sponsor contract exists. **NQC REALIZED P&L USD0**, commercial score **5.9/10** unchanged, USD5k and USD45–55k net monthly targets NOT forecast. Even complete historical hints cannot infer prospectively available builder deadlines or future win probability; those require independently authorized and timed receipts.
