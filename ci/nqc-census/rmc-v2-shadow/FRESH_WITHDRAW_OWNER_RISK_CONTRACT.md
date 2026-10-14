# NQC V2 — Fresh Aave Withdraw owner HF cohort, bounded dual-RPC post-event audit

## Concrete financial falsification question

The preceding PR715 broadened fresh Aave Borrow-event research to **all 58 observed recent debt recipients** (83 Borrow events over 384 blocks) in its second authenticated run, with 54 holding debt and zero HF<1 or within 2% of one. On a separate same-cohort historical 12-block backfill, 51 borrower HF comparisons were valid, 47 fell slightly, 4 rose; interest/index, oracle, collateral and intervening debt actions were **not attributed**. No captured liquidations or real profits.

Borrowing is not the only action that can reduce Aave Health Factor. Withdrawing assets may decrease effective collateral, if those assets were enabled as collateral, and can leave HF near one. This PR examines **Aave V3 Withdraw owners**, not recipients or preselected liquidation winners.

## Canonical source definition

Aave V3 origin IPool.sol declares exactly:
Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)

Canonical indexed topic0:
0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7

Verified positive Ethereum Aave V3 Pool transaction receipt with this topic:
https://etherscan.io/tx/0x083e06ac8a2ae1abe085bcfd1cf7f869984e3119fc13e56994430c5aafd5a17b
(Other real canonical receipts also exist.) Aave source:
https://github.com/aave-dao/aave-v3-origin/blob/main/src/contracts/interfaces/IPool.sol

The **indexed user at topic[2] is the asset owner whose Aave getUserAccountData matters**. Topic[3] is the destination and may be an entirely different address. The event has exactly ONE unindexed uint256 amount word. It does not itself certify whether the asset was user collateral, HF went down, or debt was present.

## Bounded reproducible actual state observation

- Read chain ID=1 and current heads from public dRPC and PublicNode. Reject unavailable tips or >12-height drift. Pin the lower tip minus 3 confirmations; select exactly 384 contiguous Ethereum blocks.
- Query only Aave V3 Ethereum Pool contract 0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2 and the Withdraw topic above. Split into exactly sixteen <=24-block disjoint eth_getLogs shards on each provider. No silent unapproved RPC fallback.
- Validate 4 event topics, indexed address ABI, nonzero amount, correct tx/block/hash/index, nonremoved log. Bind every event-bearing block hash to a canonical numbered header, require no duplicates and re-check both boundary headers.
- Require up to two original successful transaction receipt positive-controls per provider, with exact event identity, log index, full receipt gas used and paid price. **These receipts are from original users, not NQC transactions**.
- Only AFTER event source parity, select up to 64 most recent distinct withdrawing **owners**, not asset recipients. Track any owners omitted when >64 distinct users exist.
- Query exact Aave getUserAccountData for all selected owners on the pinned blockHash (EIP-1898 requireCanonical=true), read six exact ABI uint256 values with verified thresholds/LTV, and require byte-equivalent state + canonical block parity between dRPC and PublicNode. Same-block HF bins: 0<HF<1, 1–1.005, 1.005–1.02, 1.02–1.10, higher, zero HF with debt, or no debt.
- Limits: <=200 read-only RPC calls per provider, <=320 log events, <=105 event-bearing block headers, <=64 owners, <=2 receipt controls, 4 MiB max RPC response. Stop on provider rate limits; preserve error/partial source. Public URLs may share backend operators.

## Results contract

DUAL_RPC_RECENT_WITHDRAW_OWNERS_RISK_ONLY_NOT_P2:
Both providers independently returned **matching source bytes and post-inclusion Aave account risk for the selected fixed cohort**. This is not a market completeness certificate, a pre-inclusion trigger, or an opportunity ready for atomic liquidation.

ZERO_WITHDRAW_EVENTS_ONLY_THIS_384_BLOCK_WINDOW:
Both providers authenticated zero specific Withdraw events within this exact bounded interval; not absence outside it.

INCOMPLETE_WITHDRAW_COHORT_NOT_MARKET_ABSENCE:
Any provider disagreement, rate limit, malformed ABI, receipt, missing account state, excessive window/cost, or uncertain header. Numbers are null, not zero.

## Economic and safety boundary

To promote HF<1 to a real profitable opportunity requires next-stage source-verified reserve/configuration/close factor, current user collateral/debt, liquidator route and exact DEX state, real cold transaction gas, native gas external nonrecourse sponsorship, competition/builder inclusion, failed bids, time-to-first competitor, and portfolio conflict accounting. This PR does **not** prove any of them.

No live transacting, signing, wallet, fee, new droplet, deployment, contract or paid provider. User OWN_CAPITAL=0 USD includes native gas. No research front frozen. PFT CLOSED; RMC OPEN, Shadow P2 NOT CERTIFIED, Canary LIVE unauthorized; Commercial 5.9 unchanged; NQC realized P&L USD0. All results are evidence, not automatic upgrades.
