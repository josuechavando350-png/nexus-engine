# NQC V2 — Deduplicated competitor capacity vs USD45k–55k commercial hurdle

## Decision question (not a forecast)

Can the *observed indexed competitor activity* in two most active WETH/stable debt markets, hypothetically valued using the only two source-authenticated historical NQC flash-route surpluses, support a USD45k–55k **net** monthly target? What capture share and cost budget would be necessary under those extremely favorable assumptions?

This is a **falsification screen**, not calibrated future earnings, market completeness, realized NQC revenue or an upper bound on what other strategies could earn. Continue work on other markets, protocols, shadow execution, native-gas sponsor and oracle research as new opportunities arise.

## Two immutable source authorities

PR693: run 38489472232 SUCCESS, head 219b8e97ee667c0797980e3e28edf34030ad1a03, artifact 11861430884, ZIP SHA-256 5a198ad15588e6e2ec692ef05ab16f51127141b3b00b0949b6ea7d945b20d1c4. Its seven-member evidence manifest binds original indexed source ZIP b3d82ccd21cd683424b99c020732d2e2978ce2981a51b46df177a2d22c7bb722 and exact producer bytes. Re-run inherited producer validation against the nested original 139-event/127-tx positive control, not only the precomputed summary. Original indexer covers 89,390 Ethereum blocks, 53 liquidation logs, 47 distinct winner tx, 21 asset pairs, with 9 WETH/USDC and 7 WETH/USDT distinct tx counts. Blockscout REST results are NOT a full authoritative RPC scan or complete source of future revenue.

PR698: run 38498693805 SUCCESS, head 156e106c2efcd8bcb7f4931be3daa98309bd770b, artifact 11865385506 ZIP SHA-256 6778f8e190d13c739331f731ca532d8607e3f653ca000de746b058b4903c7d7d. Authenticate the exact ZIP, all source and manifest members, real WETH/USDC route surplus 2,273.989378 USDC and WETH/USDT 150.882941 USDT after *actual historical flash fee and one specific Uniswap swap*, but before native gas, builder, failed attempts, sponsor and operating costs. Both are hindsight-selected pre-winner counterfactual executions, not profits.

## Critical correlation correction

Original indexed raw events contain **one actual Ethereum winner transaction included in both pair groups**. Thus 9+7 pair counts represent **15 independent transaction slots**, not 16 winning transactions. The shared transaction hash is recorded in the derived report; it can be valued only once using a predeclared selected surrogate, rather than claiming two independent captured opportunities. Three multi-pair overlaps exist across the entire 21-pair universe: sum of individual per-pair winner counts 50 versus 47 unique transaction hashes. Neither represents proof that NQC could capture any event.

## Synthetic sensitivity, not net expected value

Convert the fixed observed window to one 30-day *assumed* 216,000-block interval at 12 seconds/block, which is not an observed future arrival rate. Assign the original WETH/USDC surplus to 9 unique transaction slots (including the one shared), and WETH/USDT surplus to the remaining six; this is a **homogeneous, hindsight-selected surrogate** and is NOT a measured average market edge or a general upper bound.

Explore **hypothetical combined paid costs of $0, $100 and $300 per captured transaction**. These values are explicitly synthetic; the gas used for the PR698 execution call is not full transaction receipt gasUsed, actual ETH/USD conversion and stablecoin peg aren't independently certified, MEV inclusion and failed bids are not calibrated, and no one has contracted to pay gas without recourse. If assumed costs exceed the gross surplus of an individual slot, rationally reject it instead of including negative-margin captures.

For each assumption, compute full-surrogate-capture residual monthly USD micros and the minimum fraction of those *assumed* positive-value slots required for USD45k and USD55k. Fractions above 100% mark the target not reachable **within this synthetic two-pair model**, not impossible in broader Ethereum/DeFi. No probability, reliability, confidence interval, capture win-rate, net PnL or new trade authority is inferred.

## Required next real-world gate

1. **Actual prospective opportunities** — full event timestamp, source and block lineage, borrower HF before competitor inclusion, conflicts and outcomes, not retrospective winner cherry-picking. Shadow-only.
2. **Economically executable route** — cold whole-transaction gasUsed, real swap/flash route, builder bid, failed attempts and return-asset monetization, verified on a pinned state. No artificial receipt-gas substitution.
3. **Independent capitalization** — externally documented nonrecourse sponsor for native gas/priority/inclusion and no fallback to operator-owned capital. OWN_CAPITAL=0 remains a hard blocking requirement.
4. **Broader active markets** — test the other indexed pairs and additional protocol/chain opportunity sets; this analysis freezes none.

PFT CLOSED, RMC OPEN, Shadow P2 UNCERTIFIED, LIVE UNAUTHORIZED. Commercial score 5.9 unchanged, realized NQC P&L USD0. The goal USD45k–55k is an explicit hypothesis to falsify. Draft PR; no merge, deployment, signing, broadcast, wallet or new paid service.
