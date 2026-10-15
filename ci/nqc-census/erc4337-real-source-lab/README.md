# NQC — Authentic ERC-4337 v0.7 paymaster gas accounting LOCAL test
Date: 2026-10-15. Local only; no public-chain transaction and NO real gas sponsor.

## Authority
Checkout original `eth-infinitism/account-abstraction@7af70c8993a6f42973f520ae0752386a5032abe7` (v0.7.0 release) with exact `EntryPoint.sol` Git blob `44501524df76c23eef6e60fda97dd9440fad01b7`, plus `OpenZeppelin/openzeppelin-contracts@dbb6104ce834628e473d2173bbc9d47f81a9eec3` (v5.0.2).
This test uses the actual official `PackedUserOperation`, `IAccount.validateUserOp`, `BasePaymaster.validatePaymasterUserOp`, `EntryPoint.handleOps` and deposit/nonce/gas accounting. ECDSA signs the genuine `getUserOpHash` locally with test-owned fake keys. The local account/paymaster implementations are research fixtures, not production audited.

## Precisely in scope
- One successful UserOperation executes target through actual EntryPoint v0.7, sponsor deposit decreases, beneficiary receives ETH, operator smart account holds ZERO native ETH and ZERO own EntryPoint deposit.
- One UserOperation whose target reverts is still charged by EntryPoint to sponsor deposit and advances nonce.
- An unfunded sponsor cannot cover a UserOperation.
- Invalid account signature cannot execute or debit sponsor.
- Direct execution by a non-EntryPoint caller is rejected.

## Out of scope (material blockers)
- Mock target is **NOT Morpho** and not a genuine liquidation; authentic Morpho source callback was validated in the separate `morpho-native-lab`, using a mocked ERC-4337 EntryPoint for sponsorship. These two proofs are not the same as a single end-to-end *real EntryPoint -> real Morpho* test.
- Official EntryPoint v0.7 is executed in local Forge EVM, NOT a fork at chain 4663. Robinhood deployed EntryPoint code exists, but deployed bytecode has not been matched to this checkout or simulated using a real bundler.
- Sponsor's native balance comes from Foundry `vm.deal`, not external financing. A production paymaster requires an actual deposit or billing counterparty; chargeback risk on failed operations exists and is measured.
- No onchain DEX quote, gas estimate on Robinhood, mempool/sequence ordering, profitable Morpho borrower or ability to pay gas out of USDG surplus after an atomic callback.
- No subscription purchase, gas use, signer, live transaction, scheduler or deployment; P&L NQC **USD 0**; economic validation **4/10 unchanged**.

## Decisive next gate
Combine authentic Morpho source and authentic EntryPoint 0.7 in **one execution state** using separately compiled Solidity versions or a pinned fork; simulate legitimate Robinhood payload and chain/L2 expiration properly, enforce paymaster/owner policy, then obtain one signed non-recourse underwriter willing to pay failed-transaction gas before LIVE.

Read-only verification: Robinhood RPC at block 89626392 returned 16035 byte runtime code at the v0.7 address, and Arbitrum `ArbSys(100).arbBlockNumber()` matched the RPC L2 block. Raw artifact is GitHub Actions 38825362707. That fact does not establish byte-identical EIP4337 v0.7 source nor sponsorship.

Sources:
- https://github.com/eth-infinitism/account-abstraction/releases/tag/v0.7.0
- https://eips.ethereum.org/EIPS/eip-4337
- https://docs.erc4337.io/paymasters/index.html
- https://docs.robinhood.com/chain/connecting/
