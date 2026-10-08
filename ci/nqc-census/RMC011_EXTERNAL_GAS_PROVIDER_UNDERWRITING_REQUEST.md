# RMC-011 — External native-gas risk-underwriting request, NQC own-capital = 0

**Purpose:** A specific externally executable offer request grounded in NQC's historic real-Aave/real-EntryPoint fork evidence. This document has **NOT** been sent to any provider and is **NOT** a credit facility, signed paymaster authorization, quote, permission to use a provider's deposit, or evidence that NQC can earn income.

## Technical facts established

NQC executed a retrospective Ethereum mainnet fork using deployed Aave V3, WETH and real EntryPoint v0.7. The fork flash-borrowed 10.684013854557827871 WETH, returned principal and real Aave fee, and produced 0.090814117763741536 WETH before native gas and inclusion costs. It was selected with hindsight from a competing liquidator's historical win and is **not** an ex-ante captured Nexus opportunity.

Unmodified T36 executor has immutable `operator` and pays fresh WETH there. The source-bound v0.7 test smart account set that operator to UserOperation.sender, ran genuine handleOps, and successfully paid back WETH via a **test paymaster**. Both test paymaster and test bundler were explicitly financed using Foundry-minted native ETH, not NQC or an independent provider's production funds.

Measured in a 6-test onchain-code historical fork: with 8% service-fee TEST markup and no additional reserve, native ETH EntryPoint deposit gas exceeded postOp WETH collection. Adding a precommitted **0.0007 WETH TEST overhead reserve** covered **one successful** test UserOperation, with only **0.000279307969604874 ETH equivalent** extra returned to the test sponsor. A separate test-only **reverted** UserOperation debited **0.001903814842011584 ETH** from the test sponsor and recovered **zero WETH**. Conditional break-even across exactly these two selected TEST outcomes would require about **87.21% successful included operations** even before other sponsor operating costs. That is neither empirical probability nor provider contractual economics.

