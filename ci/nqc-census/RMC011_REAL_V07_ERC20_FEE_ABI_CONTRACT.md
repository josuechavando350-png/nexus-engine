# RMC-011 — Real SingletonPaymasterV7 ERC20 gas price and penalty semantics

**Scope: read-only real deployed paymaster fee ABI on historical Ethereum, NOT a signed NQC gas quote, WETH acceptance, actual credit line or realized profitability.**

## Immutable source authority

PR #642 (https://github.com/josuechavando350-png/nexus-engine/pull/642) independently verified the deployed SingletonPaymasterV7 at Ethereum 0x777777777777AeC03fd955926DbF81597e66834C against the canonical v0.7 EntryPoint at 0x0000000071727De22E5E9d8BAf0edAc6f37da032. Exact anchor block 25938047 and hash 0x42cf44b75185587327a1aa8fc859cc5f49a639e7256547511430d6068b6f09ab, deployed runtime SHA256 7072ea9287df0e632703bb6c410be3bbfbcaff40bdcb6e6136a982d05dac5bd1.

Original run 37749452459 SUCCESS, artifact 11536559079, ZIP SHA256 f647e86f3a53a33612df214987a09f89eb22f46f86629972247eb2f641b743f9. The original historical total provider EntryPoint deposit was 1.985656782898694497 ETH. It belongs to an external actor; NONE is authenticated as allocated to NQC.

Original source code pins from pimlicolabs/singleton-paymaster public GitHub master (no copying or mutable-head trust): src/SingletonPaymasterV7.sol Git blob 344bde651e1f8a3954532b207f4bc11635100696, src/base/BaseSingletonPaymaster.sol blob cc0fab63d188d6bfca6200236ff3e7e88c3f57b0, README.md blob 5454391aa7a37d464191772cc927ba1e5709be5c. GitHub Actions must independently retrieve each exact blob and verify its Git object ID. Source: https://github.com/pimlicolabs/singleton-paymaster/tree/master/src . The actual deployed bytecode is additionally pinned and matched by two independent RPC operators; source and runtime identities must not be conflated.

## What is actually measurable without a Pimlico quote

- Real deployed getCostInToken(uint256,uint256,uint256,uint256) selector 0x5525dcfb: (actualGasCost + postOpGas * actualUserOpFeePerGas) * exchangeRate / 1e18, integer floor.
- Real deployed _expectedPenaltyGasCost(uint256,uint256,uint128,uint256,uint256) selector 0xfeaf513e: charges a 10% unused-execution-gas penalty after adjusting for preOp gas.
- In genuine SingletonPaymasterV7 source, the ERC20 token cost includes both penalty and configured postOpGas, plus the provider-defined constant fee. The optional preFundInToken is deducted from the postOp collection amount. Actual signed exchange rate, constant fee, gas limits, token and permitted bundler are UNKNOWN for an NQC UserOperation.
- README confirms permissioned service signatures and notes that bypassed ERC20 postOp payment may be charged against the user's Pimlico balance. This is **not nonrecourse** unless independently contracted external underwriting explicitly excludes invoices, negative balances, user collateral and failed-gas recourse.

Use separately operated dRPC and BlastAPI only to read actual deployed bytecode and make exactly 8 historical eth_call read-only ABI calls **per provider** (4 paired penalty and token-cost observations) with exact block/hash/state-root consensus. Reject mismatched math, code hash, ABI words and operator pseudodiversity.

## Four stress inputs are hypothetical, NOT live quotes

Take the illustrative historic TEST postOp input gas cost 1,640,905,234,415,104 wei and TEST gas price 2,059,451,728 wei/gas. Use exchangeRate=1e18 only as a 1 WETH : 1 ETH modeling convention. Compare postOpGas 0/100k/200k/300k, preOp approximation 0/450k/450k/450k and execution caps 0/900k/2M/2.4M. Any nonzero provider constant fee and real signed quote would change the answer. These outputs are not transaction prices or allowed provider capital.

## Strict boundary

Even if the deployed code returns exactly the source-defined math, it does not confirm authorization by a legitimate provider signer, availability of its ETH deposit for Nexus, permission to collect newly earned WETH at postOp, ability to capture a third-party historical liquidation, or a nonrecourse underwriting agreement covering failed gas. The original NQC external-provider registry remains EMPTY. RMC011 terminal=false; RMC017 final Census=false; operator OWN_CAPITAL=0 eligibility NOT proven.

No wallet, account, credit card, subscription, keys, mainnet transactions, actual provider gas use, new production deployment, paid provider access, changes to main or self-certification is permitted by this experiment.
