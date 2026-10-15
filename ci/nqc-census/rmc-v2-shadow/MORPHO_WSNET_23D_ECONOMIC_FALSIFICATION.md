# NQC V2 — MORPHO wsNET/USDG 23-DAY ECONOMIC FALSIFICATION

**STATUS: INDEXED_WSNET_USDG_23D_CONDITIONAL_CAPACITY_NOT_PROFIT.**

**Principal decision:** Does Morpho wsNET/USDG on Robinhood Chain 4663 deserve a next-stage same-block execution/DEX audit after PR #750 falsified cbXRP/USDC as an independently reliable USD5k-per-month basis? YES, conditional: this market has more recurrence, but actual monetization remains unproven.

## Source authority and limits

- Original authenticated internal NQC PR #741 GitHub Actions artifact 11944154144. Original ZIP SHA-256: f65c2b526fe93d105b096716515b4eac7b98698cb331048d3c6a8cf936b65ce4. JSONL SHA-256: 8deb600b064bee39767f203e22f9cda3fd9ab61d67a2030e5369c5967215ff0e. All original 9/9 manifest entries verified, 2,565 original source-indexed records reconstructed and all 23 complete source 24h window counts checked.
- Original source complete scope: 2026-09-15 02:35:23 UTC through 2026-10-08 02:35:22 UTC, 23 complete consecutive 24h intervals. Day24 was censored by unpageable Morpho API events; remaining days not scanned. NEVER claim 30D, treat censored as zero, or backfill missing source information.
- Single official Morpho API indexer; not a two-RPC independently canonical historical market census, not proof of prospective first-seen and NOT NQC trades.
- Exact market ID 0xaa586d26a6fe62d9c0f0948fede6e2130500ac7a655587447e2d4a37e6330589; chain 4663 (Robinhood Chain). Loan USDG token 0x5fc5360d0400a0fd4f2af552add042d716f1d168, 6 decimals; collateral wsNET token 0x63c12667638f2ae6fc6ae09b43d98ec84a8586ea, 18 decimals. Metadata verified via Blockscout read-only chain 4663, separately from Morpho indexer; NOT a same-block canonical quorum.
- LLPV/LLTV 62.5%, corresponding nominal Morpho LIF 1.126760563380281690. Protocol oracle formula NOT the same as executable swap price.

## Full target market: indexed winners ONLY, never NQC profits

| Metric | Authenticated source-bound observation |
|---|---:|
| Target liquidation events | 224 |
| Unique capturing chain + TX IDs | 164 |
| Distinct winning liquidator addresses | 52 |
| Active ORIGINAL 24h source windows | 18 of 23 |
| Unique UTC calendar dates active (different partition) | 16 |
| Source nominal loan principal repaid | 526,735.979790 USDG |
| Seized wsNET base amount | 423.370293220914298201 wsNET |
| Median winning-TX principal | 353.388651 USDG |
| Winning TX with repaid principal less than 1,000 USDG | 101 of 164 |
| Winning TX with principal at least 10,000 USDG | 17 of 164 |
| Largest winning-TX loan principal | 31,634.465959 USDG |
| 3 dominant winning addresses (debt-weighted) | 61.4365% |
| Largest 24h source-window share (debt-weighted) | 18.3928% |
| NQC realized P&L | USD 0 |

Peak window begins 2026-09-27 02:35:23 UTC; indexed repaid loan principal 96,881.749700 USDG. Address concentration does NOT demonstrate company concentration or collusion. Counts of winners do NOT mean NQC saw their opportunities in time or could displace them.

## Conditional stress: do NOT extrapolate to a month or assume selected historic winners are accessible

| Source-exclusion scenario | Nominal USDG repaid | TX | Active source windows |
|---|---:|---:|---:|
| All observed market activity | 526,735.979790 | 164 | 18 |
| Exclude three historic largest liquidator addresses | 203,127.857909 | 93 | 16 |
| Exclude historic largest-principal 24h source window | 429,854.230090 | 145 | 17 |
| Exclude both | 183,167.261965 | 84 | 15 |

For each source event, evaluate the invented theoretical oracle-based collateral exit sensitivity: max(0, floor(repaid_raw * [LIF * (1 - h) - 1])) in integer USDG base units. h is a chosen **total DEX-oracle realization haircut**, NOT a measured quote or fee. This deliberately optimistic illustration assumes all historical winners in the segment belong to NQC, a hypothetical 50/50 external sponsor contract, ZERO gas/builder/reverts/priority/sponsor-costs and no timestamp mismatch. The equation is NOT a strict upper bound on returns if spot exceeds oracle credit, and not a forecast.

