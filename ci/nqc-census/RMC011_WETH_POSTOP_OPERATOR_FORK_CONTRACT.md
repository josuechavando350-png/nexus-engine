# RMC-011 — WETH liquidator operator and mock post-operation token settlement

**Scope:** Three read-only historical local Ethereum fork tests. This is NOT a working ERC-4337 EntryPoint, NOT an externally financed native ETH gas transaction, NOT NQC P&L and NOT a sponsor authorization.

## Why this bridge matters

The original T36 real Aave V3 flash/liquidation coordinator sends its positive WETH surplus to an **immutable operator**. An ERC-4337 paymaster collecting ERC20 reimbursement after a UserOperation needs the WETH and approval at the exact smart account represented by `UserOperation.sender`. The actual certified T36 executor does not itself supply an ERC-4337 smart-account interface, an EntryPoint deposit or paymaster validation.

This test uses a strictly labeled *test-only facade, test-only operator account and test-only token collector* to falsify incompatible WETH token flow, while keeping **actual original historical WETH, Aave V3 Pool, borrower, flashLoanSimple callback and liquidationCall contracts** from the source-authenticated [RMC016 original real fork PR #637](https://github.com/josuechavando350-png/nexus-engine/pull/637). The immutable T36 executor code is copied unchanged (raw Git blob `aa3883fa141aa096006e90e56d8d4150c9ee14ef`, formatted artifact SHA256 `bbb5962171f2c1da5067e21ac705a627a35028fdafe5c9403f601bb813d39320`).

The exact historical fork begins at Ethereum mainnet block **25938047**, then moves the clock/number only to block **25938048**, using original independently authenticated predecessor and winning block timestamps and borrower's address from [run 37740704145](https://github.com/josuechavando350-png/nexus-engine/actions/runs/37740704145), artifact **11533288894**, ZIP sha256 `7d813c6cad278a5044d1c4ce57492efb07c5c0d73d69481769f92a4cc4151185`. The original no-fee-subsidy real fork [run 37741109591](https://github.com/josuechavando350-png/nexus-engine/actions/runs/37741109591), artifact **11534051574**, ZIP sha256 `9af974b4f87a68ef9e9dcf932e146b2440f197939b8bd75a7e993755b06c8bf1`, returned exact **90814117763741536 WETH wei** after flash principal + real fee.

## Physical behavioral checks

1. A mock operator account is configured as the T36 executor's **immutable operator**. It starts with zero WETH. The test-only facade calls its authorized `executeAndApprove`; genuine T36 settles its WETH surplus to that account, not directly to the EOA test harness. An account-scoped allowance only to the mock paymaster collector permits a token pull **after** liquidation. Test verifies sponsor-token treasury delta, exact remaining account WETH, full WETH conservation and allowance revocation. The WETH charge is a **hypothetical** gas budget, **not a provider quote**, modeled from previous 562357 measured EVM gas, additional 21k intrinsic + 200k overhead and previous block-sourced winner basefee + hypothetical 5 gwei tip.
2. An excessively high mock post-operation charge must revert the entire **local facade transaction** without mutating the borrower's health factor, T36 execution identity, smart-account balance or paymaster treasury. Actual ERC-4337 EntryPoint failure accounting differs; this demonstrates only the fixture's atomicity, not what a real paymaster owes after a reverting UserOperation.
3. Arbitrary callers cannot trigger the mock account liquidation or collect tokens directly from the mock paymaster. Only the fixture facade is authorized.

No vm.deal, erc20 deal, impersonated provider, native gas deposit, private key, broadcast or actual sponsor is used by this test. The positive transfer of WETH after liquidation proves only that an appropriately configured **operator account could receive and approve the asset**. The mock does not implement validateUserOp, validatePaymasterUserOp, postOp, real EntryPoint v0.7/v0.8, UserOperation packed encoding, sponsor signature/expiry, paymaster deposit, calldata/verification/cleanup gas, failure liability or real bundler inclusion.

## Exact acceptance and nonclaims

The CI must reauthenticate both immutable historical prior source reports, run pinned Foundry 1.7.1, preserve deterministic SHA256 source/test evidence, require three real-chain fork tests PASS, retain the exact original gross WETH surplus, conserve modeled WETH charge, and assert all blocked flags:

- external_entrypoint_deposit_verified = false;
- paymaster_signed_quote_or_nonrecourse_agreement = false;
- real_erc4337_useroperation_executed = false;
- actual_useroperation_postop_or_failure_semantics_certified = false;
- executor_operator_approved_as_production_4337_account = false;
- operator_gas_funded_from_third_party_native_eth = false;
- full_end_to_end_competitor_capture_proven = false;
- nexus_realized_net_pnl_proven = false;
- rmc011_terminal_closed = false;
- real_market_census_closed = false.

Production use requires independent gas sponsor signed authority and funded EntryPoint deposit, a real smart account satisfying T36 operator binding, verified non-recourse gas/failure coverage and postOp settlement under the actual EntryPoint, then separate inclusion and economic certification. NQC authorized provider registry remains **empty**. No changes to main, no paid service, no wallets, no user funds or real transactions.
