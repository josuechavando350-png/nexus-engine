# RMC-016 — Genuine same-token Aave liquidation attempt in time-only fork

**A counterfactual historical execution test, NOT actual market trading or Nexus realized profit.**

## Why this is now feasible to test

Three independent source-locked strands are combined, without modifying the original Aave or WETH contracts:

1. Real Aave V3 WETH flashLoanSimple 1 WETH callback/repayment at historical RMC011 A1 block was proven in [PR #632](https://github.com/josuechavando350-png/nexus-engine/pull/632), but its flash fee was paid with **test-minted** WETH. That test does not prove zero-fee subsidy liquidation.
2. RMC016 true highest historical WETH/WETH competitor win is tx `0x6313fb267755f3cfa48214bf74309505984306129ee09a558efe4801006dcbba` in block 25938048, repaying 10.684013854557827871 WETH debt. Exact original raw Aave LiquidationCall ABI and borrower/indexed identity, full competitor receipt, real collateral asset and WETH debt were authenticated in [PR #633](https://github.com/josuechavando350-png/nexus-engine/pull/633).
3. At original predecessor block 25938047 the actual borrower HF was **1.000000001993818630**, not yet liquidatable. The source-locked **time-only** local fork in [PR #636](https://github.com/josuechavando350-png/nexus-engine/pull/636) advanced just `vm.roll` and `vm.warp` to the true winner block timestamp: HF fell to **0.999999999704293538**. Other two leading winners did not fall below 1 from time alone. Original same-block transactions were not replayed.

## This exact attempted transaction

Reauthenticate source [run 37740704145](https://github.com/josuechavando350-png/nexus-engine/actions/runs/37740704145), artifact **11533288894**, SHA256 `7d813c6cad278a5044d1c4ce57492efb07c5c0d73d69481769f92a4cc4151185`, head `030d95c705a1fce77c3345cada4c8cd698f4a1db`. Extract the public borrower identity, exact winner and predecessor timestamps from its authenticated two-RPC canonical header source. Require the exact first-rank previous and time-only HF above. Use **only this source**, not an unpinned address manually supplied by a user or another RPC.

Foundry 1.7.1, Solidity 0.8.24 and the same immutable T36 flash executor code used by #632 (raw Git blob `aa3883fa141aa096006e90e56d8d4150c9ee14ef`, official formatted SHA256 `bbb5962171f2c1da5067e21ac705a627a35028fdafe5c9403f601bb813d39320`), Ethereum mainnet fork at previous block 25938047. Apply only block time/number to winner block 25938048, without applying original competing winner tx or any other within-block transaction. Require exact source health factor parity and actual deployed Aave Pool/WETH contracts.

The test then attempts to:
- Borrow **10.684013854557827871 WETH** from the original deployed Aave V3 Pool using `flashLoanSimple`, via original T36 source coordinator.
- Call Aave `liquidationCall(WETH,WETH,borrower,principal,false)` from an owned strategy using borrowed WETH only.
- Transfer all physically seized/remaining WETH back to the coordinator.
- Repay flash principal plus the **actual 5bps fee** and require a positive WETH surplus after flash fee.
- Check atomic reversion of an impossible profit claim, with no positive balance or collateral changes.

**No `vm.deal` or token/inventory subsidy exists in this test.** Any positive WETH surplus must come from actual fork-liquidation collateral proceeds in the sim. The protocol strategy uses exact borrowed principal and does not spend an old WETH inventory.

## Essential economic limitations

Even a full successful fork simulation would NOT finance transaction-native ETH gas, priority/builder fees, failed attempts, collateral-route friction outside this WETH/WETH case, transaction inclusion or a real strategy's opportunity detection. The candidate was selected RETROSPECTIVELY with future competitor knowledge, so no ex-ante capture rate or frequency is demonstrated. No wallet transaction is broadcast, no user capital is transferred, and no external sponsor is registered. Any WETH surplus observed would be **counterfactual fork-only profit in WETH before own-transaction gas/MEV**, not realized net USD P&L, nor proof of $30k/$300k monthly targets.

If the real Aave liquidation reverts, this is a source-bounded NEGATIVE physical result: do not spoof collateral balances, oracle values, user health, a flash fee or a lender quote to make the test pass. Report the exact revert and identify possible protocol restrictions. Keep RMC-011/014/015/016/017 final authority unchanged until all their independently authenticated gates are actually met.
