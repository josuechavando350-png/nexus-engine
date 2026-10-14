# NQC V2 — The TRUE local complete EOA gas boundary, including setup, versus hypothetical inclusion headroom

## Exact commercial question

For the **ONE** authentic historical WETH/USDC liquidation with a locally certified complete EOA receipt, how much of the counterfactual USDC flash-loan-and-swap surplus would remain after repricing measured whole-transaction gas **and charging the three setup transactions**, before ANY inclusion fee, sponsor share, failure cost, builder competition or operating cost? This is a sensitivity boundary, not a real opportunity or a forecast of an achievable winning bid.

## Two immutable authorities (no RPC reads in this producer)

1. PR723 exact head **95ac66423da56ddd0a6862a9a17bf2f66655cd2a**, tree **2b830164ad3d8f7c52261a93e7ba5935ae85cc51**, [specialized run 38620588292](https://github.com/josuechavando350-png/nexus-engine/actions/runs/38620588292) SUCCESS, artifact **11922091704** ZIP SHA256 **edae8d055655f0fc23c443dbdccdf9c4150311133a1966249d4957dcd80ed346** with 36/36 exhaustive SHA256 content manifest entries. PR723 independently reconciled the actual **34 event logs** in the local isolated Anvil receipt: original Aave LiquidationCall, flash principal+premium repaid, FundingExecutionCompleted profit and ERC20 transfer of 2,273,989,378 USDC base units to an ephemeral local-only EOA. That economic payout is **LOCAL fork-only**, not a public Ethereum win.
2. PR720 exact head **eb58765724b9583c04c469c9ae387a78cc125f3c**, tree **ed52819926897a361782783e340a44d42c96dbad**, [specialized run 38593985410](https://github.com/josuechavando350-png/nexus-engine/actions/runs/38593985410) SUCCESS, artifact **11909875203** ZIP SHA256 **8675a4aeef42796f90b796c070d381a31df5f56af059ea7646a4cbf5537dab31** with 19/19 manifest members. It authenticated competitor original canonical Ethereum transaction gas price **1,086,577,108 wei/gas** and after-trigger Chainlink ETH/USD **2,541.6465** on block **26,142,067**. This is a historical competitor fee context, NOT an NQC paid fee or a production quote.

This consumer authenticates both exact ZIPs, all manifest bytes and commit/tree identity, their byte-identical nested PR698 Aave funded-route ZIP and PR700 oracle price ZIP, actual PR723 raw local receipt SHA/log SHA, original winner tx and block, real local 917,625 gasUsed, exact 34 logs and final ERC20 USDC Profit Transfer. No unauthenticated independent claim is injected. A GH workflow verifies exact original run status + owning artifact digest.

## Arithmetic (integer USD micro-units, never floats)

Measured source facts:

| Category | GasUnits | Authority |
|---|---:|---|
| Local complete **execute** EOA receipt | **917,625** | Actual isolated Anvil tx receipt |
| Local strategy deployment EOA | **916,432** | Actual isolated Anvil setup receipt |
| Local coordinator deployment EOA | **1,957,983** | Actual isolated Anvil setup receipt |
| Local strategy permission EOA | **43,948** | Actual isolated Anvil setup receipt |
| **Three setup transactions** | **2,918,363** | Sum of distinct local receipts |
| **Setup plus execute** | **3,835,988** | No shared gas units |
| Funded-route local USDC final sweep | **2,273.989378 USDC** | ERC20 Transfer event to synthetic EOA |

If repriced under the **historical competitor's** 1.086577108 gwei effective fee at historical 2,541.6465 Chainlink ETH/USD (and **assuming** USDC=USD 1), the arithmetic yields:

| Economic mode | Hypothetical native cost (USD ref.) | Local historic surplus after native-only modeled cost |
|---|---:|---:|
| **Execute only, contracts already deployed** | 2.534201 | 2,271.455177 |
| **Charge all three setup tx plus execute to THIS borrower opportunity** | 10.593829 | 2,263.395549 |

The actual fee **paid in isolated Anvil** was 0.000638701766058375 *synthetic fork ETH* on the execute EOA at its own **696,037,887 wei/gas** synthetic local context. It was NOT the historical mainnet competitor fee and cost ZERO real ETH/MXN to the owner. **Do not mix those fee prices**.

The source also runs explicitly synthetic 10 gwei and 50 gwei gas-price stresses using the same original ETH/USD oracle, under BOTH setup accounting modes. Gas price regimes are assumed sensitivity points, not predictions or mainnet inclusion quotes.

### Bid-headroom arithmetic is NOT a builder offer

Let
- \`S\` = source-bound 2,273.989378 USDC,
- \`G\` = repriced native gas quote on either setup/execution mode,
- \`C\` = assumed extra fixed failure/financing/operation cost (0 or 50 USD),
- \`r\` = assumed external financing/sponsor profit fraction (0% or 20%),
- \`M\` = NQC desired *retained* share (25 USD or 100 USD),
- \`B\` = hypothetical **additional** inclusion/builder payment measured in USDC equivalents.

Then \`max B = max(0, S-G-C-ceil(M/(1-r)))\` and separately classify mathematically infeasible targets, using exact integer micro-USD. We treat the gas quote as **including its effective gas price and any corresponding on-receipt priority fee**. Do NOT subtract that same on-chain priority fee again in \`B\`. Private payments, cash sponsor terms and failed/reverted attempts remain UNKNOWN rather than zero; \`C=0\` represents an explicitly optimistic synthetic scenario, not an observed fact.

The result is **only the maximum mathematically tolerable additional payment under an assumed scenario**. It does NOT reveal a builder winning auction price, Chainlink SVR access, timing, nonrecourse payer, revenue share availability, or NQC's chance of inclusion. A future operation would require a contractually committed funding source and entirely new prospective evidence.

## Major execution architecture gap: deployment timing

The local replay inserted **three EOA setup transactions AFTER the original oracle tx0 and BEFORE the standalone NQC local execute EOA**. This is a synthetic fork schedule; PR723 **does not prove three setup transactions could be inserted in Chainlink's real private-orderflow single-backrun slot**. The deploy-on-demand strategy has an immutable **borrower** in its constructor. Reusing that deployed contract across unrelated borrowers is not demonstrated, so amortizing one deployment over unrelated strategies would be a false saving.

Thus two sensitivity modes are mandatory; neither is a proof of production readiness:
- **Execute only:** presupposes borrower-specific strategy/coordinator, permissions, nonce and sponsor were all prepared BEFORE the report, a separate as-yet-unproven engineering prerequisite.
- **Setup + execute:** charges all observed EOA setup gas to THIS specific opportunity, but does not claim those four transactions are insertable into the real sub-block MEV auction at the time of observation.

Do NOT take the healthy pre-oracle Aave state and artificially force HF<1 via state override to pass either mode.

## Certification / capital boundary

PFT CLOSED; RMC OPEN; Shadow P2 NO CERTIFICATION; LIVE NOT AUTHORIZED. OWN_CAPITAL USD0 including gas, no nonrecourse sponsor; the owner's MXN 2,000 emergency reserve remains unused. NQC realized P&L USD0 and Commercial 5.9 unchanged. No deployment, wallet or mainnet signature, paid RPC, bundles, live gas, merge or smart contract write.

Next engineering milestone: pre-deploy a borrower-specific coordinator ahead of a source-authenticated oracle change in a local fork, using only **one** verified atomic execute tx after the change. Next commercial milestone (Astra-owned): prove access to a usable Chainlink SVR pre-inclusion signal and externally financed builder inclusion; no amount of local bid-headroom algebra proves these.
