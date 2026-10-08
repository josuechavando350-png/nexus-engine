# RMC-015 / Sovereign Intelligence — Causal Borrow-event cohort, next-block holdout

**This is an actual archive-RPC evidence experiment, not a fully ex-ante research win, not a Census completion certificate, not a live trading strategy and not a revenue forecast.**

## Why this experiment matters

Previous original historical top-three Aave WETH/WETH liquidation work (PRs #633–#637) deliberately selected borrowers using **future competitor liquidation receipts**. Rank-one previous-block health factor was 1.000000001993818630 and turned below one in a real Aave V3 **time-only fork** as the timestamp advanced. That proves a narrow **possibility of crossing**, not that NQC knew which borrower to monitor before the future liquidation.

The evidence chain cannot promote a hindsight-selected target to a prediction. This experiment removes **all future winner borrower addresses and transaction IDs from the discovery function**.

## Actual source and scope

- Mainnet Ethereum chain 1, original Aave V3 Pool **0x87870Bca3FfD6335C3f4cE8392D69350b4fa4e2**, exact predecessor **block 25,938,047**, block hash **0x42cf44b75185587327a1aa8fc859cc5f49a639e7256547511430d6068b6f09ab**.
- Enumerate **all canonical Aave Borrow events in the previous 100 blocks**, in independent 10-block chunks, using historical logs alone. Decode actual borrower as **onBehalfOf**, not the transaction sender or borrow initiator. Source event topic is the standard Aave V3 Borrow event.
- Recover the unique canonical cohort from those Borrow events, without any reference to a subsequent liquidation transaction. Require the full bounded cohort or **fail rather than cherry-pick/truncate**.
- For every cohort borrower, query the **actual historical mainnet Aave Pool getUserAccountData** with eth_call pinned at block 25,938,047; integer HF in WAD. Document active debt, already below 1, HF 1..1.01, and HF 1..1.000001, with no claimed ability to capture a future event from this feature alone.
- **Two independently operated Ethereum RPCs** (dRPC and BlastAPI) must agree on exact cutoff hash, parent/state root, complete event list/commitment, borrower cohort and risk observations.
- Compute immutable feature SHA-256 *before issuing any query* about next block 25,938,048. Hard-coded detection RPC fence prohibits receipts, future block headers, next-block logs, unrestricted lookback and later-block state calls in feature stage.
- **Only after both feature witnesses agree and freeze**, query the exact historical successor block/hash and LiquidationCall labels. The same two independent RPCs must agree on the revealed next-block liquidation list and identities.
- The report explicitly counts found/missed borrowers, rather than attributing every historical winning transaction to NQC. An observed eligible borrower is not a guaranteed profitable flash liquidation, and a matching next-block liquidation is never recorded as captured income.
- The historical successor block was deliberately chosen by the researcher *because we know it has an important liquidation*; consequently this remains a **retrospective holdout demonstration with decision-time feature separation**, not unbiased out-of-sample operational validation. More windows, including randomly precommitted nonwinner windows and later live observations, are needed.

## Against well-capitalized/searcher/builder-connected competitors

1. **Information-time arbitrage**, not a promise of lower hardware latency: systematically monitor risk transitions in the entire genuine borrower population, prioritizing near-HF-1 time/index crossings and externally observable oracle changes. A borrower indexed through a recent Borrow event is merely a limited initial test; large historical active borrowers may be MISSED.
2. **Negative selection is valuable:** quantify risk episodes and positive net EV after flash principal+fee, native gas (who pays!), routing/MEV and competition. Refuse high-gross opportunities if inclusion cost destroys EV.
3. **Builder diversity where economically supported**: instrument public/private inclusion options and empirically test them before paying for multiregion infrastructure. Do not claim access to private flow or privileged builder placements.
4. **Nonrecourse funding** is a separate, essential commercial admission: external gas providers currently authorized for NQC **0**; an externally owned ERC4337 paymaster deposit is NOT available NQC gas credit.
5. **Cross-market long-tail coverage** is a hypothesis requiring actual discovery/census denominator and latency competition experiments, NOT automatic superiority because many markets exist.

## Failure taxonomy and boundaries

- Zero cohort: report zero discovered borrowers, not zero global opportunities.
- Cohort misses a future liquidated borrower: explicitly count a negative recall result; expand historical events/borrower ledger only in a later independent experiment.
- Archive RPC absent/limited/biased, divergent block hash or incomplete log chunk: fail closed; no "PASS" and no false negative claims.
- Opponent wins a future liquidation: historical **third-party** success, not NQC P&L.
- No authenticated sponsor/nonrecourse financing: zero certified NQC income, regardless of gross oracle edge or successful retrospective fork.
- No ex-ante calibrated win probability: capture adjusted capacity remains uncalibrated; original Census RMC-011 through RMC-017 terminal requirements remain unresolved.

The current NQC code branch is a pull-request-only experimental branch. No main branch modifications, real trades, keys, accounts, deposits, provider payments, native gas sponsorship or user financial exposure. CI creates cryptographically hashed append-only artifacts from **real read-only mainnet queries** plus adversarial offline tests. No claim of $15k/$55k monthly profitability is permitted without real inclusive execution and statistics.