| Assumed total haircut h | Implied NQC 50% share across all 23 days (USDG, NOT actual) | Implied share excluding both (USDG, NOT actual) |
|---|---:|---:|
| 0% | 33,384.67 | 11,609.19 |
| 3% | 24,482.09 | 8,513.41 |
| 5% | 18,547.04 | 6,449.55 |
| 8% | 9,644.46 | 3,353.77 |
| 10% | 3,709.41 | 1,289.91 |
| 12% | 0.00 | 0.00 |

At a hypothetical total 8% haircut, even 100% of those selected historic nonpeak/non-top3 transactions would yield only 3,353.77 USDG to a hypothetical NQC 50% partner in **23 days**, ignoring ALL other expenses. Under an invented 5% haircut it would be 6,449.55 USDG, but only under the same impossible hindsight-access assumptions. No valid comparison to a 30-day after-tax USD5,000 target exists.

## Real economic and technical blockers before a single actionable trade

1. **Asset route.** Source-verified wsNET is a 18-decimal non-rebasing wrapper whose unwrap(uint256) returns sNET (9 decimals), not liquid NET or USDG. To liquidate and repay USDG inside Morpho's callback, prove the COMPLETE atomic wsNET -> sNET -> NET -> USDG transfer and sale with actual balance deltas and no preexisting inventory. The wsNET source is listed by Blockscout as *partially* verified; do not claim full deployment equivalence without additional evidence.
2. **NET fee.** NetNet's documented AMM NET trades incur a 5% levy; wallet transfers are exempt. This may be one ingredient of a collateral sale route; 5% is NOT a demonstrated total haircut and does NOT by itself reveal actual executable proceeds. The Uniswap v2 NET/USDG pair at 0x59f95461e68e0c77605299791e1449f175165b54 has had externally reported USDG reserves; those public snapshots are not source-time quotes, not current same-block reservations and cannot be combined with historical liquidation oracle prices.
3. **Oracle credit.** Onchain Blockscout source for verified LoopbackOracle at 0xcde9599059f8ae6d6b9f33a0af7877827ec75f16 prices wsNET using clamp(30min-4h NET/USDG TWAP × 0.9, treasury backing-per-token, 5×backing) times the staked-index. Divergence guard reverts when spot is more than 15% below TWAP. A healthy oracle may create spot/oracle basis risk; cannot treat the 12.676% nominal liquidation incentive as a fixed sale spread.
4. **Competition.** Morpho's official open-source liquidation bot already supports Robinhood chain 4663, defaults to detection-only without route configuration. 52 competing indexed addresses performed historical liquidations. NQC has not measured first-seen, swap advantage, gas, inclusion or any probability of displacing them.
5. **Financing.** No third party has formally accepted to fund native ETH gas, failed bids, routing, guarantees, infrastructure or costs without recourse to the creator. Thus no live canary, settlement or positive NQC P&L under OWN_CAPITAL = USD 0.

## Verdict, score and next decision

**Research: BUENO**, authentic exact-source recurring-market discovery rather than PR-only engineering. **Monetization: MALO**, not yet a viable commercial route. Technical confidence ALTA for source-locked arithmetic; indexer market completeness MEDIA inside 23 days; future economic confidence BAJA. Technical 9.9/10 unchanged, commercial 5.8/10 unchanged, economic validation 4/10 unchanged, NQC realized P&L USD 0.

**ONE NEXT GATE:** obtain legitimate same-block price/oracle and independently executable wsNET -> sNET -> NET -> USDG quote at exact seize sizes, include the 5% NET tax where applicable, pool reserves/price impact, outer gas/failed attempt/builder costs, and compare with baseline open bot. If endpoint denies authorization, stop at INCOMPLETE and do not bypass. Without this same-block quote, do NOT construct a trading executor or score up. Astra separately audits no-recourse financing; no repeat RFI.

## Reproduce (offline)

- python3 morpho_wsnet_23d_economic_gate.py --source-zip /path/to/original-11944154144.zip --output wsnet-audit.json
- NQC_PR741_CERTIFIED_SOURCE_ZIP=/path/to/original-11944154144.zip python3 -m unittest -v test_morpho_wsnet_23d_economic_gate
- The CI reads exactly one same-repo historic GitHub Actions ZIP through Actions read access, validates all 9 source checksums and runs **24 adversarial integration checks**. No live chain interaction.
- Source of token metadata/verified contract code: Blockscout Robinhood Chain, chain 4663 (read-only on 2026-10-15); independent context from Dune 1inch Morpho liquidators: https://dune.com/1inch/morpho-liquidators
- Official Morpho Robinhood dashboard: https://data.morpho.org/chain/robinhood-chain
- NetNet documentation: https://docs.netnet.capital/
- DEXScreener historical pool: https://dexscreener.com/robinhood/0x59f95461e68e0c77605299791e1449f175165b54
- Official baseline bot: https://github.com/morpho-org/morpho-bots/blob/main/bots/blue-liquidation/README.md

No publication of private source, source archive, wallet secrets, customer IP or contract to third parties. DRAFT only. No spending, merge or production.