Read-only independent historic dRPC + BlastAPI Ethereum evidence [RMC011 external-paymaster run](https://github.com/josuechavando350-png/nexus-engine/actions/runs/37749111776) verifies a deployed contract whose Sourcify source is `SingletonPaymasterV7` at `0x777777777777AeC03fd955926DbF81597e66834C`. **Total native ETH in EntryPoint for that contract at Ethereum block 25938047 was 1.985656782898694497 ETH**. It is **third-party-owned historical aggregate inventory**. There is no source-verified quota/amount reserved for NQC, no NQC-specific signature, no verified present availability, no proof the deployment is operated by the current Pimlico commercial entity, and NO RIGHT TO SPEND those funds.

Pimlico's published original singleton design permits post-operation ERC20 token collection without an ERC20 prefund during validation, but requires paymaster service signatures and may expose the user's Pimlico balance for nonpayment; see https://github.com/pimlicolabs/singleton-paymaster and https://docs.pimlico.io/guides/getting-started . Do not confuse design permissiveness with guaranteed approval. Circle Paymaster's integration checks USDC balance before execution and is currently USDC-only; that is not the same as a WETH-only liquidation starting at zero inventory (https://www.circle.com/blog/how-to-integrate-circle-paymaster-to-enable-users-to-pay-gas-fees-with-their-usdc-balance). Alchemy token-gas fronting invoices its policy owner, and an NQC-billed invoice would violate nonrecourse financing (https://www.alchemy.com/docs/wallets/low-level-infra/gas-manager/gas-sponsorship/using-sdk/pay-gas-with-any-erc20-token).

## External underwriting requirements — all mandatory before NQC capital admission

The prospective **independent, legally identified** gas financer/paymaster/bundler must provide an authenticated source package proving:

1. **No own capital or recourse.** No ETH/fiat/token collateral, subscription, prepaid account, card-on-file, monthly invoice, deposit or personal/operator guarantee funded or payable by NQC's user/operator. The provider explicitly assumes native ETH loss, including operations that revert, fail token postOp or are invalidated, without recourse. If this is not offered, reject zero-capital eligibility even if an ERC20 mode exists.
2. **Concrete asset and action acceptance.** Ethereum chain ID 1, actual EntryPoint version/address, exact signed/replay-protected UserOperation for a documented liquidation account, source-compatible T36 operator and onchain Aave+WETH calldata, native fee and gas caps, maximum WETH charge and postOp receiver, actual WETH token address, no required WETH balance or allowance **before** executing (unless legally independent third-party-funded and guaranteed).
3. **Committed provider identity and gas.** Onchain paymaster code/runtime and signed service operator/authorizer identity, a nonexpired operation-specific signature or equivalent committed facility, independently read true third-party EntryPoint ETH deposit/bundler signer balance at a specific block, available reserved capacity **not consumed by other customers**, maximum per-operation/day, exclusivity and expiration.
4. **Failure responsibility.** A signed agreement allocates gas costs for successful, reverted, intentionally cancelled, replaced, non-included and postOp-failed transactions; specify whether any terms create contingent operator debts, offchain balances that can go negative, or future token clawbacks. Model operator risk of lost principal, tokens and gas to be exactly zero except optional success-only output share.
5. **Executable inclusion.** Correct ERC-4337 paymaster signature constraints, deployed audited smart account, actual bundler/EntryPoint version/stake/reputation policy, ERC-7562 simulation, mempool/private-flow acceptance, gas and tip bounds, explicit fallback on rejection, safe ex-ante opportunity/borrower state, authenticated onchain gas receipts, all emitted events, source-faithful WETH token fee settlement after actual execution.
6. **Economics and risk.** Signed fee formula (native gas, base/priority fees, paymaster verification and postOp, provider markup, minimum fees, idle reserves, cap buffers, failure loss borne by independent financer), exact quote nonce/policy ID, previous-principal flash settlement and complete token routing. NQC conservative expected capacity remains ZERO until observed ex-ante candidate success/capture probabilities and outside-sample liquidation P&L are separately certified.

Self-authored JSON, reused provider documentation, wallet UI's “gasless” label, an external contract with a positive EntryPoint deposit, an outdated Testnet success, or a quote missing provider authorization **NEVER** satisfies all requirements.

## Provider qualification statuses

| Candidate route | Public evidence | NQC execution status |
|---|---|---|
| Genuine Ethereum SingletonPaymasterV7 ERC20 mode | Deployed, code and historic provider-wide ETH deposit independently witnessed; postOp token mode documented | **NOT_ADMITTED**: no NQC-specific signed WETH quote, commercially authorized signer/owner, independent nonrecourse funding or failure-liability guarantee |
| Pimlico verifying paymaster | Prepaid offchain Pimlico customer balance | **NOT_ADMITTED**: needs independent third-party ownership/funding and explicit nonrecourse underwriter |
| Alchemy ERC20 gas invoice | Token postOp payment supported; owner invoiced | **NOT_ADMITTED** if user/operator owns the policy bill |
| Circle USDC Paymaster | Permissionless USDC gas on supported chains, balance/permit checked beforehand | **NOT_ADMITTED** for zero-token-inventory WETH-only cashflow without independent funds |
| Independent native ETH transaction signer/builder | Feasible architecture, no qualified NQC counterpart presently identified | **NOT_ADMITTED**: no signed guarantee, funded signer quota or provider-owned revert loss |

**No outreach has been sent**, no provider registration performed, no current quota received, no card/prepayment offered, no actual gas consumed. The official source NQC RMC011 provider registry remains `provider_count=0` and has not been modified. Do not claim RMC011/014/015/016/017 terminal closed, NQC financially executable, realized net profit, nor monthly income.

## Ready-to-send independent underwriter diligence questionnaire (no user secrets)

Subject: Ethereum ERC-4337 WETH post-operation gas financing for externally funded liquidation execution

We are validating a liquidation search/execution system on Ethereum using Aave V3 flash borrowing and ERC-4337 EntryPoint v0.7. A historical reproducible fork confirmed atomic WETH liquidation, flash repayment, and WETH proceeds to the smart-account operator; a separate real-EntryPoint fork demonstrated WETH postOp token fee collection and the ETH loss on failed UserOperations. These are not production trades or a financial performance promise.

Could you confirm in writing, for a **specific signed mainnet operation**, whether your organization can (a) provide native ETH EntryPoint paymaster/bundler funding from its OWN resources, (b) accept WETH obtained and approved DURING the same UserOperation instead of requiring prefunded WETH, (c) receive agreed success-only WETH reimbursement, (d) bear **all** failed/reverted gas and uncollected token fee losses with no NQC/operator deposit, credit balance, monthly bill, invoice, collateral or personal guarantee, and (e) document exact gas caps, fee/markup formula, policy/signature/expiry, permitted Aave WETH calldata, EntryPoint and bundler, per-operation commitment/quota and signer identity?

We would only evaluate a narrowly limited, auditably signed offer. We are not asking for unconditional funding, and no production deployment or live trade is authorized by this inquiry.
