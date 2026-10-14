# NQC V2 — Actual competitor native gas vs internal-route historical gas

## Why this gate is commercially relevant

Existing Aave liquidation forks yielded two real-historical route *counterfactual* surpluses before native gas and off-chain execution cost (PR698). Native gas did not have an actual cold whole-transaction NQC receipt. Estimating that unavailable receipt by copying the competitor's gasUsed or the test's gasleft delta would fabricate commercial certainty.

This experiment authenticates **three previously certified, immutable sources**, then distinguishes precisely:
- REAL gas paid by a **competitor**: successful Ethereum transaction receipt gasUsed × effectiveGasPrice. This payment is denominated in actual native ETH wei on Ethereum.
- ETH/USD *historical Chainlink oracle price* at the Aave liquidation trigger: on-chain economic conversion of native ETH into a contemporaneous USD **reference**, not actual bank/cash settlement.
- NQC's **internal call gasleft delta** within historical Foundry route: a different, incomplete meter excluding cold EOA transaction, transaction intrinsic fees, funding/deployment/inclusion, failures and sponsor. It cannot substitute for NQC's gasUsed.
- ONLY SENSITIVITY: assume hypothetical whole transaction gasUsed 1.25M / 1.75M / 2.5M, same competitor gas-price and Oracle USD reference; calculate native-cost-only residual against selected historical flash-funded surplus, **not NET or forecast**. No probabilities.

## Exact immutable source gates

1. PR694 real competitor receipt run 38490008728 SUCCESS, head 1908bfc36375e79ddf057278f6f02fd9d829a0dc, artifact **11860624437** ZIP SHA-256 **3dc59eca6051d7aa11e45d1042953ae61eca29ae032b0f70c4f441f4be621931**. Verify source ZIP, two authentic nested SHA256 manifest scopes, original indexer ZIP digest, producer code hash, original canonical block, actual winner transaction hash, log identity, real receipt gasUsed/effectiveGasPrice. Both provider results reported parity; public URLs do not establish independent operators.
2. PR698 funded fork historical route run 38498693805 SUCCESS, head 156e106c2efcd8bcb7f4931be3daa98309bd770b, artifact **11865385506** ZIP SHA-256 **6778f8e190d13c739331f731ca532d8607e3f653ca000de746b058b4903c7d7d**. Use inherited authenticated full manifest and strict real Aave liquidation/flash repayment route parser from postwindow_economic_envelope.py. Source #696 full attribution CI FAILURE is inherited as a failure, not relabeled green.
3. PR700 price causality run 38512327192 SUCCESS, head 9208aa3cb29325ecb3a90557d1c62114c697bf02, tree cc19baf261e33fdcbd8ac765fcc5e446af322d86, artifact **11871075488** ZIP SHA-256 **ca495ebdb9b8c7f8ed8438e5c3226b58b9c31c0d50e44ef35d6fce2cec232dde**. Verify complete SHA256 manifest, source commit/tree, both authenticated tx-index-0 Chainlink oracle answers and causal borrower HF crossings. Use the **after** answer at the same winner block. 8 decimals, no floats in monetary ledger.

## Actual observed competitor gas facts

| Historical case | Competitor receipt gasUsed | Receipt effective gas price | Native gas actually charged |
| --- | ---: | ---: | ---: |
| WETH collateral / USDC debt | 2,740,350 | 1,086,577,108 wei/gas | 2,977,601,577,907,800 wei = 0.0029776015779078 ETH |
| WETH collateral / USDT debt | 591,280 | 2,504,340,523 wei/gas | 1,480,766,464,439,440 wei = 0.00148076646443944 ETH |

In those two receipt/route source pairs, effectiveGasPrice numerically equals original canonical block baseFeePerGas, implying a zero **receipt-accounted EIP-1559 per-unit priority fee**. This does NOT prove zero private builder transfers or bids (not visible in the native gas fee field).

NQC **internal** route gasleft deltas (NOT full transaction gas): 1,115,038 gas WETH/USDC and 948,267 gas WETH/USDT. Importantly, the competitor consumed **more** than NQC's internal route in the USDC case, but **less** than NQC's internal route in the USDT case. Neither comparison yields a valid production gas estimate for the other participant.

Historical Chainlink ETH/USD values were $2,541.6465 and $2,409.6767 respectively; they are authenticated on-chain oracle answers, not executable exchange rates or real conversions.

## Strict stop rules and financial controls

A scenario's assumed total gas must be labeled clearly; no whole-transaction NQC receipt has been measured, no gas sponsor exists, and actual competition/inclusion + failed bids remain unknown. Stablecoins' peg to USD is an explicit convention, not source-verified. No claim that the original liquidation winner paid zero off-chain builder fees or that NQC can win after an oracle update.

PFT CLOSED, RMC OPEN, Shadow P2 UNCERTIFIED, LIVE NOT AUTHORIZED, OWN_CAPITAL=USD0 INCLUDING GAS not financed externally, Comerc. 5.9 unchanged, NQC realized P&L USD0. User has MXN2,000 reserved for gas but did not authorize spending it. This PR is **offline research only**. No sign, transaction, wallet, deployment, paid RPC, merge or infrastructure changes.

## Next gate after this result

Measure a complete cold NQC route using an exact temporary isolated EVM environment, with a whole-transaction receipt and authenticated source state, and only when it can be done without touching mainnet or user funds. Then tie prospective candidates to signed/net inclusion economics and a real nonrecourse gas sponsor. Historical competitor native fees are useful evidence but not that missing NQC execution proof.
