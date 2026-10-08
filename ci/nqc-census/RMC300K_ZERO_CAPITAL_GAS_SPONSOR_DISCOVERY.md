# RMC-300K Gas-Funding Discovery — Zero Own Capital, Source Assessment Only

Status: DISCOVERY_ONLY_NOT_AUTHORIZED_OR_CONFIGURED. This document does not add an external provider to the RMC011 authorized registry, nor enable transaction execution. Current exact RMC011 provider registry Git blob a9c1427bb05828d08ade537899ee1b8e43b97ed2 contains provider_count=0; it explicitly says this is NOT proof that external sponsors do not exist elsewhere.

## Critical EVM execution distinction

ERC-4337 allows an independently funded Paymaster to pay transaction execution gas for a smart-account UserOperation. Ethereum EIP-4337 EntryPoint requires that the Paymaster has sufficient ETH deposited, and validation/paymaster approval succeeds, before executing the user operation. Source: https://eips.ethereum.org/EIPS/eip-4337 and https://docs.erc4337.io/paymasters/index.html .

This removes the smart account's *immediate* native gas requirement but does NOT make gas free. A third party must commit ETH or financing and assume the economic/failed-execution exposure. A token-paying paymaster mode changes currency and repayment timing; it does not automatically satisfy zero NQC own capital if NQC must pre-fund, deposit, approve or guarantee a bill.

## Candidate sponsor/service routes — NOT ADMITTED

| Family | Public documented mechanism | Non-admission reason |
|---|---|---|
| ERC-4337 externally capitalized Paymaster | Sponsor signs/validates UserOperation and pays from third-party-funded EntryPoint deposit | No identified independent authorized depositor, gas budget, exact execution permission, economic reimbursement agreement or quote. |
| Alchemy Gas Manager | Gas Manager may front sponsored EVM user operations and add gas cost to an account's monthly bill. Sponsored actions require an active policy. Mainnet requires PAYG/Enterprise; PAYG base limit is listed as USD0/mo pending custom limits, with an 8% gas fee under current docs. | Mere product support is NOT a granted external credit facility. Billing to NQC, if guaranteed or uncollectible, creates operator liability/capital risk; no approved NQC sponsorship policy, limits or loss allocation evidenced. |
| Pimlico Verifying Paymaster | ERC-4337 sponsorship through project-loaded offchain balance; product documentation also describes postpaid gas charging with a surcharge. | If NQC must load balances or fund/guarantee billing, fails strict zero operator capital absent a bona fide independent external underwriter. No registered NQC gas source. |
| Biconomy Sponsorship Paymaster | Paymaster removes end-user native gas need while the sponsoring application covers gas; also offers token-paying gas mode. | Application-funded sponsorship does not become third-party-financed NQC gas merely by using the API. External source/risk authorization not evidenced. |
| Sponsored Flashbots bundle | Bundler includes a sponsor-financing EOA transaction plus target EOA transaction. EIP-1559 base fees remain payable, funded by sponsor ETH. | Source examples explicitly require a funded sponsor private key; not zero-capital unless an independent underwriter provides and guarantees the funding. No source authorized. |

Sources reviewed:
- https://www.alchemy.com/docs/wallets/low-level-infra/gas-manager/gas-sponsorship/using-sdk/basic-gas-sponsorship
- https://www.alchemy.com/docs/wallets/reference/gas-manager-faqs
- https://www.alchemy.com/docs/wallets/transactions/sponsor-gas/sponsorship-policy-management
- https://docs.pimlico.io/guides/getting-started
- https://www.pimlico.io/
- https://account-abstraction-docs.biconomy.io/smartAccountsV2/paymaster/
- https://github.com/flashbots/searcher-sponsored-tx

These are publicly documented *technical possibilities*, not verified third-party commitments. Public pricing/terms may change. Neither protocol feasibility nor API availability is authorization to spend someone else's money.

## Admission for NQC

For any candidate to count as GAS_FUNDING feasible:
1. Independent provider identity, exact deployed Paymaster/EntryPoint/chain ID, funded sponsor account and spend ceilings at canonical block; no NQC-owned deposit, gas seed, token inventory, or risk guarantee.
2. Signed contractual agreement or verifiable permissionless protocol policy proving provider bears pre-execution gas exposure and failure/revert costs, including who ultimately repays, rates, caps and suspension triggers.
3. Exact NQC-compatible smart account/code path for flash-funded Aave liquidation, approvals, repayment in one atomic execution. ERC-4337 UserOperation is a different execution/inclusion path than existing direct-EOA Anvil fixture, requiring fork parity and new gas profile.
4. Reproducible quote/approval for the exact chain, calldata, gas estimate, target transaction and temporal anchor; independently verified denial conditions.
5. Gas funding and principal sources are separate; both need same-block feasible capacity, compatible repayment and exact worst-case loss accounting.
6. Capture/inclusion under builder competition and P90 tail gas remain empirical, not inferred from a single sponsored UserOperation.
7. Only a separately authenticated RMC011 external-provider admission may change provider_count=0; this document and baseline TARGET gate cannot do so.

Until each step has evidence: status EXTERNAL_GAS_SPONSOR_DISCOVERED_NOT_ADMITTED, external provider authorized = FALSE, OWN_CAPITAL_ZERO_EXECUTION_FEASIBLE = UNPROVEN, monthly net USD300K = UNPROVEN.
