# NQC V2 — Full local EOA receipt: prove Aave liquidation, flash repayment and USDC profit sweep

## Scope and admission

This gate is a **strictly stronger descendant** of PR722's successfully source-authenticated, **LOCAL-only** Anvil v1.8.5 complete EOA receipt. It adds a content-level, exact-event witness, rather than treating receipt status=1 or a Foundry script printout as proof of the actual atomic economic path. The historical opportunity is hindsight-selected; no prospective first-seen, competitive inclusion slot, external gas sponsor, builder payment or live net P&L is proven.

### Immutable upstream positive control

- PR722 head **1be05b6a566166791b27b75e620f658d29c321c6**; [run 38619020435](https://github.com/josuechavando350-png/nexus-engine/actions/runs/38619020435) **SUCCESS**; source artifact **11920744647**, SHA-256 **a812e4baf3d94e3fb74e04e84da8e2f6c10f498dcdbd99bb241b474b61fed842**, 35/35 source evidence members content-addressed.
- At Ethereum historical block **26,142,067**, the immutable Chainlink oracle source tx index 0 was reproduced inclusively, but the genuine competitor liquidation at transaction index 1 **was excluded** from the local counterfactual. All six Aave account state uint256 values matched source PR698 at the pre-winner point after the oracle trigger.
- Local Anvil (isolated 127.0.0.1) produced four successful synthetic test EOA receipts: three one-time setup, and one Aave flash-funded liquidation + Uniswap v3 token conversion at full **917,625 gasUsed**, effective **696,037,887 wei/gas** on the *synthetic local fork*. The internal historical \`gasleft()\` gross call delta **1,115,038** is not interchangeable with receipt gasUsed after EVM refunds. Source selected flash-funded route originally produced **2,273,989,378 USDC base units** after repayment and swap but before native gas or offchain costs. The new event gate must independently verify that source identity in the actual local receipt.

## Exact event-level accounting

On the real successful fourth Anvil receipt, require all of:

1. Exactly one **Aave V3 Pool LiquidationCall** event from canonical Pool \`0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2\`; indexed collateral WETH, debt USDC and authenticated borrower must match the exact source. Unindexed debt repayment **48,993,353,728**, WETH collateral seized **20,140,477,263,386,042,567**, \`receiveAToken=false\`, and liquidator must be the newly deployed local strategy contract. Reject an unrelated token/borrower/collateral or a second conflicting liquidation event.
2. Exactly one **NqcFlashFundingExecutor.FundingLegRepaid** event emitted by the local coordinator: funding leg index zero, source kind Aave=1, canonical lender Pool, principal **48,993,353,728**, fee **24,496,677**, total repayment **49,017,850,405** in USDC base units. Reject fee mismatches even one base unit.
3. Exactly one **NqcFlashFundingExecutor.FundingExecutionCompleted** event from that same coordinator, with asset USDC, principal **48,993,353,728**, realized profit asset **2,273,989,378** base units and exactly one funded leg.
4. Exactly one final **USDC ERC20 Transfer** event from coordinator to the ephemeral isolated test EOA, paying precisely **2,273,989,378 USDC base units**. A scripted printout alone is not sufficient to assert payment.

For each mandatory log, require the corresponding local EOA receipt's transactionHash and blockHash. The local result must preserve the **entire original receipt, all logs and content SHA-256**, not merely an aggregate \`gasUsed\`, for independent replay.

## Fail-closed and adversarial controls

Source authentication is inherited byte-for-byte: pinned original PR693 winner transaction-index 1, PR700 oracle causal transaction-index 0, and PR698 authentic funded route prewinner account + swap. No state overrides, fixture creation of profitable account, balance injection of ERC20 collateral, production deployment, mainnet keys or user funds.

Offline negative tests must reject altered profit amount, fee/repayment, borrower, missing/fake ERC20 profit sweep, wrong emitter, malformed ABI, wrong account, rejected transaction, and false mainnet/commercial claims. Test or source failures remain red. All bytes are preserved under exact-head GitHub Actions source/run/artifact/manifest SHA-256. If a specific real local receipt lacks any required economic event, report the exact mismatch and **do not weaken an assertion to make it green**.

### Boundaries

A successful LOCAL event-level receipt proves only that this hindsight-selected counterfactual atomic route repaid flash principal and paid the selected USDC surplus to the local synthetic EOA. The full local receipt \`gasUsed\` does NOT determine access to private Chainlink SVR first-seen or builder inclusion, live NQC fees, off-receipt builder costs, failed bid costs, sponsor economics, or monthly recurring P&L.

PFT CLOSED; RMC OPEN; Shadow P2 NOT CERTIFIED; LIVE unauthorized; OWN_CAPITAL USD0 including native gas payer unresolved; MXN2,000 user gas reserve untouched; realized NQC P&L USD0; Commercial score 5.9 unchanged. This branch and PR are **draft and unmerged**, no production trade or user-funded deployment.
