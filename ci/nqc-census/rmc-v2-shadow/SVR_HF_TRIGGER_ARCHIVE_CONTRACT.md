# NQC V2 PREINCLUSION-005 — Historical Aave HF-triggering ETH/USD price updates versus public MEV-Share archive

## Why this is different from PREINCLUSION-004

PR #736 authenticated two included Chainlink WETH `transmitSecondary()` transactions, matched their double-Keccak identifiers and raw report prices to public Flashbots MEV-Share archive entries. However, neither inclusion changed the canonical `latestRoundData()` round/price between B−1 and B. Their public hint discoverability is not evidence that profitable liquidations were available or accessible.

PREINCLUSION-005 tests **a stronger predeclared denominator**: two original **tx0** reports in blocks where prior NQC historical replay attributes the first borrower liquidation eligibility to a falling ETH/USD oracle price. The controls were selected from existing NQC PR #700, #705 and #727, not from an archive search:

| Control | Included block | Original transaction | Tx index | Prior economic witness |
|---|---:|---|---:|---|
| Aave WETH/USDC | 26,142,067 | `0x20dd5bccadb185dbac34c94c8d00bf363a4a0b779fe1fddcdcfd8a3066d96c8b` | 0 | PR727 historical three-state CREATE fork, source run 38634669287, artifact 11927907826 SHA256 `ff00c7e499cb3c371aa4848ea90edff2df9526588d878e44fb1829d459573251` |
| Aave WETH/USDT | 26,149,038 | `0x8195ce367cbf91e713b487af24dcb004def69e1c7ac9f62ce2aaedba04c4566b` | 0 | PR700 historical oracle/HF price-freeze source; prior limitations preserved |

These are **historically selected winners**; any result is hindsight-biased and cannot estimate a capture frequency. PR727's historical borrower HF transition is referenced, **not rerun** in this audit. The new test only reads canonical report source and public archive, not borrower-specific intrablock risk.

## Admission / source truth

- Fix both transaction hashes, indexes, expected inclusion heights and the WETH DualAggregator `0x7c7fdfca295a787ded12bb5c1a49a8d2cc20e3f8` in `causal-source-precommit.json` BEFORE any remote GET or Ethereum JSON-RPC call.
- On Ethereum mainnet, only dRPC and PublicNode public URLs; require chain ID 1, exact matching two-provider block headers for B−1/B, receipt hash/status/index, original WETH aggregator emitted custom primary/secondary event topic, transaction identity, `latestRoundData()` at exact canonical EIP-1898 block hashes, and final header parity recheck. Do not assert independence of backend operators merely because URLs differ.
- Only allow source promotion if before/after actual WETH `answer_raw` is positive and **strictly decreases**, and the oracle round/updatedAt advances. If an original `forward(address,bytes)` report can be decoded, its median must not contradict the post-event chain price. Any error or parity mismatch remains `INCOMPLETE_SOURCE_CONTROLS`.
- Reuse PREINCLUSION-004's independently tested Keccak / ABI decoding and source parser, adding source-*injected immutable controls* (original constants unchanged). The original 16 offline regression tests MUST remain green.

## Bounded archive test

- One GET `https://mev-share.flashbots.net/api/v1/history/info`; then up to 8 pages × 400 rows per **fixed** control from B−8 through B+1; **17** total archive GET calls including info. The 8MB response cap and 400ms pacing stay unchanged. No retries or identity change on HTTP403/429 or other access-denial errors.
- Require fully consumed pages before concluding that an exact double-hash link was not found in a window; pagination cap or unavailable historical range is **INCOMPLETE**, never absence of private report exposure.
- Compare historical archive event's double Keccak to the canonical transaction hash, decoded WETH `transmitSecondary` raw median to source-transmitted median, and nominal archive timestamp / inclusion timestamp separately. Archive timestamps are NOT local NQC reception timestamps, calibrated wall clocks, private builder cutoffs, or proof that the event was available with enough time to prepare a bid.
- Preserve only bounded counts, hashes, immutable precommit, source/error manifest and exact HEAD/tree; no third-party raw hints, private calldata, keys or data sales. Source timestamps are untrusted for competitive lead-time.

## Verdict and economic restrictions

