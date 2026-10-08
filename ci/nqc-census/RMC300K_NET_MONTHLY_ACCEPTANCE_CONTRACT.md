# RMC-300K: USD 300,000 NET per month as minimum economic admission target

STATUS: POLICY TARGET — NOT CERTIFIED PERFORMANCE. Read-only engineering gate, never a permission to trade or modify RMC-014/015/016/017 terminal authority.

## Non-negotiable threshold

- Net of at least USD 300,000 per **complete 30-day observation period**. Simple 30-day reference = USD 10,000 net per day. This is not gross edge, not liquidated principal, and not monthly protocol-wide margin.
- A separate statistically independently validated, regime-aware, out-of-sample reliability target: P(monthly_net >= USD 300,000) >= 0.90. A hypothetical one-month P&L does not establish a probability.
- OWN_CAPITAL = USD 0 for the *entire* execution, including chain native gas, flash principal, priority fees, builder/MEV payments, revert losses, operating/financing expenses, collateral, hedges and inventory. Every source must be independently available with actual fee, block cap, contractual and atomicity conditions.
- No certificate on the basis of favorable price scenarios, 127 historical market winners, token liquidity available to borrow, data-mined opportunities or unverified snapshot projections.

## Authenticated observed-market context, not Nexus profit

D16 source at commit 96a0b3e3c0b55df1b1d890f8c70a7a9014e2ff9a, Git blob 5d5ed3635a426d686c8a98aa3547fd5b9d8b95aa, retains Ethereum Aave V3 historical winning liquidation transactions in block window 25880316..26095351:

- Exactly 127 historical competitor-winner tx and 139 liquidation events.
- Oracle gross edge USD 138,045.17469031, not full historical net P&L and not money earned by Nexus.
- Observed winning gas USD 1,144.134260592713842029, partial gross minus gas USD 136,901.040429717286157971, before all other costs.
- Hypothetical 100%-capture, zero-other-cost gross comparison short of USD300K by USD161,954.82530969. This compares only the observed recorded gross to the proposed minimum; it is NOT a global upper bound on other chains, protocols, opportunity types, uncaptured opportunities or more efficient routes.
- Censored candidate accounts are zero capacity until independently admitted, not additional detected winning operations.

## Strict funnel for economic certification

1. Multi-chain/protocol canonical market discovery with complete source reconciliation; report discovered, active, state reconstructable, actionable, capital feasible and net-positive markets separately.
2. Authenticated decision-time state and time of opportunities; no later winner transaction knowledge in earlier ex-ante selection, no lookahead or survivor cherry-picking.
3. Exact third-party-funded principal AND chain-native gas with block-pinned availability, fees, protocol caps, repayment semantics, atomicity and zero operator capital.
4. Fork-replayed calldata and economic completeness: integer liquidation math, asset conversions and token behavior, protocol/flash fees, DEX slippage/depth, gas/L1 fees, priority/builder fees, successful and failed inclusion, revert risk, financing, inventory and other operating costs.
5. Realistic market competition, latency, builder inclusion, private/public flow, measured/defensible capture probabilities, opportunity lifetime, correlated risks and explicit no-double-counting of borrower/flash/DEX/source capacity.
6. Independent shadow/out-of-sample full 30-day window and uncertainty estimation, P>=0.90 reliability, exact 300k monthly net and repeatable evidence archive with no unresolved mismatch or censored promotions.
7. Separate independent final certification. This static target gate can NEVER issue that certificate solely from a user-written field, self-asserted capture value or toy fixture.

## Failure policy

When 300k is not established, status is RMC300K_NET_MONTHLY_TARGET_UNPROVEN, and report precisely missing evidence or measured capacity shortfalls. Do NOT lower target to make a dashboard green. Expanding scope to new chains and protocols is an evidence-collection strategy, not an assumption that the target will be met.

Economic green requires real executable NQC strategy net revenues, not historical gains of other operators or an internal expectation. Neither the gate nor its tests issue an order, fund wallet gas, sign any transaction, edit main/Cano Penal/Vercel or change terminal state.


## Necessary gross volume under uncalibrated capture assumptions

If, solely for sensitivity analysis, a fraction of theoretically available gross oracle edge can be captured and **every other cost is zero**, then the required cross-market monthly gross edge is:

| Assumed capture of gross opportunity edge | Minimum cross-market gross under zero other cost |
|---|---|
| 10% | USD 3,000,000 |
| 25% | USD 1,200,000 |
| 50% | USD 600,000 |
| 100% | USD 300,000 |

No percent here is a measured Nexus win rate, probability or forecast. Any real protocol, flash, swap, priority, failed gas, builder, infrastructure or capital fee INCREASES the requirement. The table is an underwriting sensitivity under a simplifying mathematical relation, not a prediction or a claim of actual observed market capacity.


## Separate current external funding admission blocker

The RMC-011 registered authorized external-provider file currently has **provider_count=0** and explicitly states no external gas provider is configured or claimed available. Exact source Git blob: a9c1427bb05828d08ade537899ee1b8e43b97ed2, path ci/nqc-census/rmc011-external-capital-provider-registry.json.

This does not prove external sponsors do not exist anywhere in the market. It DOES prohibit marking a zero-own-capital operational route as proven on this head until separately authenticated authorized providers, actual gas sponsorship and full payment semantics are admitted.

The underwriting report binds this absence as a separate negative evidence source. A forged provider JSON with provider_count>0 changes the source blob and is rejected. None of the other competition/cost/temporal blockers are waived if a provider is later registered.
