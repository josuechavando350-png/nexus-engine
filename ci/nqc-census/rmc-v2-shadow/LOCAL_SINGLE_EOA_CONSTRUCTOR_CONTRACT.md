# NQC V2 — ONE EOA transaction after historical Chainlink tx0: constructor-funded flash liquidation

## Why this matters

PR723 proved a successful actual isolated-local EOA receipt for the selected WETH/USDC source-controlled historical liquidation: **917,625 gasUsed** for the final execution **plus three distinct setup EOA transactions (2,918,363 gas)**, all after the source Chainlink oracle tx0. PR724 authenticated this accounting and identified the unproven prerequisite: three setup EOA transactions are **not established insertable into a single SVR private-orderflow backrun slot**; a borrower-specific strategy predeployed before the price trigger is not proven.

This experiment tests an architectural alternative: a single **local EOA contract creation** immediately executes, in its constructor, (1) borrower-specific strategy deployment, (2) coordinator deployment, (3) strategy permission, (4) Aave flashLoanSimple, (5) Aave LiquidationCall, (6) Uniswap v3 fee-500 conversion and flash repayment, (7) transfer of the resulting USDC surplus to the same ephemeral local EOA. Every step must execute atomically in **exactly ONE mined local EOA receipt**; no three intermediate setup EOA transactions are ever broadcast.

It remains **a fork counterfactual, not a public Ethereum or Chainlink SVR trade**. We do not claim MEV-Share accepts contract-creation backruns, that a builder gives us the required single slot, or that the original competing winner could have been displaced.

## Unchanged original source authorities

- Authenticated PR723 SUCCESS run 38620588292, head 95ac66423da56ddd0a6862a9a17bf2f66655cd2a, artifact 11922091704 ZIP SHA256 edae8d055655f0fc23c443dbdccdf9c4150311133a1966249d4957dcd80ed346, complete 36-member SHA256 manifest.
- Nested original source PR698 funded historical route artifact SHA256 6778f8e190d13c739331f731ca532d8607e3f653ca000de746b058b4903c7d7d; original PR700 oracle tx0 causality ZIP SHA256 ca495ebdb9b8c7f8ed8438e5c3226b58b9c31c0d50e44ef35d6fce2cec232dde; original PR693 indexed competitor winner ZIP SHA256 5a198ad15588e6e2ec692ef05ab16f51127141b3b00b0949b6ea7d945b20d1c4.
- Underlying canonical source: winner **tx index 1** 0x08db2e5d5f4e627f9fb4d12a780aac26aed725fab36b70fb9647119872d74625, exact immediately preceding ETH/USD oracle **tx index 0** 0x20dd5bccadb185dbac34c94c8d00bf363a4a0b779fe1fddcdcfd8a3066d96c8b, block 26142067, source six-word borrower risk ABI at that exact transaction-prefix state (HF<1). Do NOT inject oracle, borrower balances, collateral tokens or fabricated prestate.
- Source Solidity byte-for-byte original T36 coordinator, original PR698 historical liquidation harness and original compiler config; only new isolated **one-shot** constructor/Foundry script. Hard historical block bounds in the Solidity contract make accidental current/mainnet deployment unusable.

## Strict local transport

1. Validate official immutable Foundry v1.8.5 binaries (matching PR723 official release digest + independent release .sha256 asset). Use isolated ephemeral GitHub Actions environment.
2. Fork Ethereum history using Anvil v1.8.5 at \`--fork-transaction-hash <source Chainlink oracle tx0>\`; verify the original source-prewinner entire **six-word Aave borrower ABI** before any synthetic test gas/account injection. The original winner must be excluded.
3. Generate a fresh LOCAL-only ephemeral EOA private key and mint a synthetic ETH balance using only \`anvil_setBalance\` to \`127.0.0.1:18545\`. Never use real funds or a user wallet.
4. Compile and run a new single Foundry script with exactly one \`vm.startBroadcast()\` contract-creation statement. It constructs borrower-specific liquidation strategy, coordinator, exact funding plan and executes fully within that one EOA constructor transaction. Funds, collateral and repay amounts are verified by the same original source contracts, no inventory injection.
5. Require **exactly one** new Foundry transcript transaction and one independently re-fetched local Anvil EOA receipt with status 1, to=null, contractAddress nonzero and bounded actual receipt gasUsed.
6. Authenticate within that ONE receipt: one canonical Aave liquidation (correct WETH collateral, USDC debt, borrower, principal, WETH seized and strategy), one canonical funding-leg repayment (Aave principal + fee), one coordinator completion, **two ordered actual USDC ERC20 transfers** (coordinator to constructor address, constructor to synthetic EOA), and \`LocalOneShotLiquidation\` with exact original winner, borrower-specific strategy/coordinator addresses and **2,273,989,378 USDC base units** local surplus. Preserve entire raw receipt, code hashes, source/winner/provenance, negative tests, errors, SHA256s and exact git commit/tree.
7. Reject code mismatch, stale/wrong block, first-stage Aave HF>=1, any revert, wrong event/recipient/fee, side effect that issues two+ EOA transactions, non-loopback RPC or insufficient source evidence. No bypass/override.

## What success would and would not mean

A valid local one-shot receipt **would prove that the on-demand creation + entire atomic funded route can be squeezed into one LOCAL EOA contract-creation transaction** under the selected historical prewinner EVM state; its **actual local gasUsed** can be compared with the PR723 917,625 execute-only plus 2,918,363 setup EOA units. It would close the **mechanical** multi-EOA post-oracle setup gap in that one selected route.

It would NOT prove a builder or MEV-Share accepts a contract creation as the one backrun, that it can receive enough prospective calldata, first receive a private oracle update, compute/pre-sign before builder deadline, win an auction, access a nonrecourse native gas sponsor, or earn monthly net profit. It may consume more gas than the split setup transaction scheme due contract initcode; cost and block gas limits must be measured rather than assumed.

PFT CLOSED; RMC OPEN; Shadow P2 uncertified; LIVE unauthorized; OWN_CAPITAL=USD0 including native gas still unsponsored; user MXN2,000 untouched; NQC settled P&L USD0 and Commercial 5.9 unchanged. No mainnet signature/broadcast/paid operation/deploy/merge. Failure remains genuine evidence; do not relax the economic events or original account hash to turn it green.