`TWO_HISTORICAL_HF_TRIGGER_ORACLE_HINT_LINKS_NO_CAPTURE_AUTHORITY` requires TWO authentic lowering oracle updates and two complete archive matches (double-hash + target decoded price). `PARTIAL_HISTORICAL_HF_TRIGGER_HINT_LINK_NOT_RECALL` means one; a complete bounded non-match is not proof that the private SVR delivery system omitted or denied that update. `INCOMPLETE_*` means provider/source/pagination limitations.

All results **preserve**:
- `NQC_PROSPECTIVE_FIRST_SEEN=false`, `BUILDER_DEADLINE_UNKNOWN`, `INCLUSION_WIN_NOT_PROVEN`, `GAS_SPONSOR_WITHOUT_RECOURSE_NOT_PROVEN`, `SUSTAINED_MONTHLY_NET_PNL_NOT_PROVEN`, `NQC_REALIZED_PROFIT_USD=0`.
- PFT CLOSED, RMC OPEN, Shadow P2 uncertified, Canary/LIVE unauthorized, OWN_CAPITAL USD0 including gas and contingent liabilities; MXN 2,000 reserve untouched.
- No wallet, signing, tx send, bundle, bids, gas, new host/paid infrastructure, merge, repo settings change, contacting third parties or sharing NQC intellectual property.

**Next decision:** If a real price-changing historical update was represented by a public hint, evaluate *prospective authorized* source-local reception and builder deadline as a separate experiment, together with non-recourse native-gas financing. Do not transform historical timestamps or a successful GitHub Actions workflow into an ROI prediction.

## First exact-head CI finding: fail closed before archive

First source run at commit `e8d44ee061645a3fe2178b3a8e68f663ad9967ed`, workflow `38659509626` **SUCCESS as an instrumentation run**, original ZIP artifact 11938267554 SHA256 `42096653ceaa981fd445f12a6a2fd9f98c31416743214bf25c0415cfb75a47ff`; **17/17 internal checks** matched. The actual scientific verdict was `INCOMPLETE_SOURCE_CONTROLS` because dRPC and PublicNode returned **different raw `eth_getTransactionReceipt` payloads** for the FIRST 26,142,067 TX0 while their separately queried B−1/B headers agreed. Each source used four read-only RPC calls; archive GETs **zero**. No price-change or public hint linkage was established in this attempt. The original source output preserved mismatch only by error class, so this follow-up adds a **sanitized field-level mismatch ledger** that records only differing receipt field names, log positions/field names and cryptographic hashes, without full payload or sender data. **The raw parity gate remains STRICT** and may still block; no provider discrepancy is automatically excused or normalized into PASS. Only if the new evidence establishes that the difference is strictly non-authoritative metadata may a future separate revision propose a documented semantic comparison with adversarial controls.

## Second source finding and final bounded historical provider choice

Exact revision `ece2c2041c76369c0df3feb90fad9ac2700a6096`, specialized run `38659819043`, artifact 11938701472 ZIP SHA256 `7294e84e2f946eac5ee8619244a4abbdb6086bb8a3b5c72e5d5831aa9e665d2b`, 17/17 internal manifest PASS, diagnosed the same first-control raw-receipt disagreement: **dRPC returned a receipt object; PublicNode returned JSON-RPC result `null`** (confirmed by SHA256 of canonical `null\n`, no transaction/receipt data from PublicNode). The B−1/B canonical headers matched, and no archive GET occurred. This is **NOT** a cosmetic optional metadata issue and MUST NOT be normalized to PASS or represented as a negative WETH market finding.

For this **one and only** final historical source trial, choose a previously used, officially public Ethereum RPC from prior NQC PR694/PR700 source code: **BlastAPI** `https://eth-mainnet.public.blastapi.io`. The source-precommit now selects IDs `drpc` and `blast` *by name*, never labels BlastAPI as PublicNode. Original PREINCLUSION-004 default remains `drpc` + `publicnode`. Source calls remain strictly allowlisted and paced, read-only, <=18 calls per selected provider. If BlastAPI returns HTTP403/429, null, incomplete archives, disagreement, or any transport failure, stop without retrying, evading any control or adding another provider. Preserve the original PublicNode null result in the prior immutable artifact and maintain its divergence ledger; do not claim independent backend operators without evidence.
