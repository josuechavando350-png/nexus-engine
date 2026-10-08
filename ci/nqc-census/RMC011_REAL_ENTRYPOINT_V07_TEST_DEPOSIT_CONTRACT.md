# RMC-011 — Real ERC-4337 EntryPoint v0.7, with TEST-funded gas

This is an actual deployed EntryPoint v0.7 and Aave V3 historical Ethereum fork integration. It is NOT a real independent paymaster or financing commitment, nor a production UserOperation, real money, live trading or NQC net profit.

## Real components and source authority

- Genuine eth-infinitism EntryPoint v0.7 at Ethereum address 0x0000000071727De22E5E9d8BAf0edAc6f37da032, officially documented at https://github.com/eth-infinitism/account-abstraction/releases/tag/v0.7.0, with actual historical deployed code/storage.
- Real Ethereum Aave V3 Pool and WETH9, on real predecessor fork block 25938047, original source-authenticated borrower/timestamps, advancing ONLY the block clock to the original winner block 25938048.
- Original T36 real Aave flash coordinator source unmodified: Git blob aa3883fa141aa096006e90e56d8d4150c9ee14ef, canonical formatted SHA256 bbb5962171f2c1da5067e21ac705a627a35028fdafe5c9403f601bb813d39320.
- Successful prior historical real-fork flash+liquidation WETH profit before gas 90814117763741536 wei; original source PR #637, run 37741109591, artifact 11534051574 SHA256 9af974b4f87a68ef9e9dcf932e146b2440f197939b8bd75a7e993755b06c8bf1. Prior independent clock proof PR #636, run 37740704145 artifact 11533288894 SHA256 7d813c6cad278a5044d1c4ce57492efb07c5c0d73d69481769f92a4cc4151185.

## Why the gas financing is STILL UNPROVEN

The new contract contains a test-only v0.7 IAccount with test-key signatures and an unaudited test-only IPaymaster, but routes their UserOperation through the actual canonical onchain EntryPoint handleOps. To fund the paymaster deposit in this fork, it explicitly calls Foundry vm.deal and transfers TEST-MINTED ETH to EntryPoint.depositTo(paymaster). The test bundler's ETH is also fixture-created. Neither is third-party-owned economic capital or a licensed/committed provider; the actual NQC sponsor registry remains EMPTY.

The successful-case onchain UserOperation calls the genuine flash and liquidation route, returns the WETH surplus to the userOp.sender contract operator, and genuine EntryPoint invokes the test paymaster's actual postOp ABI. PostOp collects WETH from that account, calculates actual entrypoint-accounted gas, and clears token allowance. These are real EVM transitions in a fork but test-only account and sponsor semantics. Verification also checks genuine native ETH charged from the paymaster EntryPoint deposit and paid to the beneficiary.

## Actual v0.7 postOp economic counterexample — sponsor shortfall at 8% TEST markup

The initial historical handleOps fork confirmed that the original WETH liquidation and real postOp completed correctly, **but** the test paymaster's 8% markup over the actualGasCost provided to postOp failed to recover its **full native ETH EntryPoint deposit decrement**. The EntryPoint also charges gas attributable to postOp and other operation overhead *after* the cost input passed to postOp. Do not assume that 8% of postOp's observed actualGasCost equals 8% of all native gas charged. Keep the fee at the original 8% TEST assumption; measure and report the **difference as sponsor under-recovery** at ETH/WETH par. A separate test must still verify a reverted UserOperation burns the test sponsor's ETH with zero WETH reimbursement. This is a counterfactual technical finding, **not** an actual Alchemy/Pimlico price quote or a production provider financial loss.


Negative cases: unfunded paymaster cannot execute; incorrect signer fails; reverted application operation STILL burns real EntryPoint deposit ETH in the fork while receiving no WETH repayment; no role/access shortcuts. This last negative case exposes why a nonrecourse sponsor agreement covering failed gas is indispensable.

## Strict nonclaims

Passing tests does not establish audited production smart-account security; ERC7562 bundler mempool/stake policy admission; deployed production account, paymaster or relay; operation-specific third-party authorization; own-capital-zero in a production transaction; funded external native ETH balance; commercially accepted revert liability; competitive capture; complete gas or builder fees; monthly capacity; realized P&L; or RMC017 final certificate.

The result must explicitly declare test_only_paymaster_and_account=true, foundry_fixture_native_gas_deposit=true, and real_external_gas_sponsor_authorized=false. No user funds, private wallets, keys, signed live orders, billing accounts, paid resources, main changes or trades are introduced. This is a strictly isolated test branch with immutable source evidence.
