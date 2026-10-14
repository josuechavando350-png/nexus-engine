# NQC V2 — Anvil pre-winner fork and cold EOA receipt (NO LIVE)

## Commercial uncertainty isolated

PR698 showed an actual historical Aave liquidation+flashLoanSimple+Uniswap fee-500 swap route with 2,273.989378 USDC surplus, BEFORE native gas. Its 1,115,038 gas was measured as internal gasleft() after harness setup: NOT a cold transaction receipt. PR720 established that the historical original competitor paid 2,740,350 receipt gasUsed, but this gas cannot stand in for NQC.

The next gate measures a locally mined EOA-to-NqcFlashFundingExecutor.execute transaction on an isolated Anvil fork, then extracts an authentic local **eth_getTransactionReceipt.gasUsed**. This is an improvement over internal-call gasleft, but remains a counterfactual historical local test, NOT a mainnet/competitive receipt or profit.

## Exact source authority

PR698: GitHub run 38498693805 SUCCESS, producer head 156e106c2efcd8bcb7f4931be3daa98309bd770b, artifact ID 11865385506, ZIP SHA256 6778f8e190d13c739331f731ca532d8607e3f653ca000de746b058b4903c7d7d. Validate the full archive/manifests, exact source PR698 selected USDC case and all public inputs.

Original competitor TX 0x08db2e5d5f4e627f9fb4d12a780aac26aed725fab36b70fb9647119872d74625, Ethereum block 26,142,067. Replay the history using Anvil transaction-hash fork BEFORE the competitor's execution. The exact six-word Aave borrower account prestate must equal the certified PR698 historical source BEFORE any local transactions occur. Reject if it differs, if the wrong oracle state is chosen, or if health factor >= 1.

Coordinator, harness and Foundry project config are kept BYTE IDENTICAL with the PR698 certified source. New script ONLY creates a local harness and coordinator, sets the harness callback authority and calls execute. It does not alter oracle code, borrow balance, capital sources, route amount or swap.

Foundry v1.7.1 is PINNED by release archive SHA256 cf7e688ed0c4c48adffca788b496076e31060b67ac5afe1e43dbb5499c20c88b (already used in original PR698 source). No unpinned Foundry installer.

## Mainnet write safety

- Anvil forks historical Ethereum via the public upstream https://eth.drpc.org as a READ source.
- The script and its ephemeral local sender can broadcast ONLY to the exact string http://127.0.0.1:18545. Other RPC URLs, aliases, paths, mainnet RPCs and raw transaction methods are rejected by the orchestration contract. This is the only intended EOA signing, using a random throwaway Anvil dev key generated during CI, NOT a user key.
- The throwaway EOA receives ONLY artificial ETH within Anvil via anvil_setBalance. Nothing is transferred on Ethereum. The local key is not preserved in logs or evidence.
- Four local EOA transactions must succeed: temporary strategy deployment, temporary coordinator deployment, strategy.setExecutor and the EOA-to-coordinator.execute route transaction. Independently re-read every transaction receipt from local Anvil RPC; require matching Foundry receipt, original EOA, exact expected 3 setup targets and final execute target.
- A successful final receipt must have status 1, route logs, and gasUsed exceeding the original internal gasleft delta. Report its receipt gasUsed and the three setup receipt gasUseds separately; setup deployments are NOT part of the cold execute receipt.
- A successful end-to-end run requires exact authenticated source prestate and a real LOCAL receipt. Any timeout, unavailable historical RPC, rate-limit, historical replay disagreement, revert or missing local receipt is INCOMPLETE and explicitly preserved, not replaced by 1.25M synthetic gas.
- The Anvil transaction may internally use the actual code of historical Aave and Uniswap, but local block timestamp/inclusion/state differ from production. A local receipt is not the gasConsumed of a live Ethereum EOA nor a guaranteed production fee.

## Commercial status / continuation

Original source is selected with retrospective knowledge of the winning competitor. No native funding commitment, builder agreement, pending-first-seen edge, competition-adjusted win probability, failed-bid costs, sponsor, or fully calibrated net P&L exists. Commercial 5.9 must NOT rise on a successful local-only receipt. Even a local positive surplus is not a captured NQC opportunity.

PFT CLOSED; RMC OPEN; Shadow P2 NOT CERTIFIED; LIVE unauthorized; operator OWN_CAPITAL=0 includes gas. User MXN2000 gas budget protected. NQC realized P&L USD0, no merge, paid deployment, mainnet broadcast, user wallet, private key, contracts or expenditures. Do not freeze unrelated research.

The next gate after a valid receipt is comparing verified local whole-transaction gasUsed with source-bound actual historical basefees and route economics, plus prospectively captured opportunity timing and independently validated nonrecourse gas funding. No shortcut to USD 5k/45k profitability is implied.
