# NQC V2 — 4337 Smart-Account Operator / Sponsor Accounting Source Gate

Date: 2026-10-15. STRICTLY LOCAL / SYNTHETIC paymaster and account; authentic pinned Morpho Blue `Morpho.sol`. No forks, real RPC, deploy, live transaction, wallet, real gas, recurring task, customer or sponsor.

## Objective
Validate **operator address** and native-gas **cost responsibility** separately for NQC original native Morpho callback. The NQC `NqcMorphoNativeCallbackLab` constructor assigns `operator` immutable. A smart account can be the operator. After a successful liquidation, NQC transfers all gross loan-token surplus to the smart account; the Morpho contract performs real debt repayment within the local EVM. On failure, Morpho liquidation state reverts atomically but an on-chain included ERC-4337 UserOperation may still charge the sponsor for execution gas.

## Authentic and modeled components
- **AUTHENTIC:** the unchanged Morpho Blue source `morpho-org/morpho-blue@8e26ca6a8dbc5089edcd67fb576248810fd2870a`, blob `ab064b646bf161b1510e2575a99412cdc2a43ebb` and our unmodified original PR #749 source contract.
- **MODELED:** `Nqc4337IntentAccountLocal` models immutable EntryPoint, owner-approved intent and replay refusal. This is NOT an IAccount/EIP-712 signature or a real ERC-4337 nonce. `Nqc4337EntryPointAccountingModel` is NOT ERC-4337 compliant, only mimics authorization, catching execution reverts and charging sponsor. `Nqc4337GasSponsorVaultLocal` is a *locally funded mock*; this is NOT Alchemy, ZeroDev or a real deployed paymaster.
- **TEST FIXTURES:** local LocalToken ERC20, synthetic unhealthy borrower, oracle and mock DEX pricing. The test's 0.01 ETH sponsor funds are created by Forge `vm.deal` cheatcode, not real ETH. The 0.00005 ETH/operation cost is fictional, supplied to the mock. Do not infer actual Robinhood gas, USDG value or a non-recourse sponsor.
- **SECURITY CONTROLS:** preapproved digest binds chain, account, target, calldata; account restricted to test EntryPoint, executor restricted to smart-account operator; sponsor restricted to the exact account and target plus fee cap; failures after execution charge gas while reverting collateral and debt; validation reverts before sponsor charge; replay and forged payload rejected.
- **EXPECTED LOCAL EVIDENCE:** source-compiled Morpho liquidate -> NQC callback -> mock router -> repayment -> profit in smart account; zero ETH in smart account; local sponsor vault debited; failed app operation still debits mock sponsor; sponsor without funds refuses prior to execution.

## Mandatory gates for any EIP-4337 claim (NOT MET BY THIS LAB)
1. Compile/test against real pinned `eth-infinitism/account-abstraction` EntryPoint v0.7 and actual `PackedUserOperation` structure, real `IAccount.validateUserOp` with cryptographic signatures, nonce, replay, `IPaymaster.validatePaymasterUserOp` and `postOp`. Match deployed EntryPoint on chain 4663. Avoid fake mock-only "integration passed" claims.
2. Verify a compatible bundler offers Robinhood mainnet sponsorship to an explicitly approved operator contract; secure a *funded, non-recourse* sponsor. **Alchemy / ZeroDev billing or credits create liability for policy owner and do not constitute zero cost.**
3. Robinhood chain inherits Arbitrum `block.number` behavior. Do not copy PR #749's `block.number` expiry semantics to Robinhood without independent `ArbSys(100).arbBlockNumber()` proof. Current PR749 uses L1-like EVM NUMBER.
4. Require authentic same-block DEX route, fee, tax, liquidation eligibility, competitiveness, gas and sponsor cost before any live execution.
5. No real NQC P&L or forward capture certified. Economic validation 4/10 UNCHANGED; own capital spent USD 0; no CANARY/LIVE.

Sources:
- EIP-4337 specification: https://eips.ethereum.org/EIPS/eip-4337
- Paymasters and deposits: https://docs.erc4337.io/paymasters/index.html
- Alchemy Gas Manager (sponsorship with invoice): https://www.alchemy.com/docs/wallets/low-level-infra/gas-manager/gas-sponsorship/using-sdk/basic-gas-sponsorship
- ZeroDev policy billing: https://docs.zerodev.app/smart-accounts/sponsor-gas/evm
- Robinhood developer connecting docs: https://docs.robinhood.com/chain/connecting/
- Arbitrum L1/L2 block numbers: https://docs.arbitrum.io/arbitrum-essentials/arbitrum-vs-ethereum/block-numbers-and-time

## Verdict protocol
A green modeled test certifies *only* the source-authentic Morpho operator pathway and local sponsor fee-accounting negative cases. It does not prove a real ERC-4337 UserOperation or a sponsor capable of covering failed costs. **No economic upgrade / NO actual monetization claim**.
