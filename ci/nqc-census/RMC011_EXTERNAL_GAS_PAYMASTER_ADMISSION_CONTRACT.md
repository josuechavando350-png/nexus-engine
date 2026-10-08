# RMC-011 — Authentic third-party native gas and paymaster liability

**Status: RMC011_EXTERNAL_NATIVE_GAS_SPONSOR_NOT_ADMITTED_SOURCE_BOUND. Read-only diagnostic. No funds or provider account has been authorized.**

## Source-locked economic basis

- Original successful real-fork WETH/WETH liquidation: PR #637, 0.090814117763741536 WETH after repaying the Aave V3 flash principal and fee. Retrospective competitor source, no actual NQC trade.
- Physical EVM cross-contract execution call: 562,357 gas units; Ethereum historical winner-block base fee: 59,451,728 wei/gas (two independent RPCs). Neither is full production ERC-4337 UserOperation gas nor an ex-ante inclusion quote.
- Immutable report: [GitHub Actions 37742063251](https://github.com/josuechavando350-png/nexus-engine/actions/runs/37742063251), head 0d700182e776b8efc261e8e5c9ebcebdcbaf9d11, artifact 11533854519, ZIP SHA256 2f31b24005ac3050574d6669b904415d09a438648575cdcbdbbd2b5a4dcf40e9, inner report SHA256 83aaa0010fc409daa3a7abe19e2441ba0d085ec8fb5f3673ae8b44a735870909.
- RMC011 exact approved provider registry Git blob a9c1427bb05828d08ade537899ee1b8e43b97ed2: **zero authorized providers**. This is a head-specific status, NOT evidence that commercial third-party providers do not exist.
- Original certified T36 executor Git blob aa3883fa141aa096006e90e56d8d4150c9ee14ef: executes for its immutable operator and sends any WETH surplus to that operator. The fork operator was a test contract. An ERC-4337 smart account at UserOperation.sender does not automatically become that operator or receive its assets.

## True gas funding is not token-denominated bookkeeping

[ERC-4337](https://eips.ethereum.org/EIPS/eip-4337) requires an on-chain paymaster ETH deposit at EntryPoint, separate from stake. The paymaster may still bear actual native gas costs if a UserOperation or post-operation token collection fails. A positive WETH balance measured at the *end* of a simulated liquidation does NOT front transaction gas before execution.

[Alchemy's official ERC-20 gas guide](https://www.alchemy.com/docs/wallets/low-level-infra/gas-manager/gas-sponsorship/using-sdk/pay-gas-with-any-erc20-token) says the provider fronts native gas but charges the commercial policy owner on an invoice; WETH/ERC-20 payment requires a funded and approved smart account. On failure, an in-operation token approval reverts, potentially preventing postOp token collection while leaving the policy owner liable. [Alchemy's public Gas Manager FAQ](https://www.alchemy.com/docs/wallets/reference/gas-manager-faqs) lists 8% PAYG mainnet surcharge as of 2026-10-08, but that is not an NQC sponsorship quote. If the policy owner is NQC and is contractually liable for the gas invoice, the absence of an upfront gas payment is NOT proof of operator capital exposure = zero.

[Pimlico](https://docs.pimlico.io/) offers paymasters and token-denominated gas payment. Provider discovery is not provider authorization, an allowed liquidation policy or a committed native ETH deposit. Its [old ERC20 paymaster implementation](https://github.com/pimlicolabs/erc20-paymaster) is explicitly deprecated; no old code is promoted to production evidence.

## Four distinct pathways

1. Independently funded ERC-4337 paymaster: could front gas from an *external* EntryPoint deposit and charge WETH after operation. Still requires independent provider agreement, deposit/cap evidence, actual deployed smart-account operator and EntryPoint/paymaster versions, paymaster signature/quote, postOp transfer, funding and revert-loss liability terms. NO valid source exists in NQC's registry.
2. Independently funded transaction signer or builder: a separate economic actor signs/pays native ETH and is repaid on valid documented terms from successful collateral proceeds, while bearing failed-transaction loss. Submission via a private RPC alone does NOT fund gas.
3. Operator-invoiced ERC-20 Gas Manager: the provider can front ETH but an invoice to NQC constitutes ongoing operator liability. Not automatically compatible with OWN_CAPITAL=0.
4. Operator-funded EntryPoint paymaster deposit: operator capital. Not eligible.

The current Rust sponsor and credit adapters are separately Git-source-locked: gas_sponsor.rs blob 5a301f92850bd00594996cbf013d9e4f74867d62 and gas_credit.rs blob 090f23df1326a0e6feb6f3afbe2151278d3b9499. BOTH describe PRE_EXECUTION_NATIVE_GAS_TO_BORROWER_NO_OPERATOR_PREFUND_V1. An ERC-4337 paymaster paying EntryPoint from its own deposit is an economically different route. Do not forge the native-gas-delivery fact to force an old importer to accept that path; a separate authenticated paymaster model would be needed.

## Original 15 stress scenarios, no performance forecast

For each of the five signed original gas sensitivity rows, recompute integer WETH/ETH-par comparisons with hypothetical service fees of 0, 800 and 2,000 bps (not actual provider quotes). Show native wei that a **third party would have to advance**, hypothetical WETH reimbursement after operation, possible WETH remainder after gas and fee, and full native gas exposure in a reverting/no-token-collection UserOperation.

A positive hypothetical remainder never promotes the candidate to capital feasible because no authorized sponsor exists. This is not a 15-observation sample of actual gas quotes or capture probabilities.

## Conditions before any provider may be admitted

Require independently authenticated real sponsor identity and non-recourse terms covering *success and revert* gas, signed chain- and operation-specific quote with expiry, EntryPoint/paymaster account/runtime and funded ETH deposit or signer balance at the execution block, actual smart-account deployed code/nonces, adequate allowance or permit, T36 operator binding to the true smart account, verifiable WETH delivery to UserOperation.sender and successful postOp collection, all EntryPoint verification and postOp gas overhead, failed gas loss limits, block-pinned availability and competitor-inclusive delivery. A second source must validate these independently, and the capital ledger/terminal stages must be reauthenticated.

Zero capital includes native ETH **and any personal/operator invoice, deposit, collateral or persistent recourse obligation**. No private keys, sponsored userOps, wallets, account registrations, billing changes, paid infrastructure, deployment, live trade, source promotion, net P&L or RMC-017 terminal closure is authorized by this document.
