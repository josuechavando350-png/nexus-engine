# NQC V2 — Full recent Borrow cohort + 12-block canonical HF trajectory (NO TRADE)

## Commercial relevance and exact upstream facts

PR714 authenticated a fresh, event-derived Aave V3 Borrow corpus over exactly 384 mainnet blocks (26,190,649–26,191,032). The dRPC/PublicNode source lists agreed exactly on 80 real Borrow logs and 57 distinct onBehalfOf borrowers. The first version selected only the 48 most recently borrowing addresses, of which 44 had debt, four had no debt, zero were HF<1, zero had HF between 1 and 1.02, six were between 1.02 and 1.10, and the closest debt-positive HF was 1.050503710703206275. Nine Borrow recipients were not risk-checked because of a code cap, NOT because they were safe. The PR714 source run 38571951106 succeeded; artifact 11897014452 SHA-256 99cbee2463f921e98bcd973b19f4df760fde5ceebdaeeb84352bff58cfe6fd58, 15/15 manifest members verified.

This is not an all-Aave-borrower census. Earlier borrowers can remain active even without recent Borrow logs.

## This PR's narrowly scoped changes

1. Increase the MAX_RECENT_ACCOUNTS deterministic selection bound from 48 to 64, remaining within the existing <=200 requests/provider budget for a maximum of 105 distinct event-bearing block headers. Only events received BEFORE a risk read can influence selection, never health factors or future liquidations.
2. Use the same selected current cohort at the exact canonical last block AND at block last-12. The second data point is a **historical blockHash-pinned state queried after selecting the recent cohort**. This is NOT two separate live-time observations, a predictive signal, a mempool first-seen timestamp, or a per-block scanner. The 12-block separation is an Ethereum block-height gap, not evidence of 144 seconds of competitive access.
3. Require complete, exact dRPC+PublicNode parity for the already observed Borrow corpus and current account states before seeking the earlier state. Then use each original Borrow recipient address in fixed order, EIP-1898 eth_call at earlier blockHash + requireCanonical, compare original six Aave ABI words, and recheck the current head hash to detect reorg.
4. For each account, report current/earlier debt and HF in exact raw integer units. If latest Borrow happened after earlier block, prohibit treating this as a comparable pre-existing debtor trend. If either point has zero debt or HF zero, mark incomparable. Else classify debt-active HF rising/falling/unchanged with **no causal attribution**: reserve indices, deposits, repayments, pricing/oracles and other operations are not independently reconciled.
5. Explicitly retain all omitted-source receivers when more than 64 distinct recipients exist in the fixed window; never claim complete all-current Aave universe. Incomplete/429/timeout/source mismatch is not a negative market census.
6. Source budgets: first stage at most 200 read-only RPC calls per provider; additional earlier 12-block pinned stage at most 70/provider and combined at most 270/provider. No RPC write method, key, EOA signature, native-gas expenditure, paid provider, deployment or trading.

## Falsifiable outcomes

- TWO_URL_SAME_COHORT_TWO_BLOCK_HORIZONS_HF_TRENDS_NOT_EXECUTABLE: both sources matched exact original cohort and exact earlier state. Gives only sampled historical HF trajectories, not opportunity arrival, price causality, execution, competitiveness or profit.
- INCOMPLETE_FRESH_BORROW_TRAJECTORY_NOT_MARKET_ABSENCE: missing/source-inconsistent data, wrong source cohort, truncated authority, gas sponsor assumptions, or any other blocker. Preserve prior independent source evidence without promoting its state statistics to dual-horizon proof.

No automatic Commercial score promotion. A candidate HF<1 only starts a separate fork/builder/capital-source shadow investigation. Accurate net EV still requires cold standalone full tx gas, route liquidity, atomic flash, builder/MEV inclusion, failed bid costs, and a documented nonrecourse gas sponsor satisfying OWN_CAPITAL=0. Realized NQC P&L USD0, RMC OPEN, P2 Shadow uncertified, LIVE unauthorized. No research frozen and no merge or server changes.

## Reproduction

Exact-head PR CI pins code commit/tree and runs all offline tests before any ephemeral public RPC work. Source and failure artifacts include the original 384-block cohort, two pinned account snapshots, RPC digests/errors, sha256sum manifest and test/lint logs. A green workflow only certifies that the bounded audit executed and its no-claims contract survived.
