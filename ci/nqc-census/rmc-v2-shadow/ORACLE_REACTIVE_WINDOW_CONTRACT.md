# NQC V2 — Historical oracle report to Aave activation: reactive-window evidence

## Critical finding to test, not assume

The Ethereum DualAggregator primary NewTransmission report sometimes contains a new ETH/USD price *before* Aave WETH reads switch to that value. Historical block/receipt data from PR709 establishes the relative placement of primary/secondary updates, while eight exact fork executions at PR710 replay four event transactions on two public RPC URLs and verify which transactions cause Aave price updates.

These findings cannot establish the first time a competing builder could see either transaction, a liquidation-ready borrower, guaranteed ordering, or profitable capture.

## Source authorities and limitations

- PR709 producer workflow 38519386037 SUCCESS. Artifact 11873371179, ZIP SHA-256 5e5684fb4a98b87b1d9e2f15facb03ddb093e50a6e75ff4553b79fc192e69d38, head 635a10da08bb5b4cea7639c555cb2ddf7b38c551.
- PR709 receipt ordering was complete on **dRPC only**. BlastAPI returned HTTP 429; cross_endpoint_receipt_parity=false MUST remain false.
- PR710 producer workflow 38520341843 SUCCESS. Artifact 11873907902, ZIP SHA-256 dfe6213f2bc32777aa1f4e31172d197e19bf82ae052fae0418331b44cae1a0b7, head d002d4c0a850801ed73911cebcbbc627822d8f12.
- PR710 two-public-RPC historical EVM fork parity is independently reconstructed for the price response. This does NOT convert PR709 source-receipt provenance into a two-operator certificate. Two public RPC URLs do not prove independent backends.
- Both ZIPs must pass exact byte hash, unique/path-safe members, exhaustive SHA-256 content manifest, source commit/tree and report schema/status checks. No error, source drift or incomplete fork metric can become an affirmative result.

## Gate

Produce a two-round immutable JSON report:
1. Bind exact primary/secondary round IDs, transaction hashes, block heights and transaction indices to PR709's authenticated receipt-order pairs and PR710's two-RPC actual Aave price transitions.
2. Demand that each primary report contains exactly the WETH price later activated by secondary, while the primary tx leaves actual Aave WETH unchanged.
3. Demand that the secondary tx alone updates Aave WETH in both historical rounds, and validate the full price delta in raw integer units without floating-point rounding.
4. Compute actual movement in *millibasis points* (0.001 bp), together with a strictly hypothetical single-WETH-collateral/static-USD-debt health-factor threshold. This bound is **not** a reconstructed Aave borrower HF, and mixed collateral, user mode, fees, other debt and prices can invalidate that simplification.
5. Distinguish one-next-block boundary from consecutive transactions within the same block. The latter has **no reactive opportunity after seeing an already-confirmed primary block**; the former is a historical interval only, not measured network first-seen or usable builder ordering.
6. Preserve all false claims as false: mempool first seen, observable execution timing, contemporaneous borrower's risk, live opportunity capture, cold gasUsed, external nonrecourse native-gas sponsor, net P&L, P2, RMC and LIVE.

## What follows

The next real business gate needs a **prospective** event timestamp and price-direction classifier for pending primary transactions, plus exact borrower state at canonical secondary activation, completed transaction gas/builder/failed-attempt costs, and actual nonrecourse gas financing. Even evidence that a new primary report arrives before a secondary would not establish that the operator can place a liquidation transaction between them, especially for same-block paths.

No key, on-chain signatures, deployment, transaction submission, paid plan or new host. PFT CLOSED; RMC OPEN; P2 Shadow uncertified; LIVE unauthorized; Commercial 5.9 unchanged; NQC realized P&L USD 0. The USD45–55k monthly objective remains a falsification target, not a forecast.
