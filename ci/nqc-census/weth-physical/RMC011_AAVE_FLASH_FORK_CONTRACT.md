# RMC-011: Physical Aave V3 WETH flashLoanSimple at D08's anchored state

**Status: HISTORICAL FORK-ONLY CALLBACK/CAPITAL ROUTE TEST. No liquidation or Nexus cash flow is demonstrated.**

This work follows the [WETH physical behavior PR #631](https://github.com/josuechavando350-png/nexus-engine/pull/631) and does not remove any RMC008 or RMC011 token compatibility gate. It reuses the previously certified **unmodified T36 funding executor** `ci/nqc-t36/contracts/src/NqcFlashFundingExecutor.sol`, whose exact SHA-256 is `bbb5962171f2c1da5067e21ac705a627a35028fdafe5c9403f601bb813d39320`. T36 previously demonstrated callback parity in a different Ethereum block (20,000,000). This PR validates it at the actual A1 Census anchor, block **26,095,351**, Ethereum mainnet block hash `0x0d7a15fbb72e69696a33c65bc20902fe08e5630862ada64b065a97405c70c781`.

## Evidence gates

- Reauthenticate #631's successfully completed 14 offline + 9 real WETH behavior tests, at immutable commit `cc30f574dfab736723530df18c52f0afeb4f10cf`, run `37737680174`, artifact `11532297952`, outer SHA256 `4cda36624fa1f5fa608e4219e798964cf2c08954c4a47a7393a011b89b777388`.
- Independently repin canonical Ethereum block header and WETH code across dRPC/BlastAPI; original observed WETH runtime SHA256 `5566bf50796faf93c9b6f6adacd3b32c70bfe16b48ffc59db6cd144cbdc89739`.
- Read Aave Pool proxy/runtime code and `FLASHLOAN_PREMIUM_TOTAL()` at the same block using both independently operated providers; reject any historic state/code/premium disagreement.
- Compile exact T36 executor with pinned Foundry 1.7.1/Solidity 0.8.24 and run **six physical fork checks**:
  1. Confirm positive historical on-chain Aave total flash premium.
  2. Actually borrow 1 WETH via deployed mainnet Aave v3 `flashLoanSimple`, execute the T36 callback coordinator and repay full principal + *real measured fee*.
  3. Refuse insufficient premium and roll back the transaction atomically.
  4. Refuse a forged zero-premium source plan.
  5. Verify pre-existing WETH in the executor **cannot subsidize** a missing premium.
  6. Verify pre-existing WETH in the executor cannot subsidize a claim of positive net profit.
- Preserve original input source digests, historical RPC code/fee observations, forged-negative invariants and all physical execution logs with SHA256 manifest. The fee-only strategy in the test simply returns borrowed WETH principal and optional fixture-minted WETH premium.

## Crucial limitations

The positive flash loan test uses `vm.deal(address(strategy), fee)` to mint fake **ETH** and deposit it into WETH to pay the historical protocol fee. That is an explicit external **fixture subsidy**, NOT a verified available financing source. It does **not** satisfy `OWN_CAPITAL=0`, approve flash-capital/gas usage, or represent positive P&L. The T36 test plan's funding hash and evidence fields are nonzero local placeholders, not independent capital-source authorization.

Aave sends underlying liquidity from its aToken reserve, **not** from the Pool's token balance. The test does not use `balanceOf(Pool)` as a nominal liquidity gate. Successful same-block flash repayment at this single historic anchor does not prove full Aave liquidation, any borrower was liquidatable at the previous block, an end-to-end DEX route, exact historical gas/sponsor arrangements, searcher inclusion, competing capture, current market availability or 30-day reliable net profit.

All D08 BLOCKED token statuses, D11/12 capital rejections, D14/15/16/17 certification and monthly target remain unchanged. No mainnet transaction, wallet, signed order, key, production deployment or paid provider is introduced.
