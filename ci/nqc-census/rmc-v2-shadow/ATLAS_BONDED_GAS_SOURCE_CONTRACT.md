# NQC V2 — ATLAS-CAPITAL-001: real deployed Atlas bond/gas requirements, no transactions

## The question that can change commercial feasibility
Ethereum SVR/MEV-Share NQC work reached PR739 with a source-level result `BLOCKED_NOT_A_PRODUCTION_SVR_BID_EXECUTOR`, principally because its EOA needs native gas escrow and a nonrecourse payer. Perhaps non-Ethereum Atlas SVR avoids the upfront native balance by letting the **Chainlink oracle** submit the final transaction. We MUST falsify the resulting *gasless-to-NQC* inference, not advertise a path because the oracle advances gas.

Official Chainlink [Atlas searcher guide](https://docs.chain.link/data-feeds/svr-feeds/searcher-onboarding-atlas) states:
- Atlas is the auction path on Base (8453), Arbitrum (42161), BNB Chain (56), and Monad; the network oracle submits the final atomic transaction.
- A searcher must bond native tokens under the **same address that signs the solver operation**, with applicable gas liability deducted from that bond, including solver-fault failures. Source recommends (NOT mandates as a universal minimum) **0.1 ETH on Base/Arbitrum** and **1 BNB on BNB Chain**.
- An account can enter only one auction per block, creating correlation/concurrency and collateral scaling requirements. On some networks duplicate parallel auctions must be serviced for full coverage; this is NOT free permission or proof of success.
- The `depositAndBond` sample snippet includes a hard-coded example Atlas address. **Do not mistake its sample address for the actual v1.6.4 deployed contract addresses**, which are found in the official contract-reference table.

## Source-truth witness
GitHub repository **FastLane-Labs/atlas**, exact commit `083dccd05a2c92e0e9cae90ac404504f741bc493`, contains:
- `src/contracts/helpers/Sorter.sol`, Git blob SHA-1 `517f0a39d0199091027702b29bcb697e04d0bcdb`: eligibility checks `ATLAS.balanceOfBonded(solverOp.from)` and rejects when bonded balance `< maxSolverCost`, which uses `solverOp.maxFeePerGas * (executionGas + calldataGas)` with a surcharge.
- `src/contracts/atlas/AtlETH.sol`, blob `9f868fced242a19d14917742398a6d5ebeee0a93`: `depositAndBond` issues bonded credit to **msg.sender**, not to an arbitrary beneficiary.
- `src/contracts/solver/SolverBase.sol`, blob `f23db0ddaaabd9d14be1150b531153bb9e4f2a1f`: native gas-liability reconciliation and separate bid payment paths. This code is not itself an onchain deployed bytecode-equivalence certification.

The workflow obtains exact commit-pinned GitHub upstream source bytes through public read-only GET, checks each original Git blob checksum using SHA-1 with Git object headers, and tests exact guard statements. It stores ONLY contract name, original Git blob identifiers, and statement fingerprints, not third-party Solidity code or private NQC strategy. Network access denial fails closed. No unpinned source or convenience fallback.

## Real Ethereum-compatible deployed contract evidence
At one fixed observed canonical height per chain, query TWO independently named public RPC URLs with a ≤11-call budget per source, ≤500 KB response and ≥0.3 sec pacing. ChainID, tip parity, exact same numbered header/hash/parent/stateRoot/timestamp, Atlas/DAppControl runtime byte-for-byte parity, bounded public view methods, and original header recheck are mandatory.

| Chain | Chain ID | Atlas v1.6.4 | DappControl v1.6.4 |
| --- | --- | --- | --- |
| Base | 8453 | `0x583dcFef0D240DC80753F0F0B26513feE27D9B77` | `0xa5E1a36938769cbd5a26f5e19D8FCB379f597c83` |
| Arbitrum | 42161 | `0x8ad1aE9D97C79aA68A0a151E83ff3942f68F86C1` | `0xe15BBa987C002ecc3586e81244517877D294d291` |
| BNB Chain | 56 | `0x21B7d28B882772A1Cfe633Daee6f42ebb95DeC4E` | `0x7D50b32444609A9B53BcF208c159C8d0d0767835` |

Allowed RPCs only: `eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getCode`, and fixed `eth_call` selectors `balanceOfBonded(address(0))`, `bondedTotalSupply()`, `getSolverGasLimit()` and `ESCROW_DURATION()`. `address(0)` is a **neutral interface test**, neither NQC's wallet nor a claim about user funding. Results are never treated as a zero-bond **live solver operation**. Check code hash and positive gas limit + withdrawal interval; no arbitrary reads, writes, subscriptions, signing, private sessions, bundles or gas. Providers that return HTTP 403/429, reject historical state, disagree, or rate-limit remain INCOMPLETE for that chain, not lack of a deployed contract.

The code-source static invariant is conditional on a **positive fee** and positive gas usage: a zero-bond sender fails source eligibility. The little lower-bound arithmetic intentionally omits actual Atlas surcharge; passing it is **not** full eligibility or source equivalence. A third-party native bond would still require matching signer authorization, correct nonrecourse risk contract, upfront deployment costs, bid liquidity, expiry, failures and economic payment terms.

## Inferences expressly prohibited
* **No claim** that these source snapshots prove deployed onchain runtime is byte-for-byte equal to the pinned source repository, or that governance cannot change deployed configurations.
* **No claim** that the recommended 0.1 ETH / 1 BNB are universal enforced minimums, or that the amount exactly equals `solverGasLimit * gasPrice`.
* **No claim** that a sponsor willing to post native ETH or BNB exists, that a credit/paymaster/flash loan can avoid the required bond, that Atlas yields actual NQC funded capital 0, that prior Ethereum P&L can transfer to L2, or that the network's bid/gas rules guarantee a profit.
* **No production deployment**, paid RPC, new hosting, onchain allowance, wallet, signature, bid, transaction, merge, token purchase, deposit or user reserve spend.

PFT CLOSED; RMC OPEN; Shadow P2 NOT CERTIFIED; CANARY/LIVE NOT AUTHORIZED; OWN_CAPITAL USD 0 INCLUDING GAS/CONTINGENCIES; NQC realized net P&L USD 0. Ratings **MUST respond** to new credible positive/negative evidence; retain 9.8/9.9/5.9/9.9 only until a fresh commercial finding justifies revision. Next genuine condition: written, verifiable external no-recourse bond+gas+failure payer terms plus a live prospective SVR winner/inclusion test with separate owner permission.
