# RMC-015: immutable original real dual-operator archive quorum restoration

**Status:** historical read-only experiment only. All historical 7,200-block observed-event claims require a completely successful source-anchored test run. No revenue, supplier entitlement, capital or full Census certificate is implied by passing local tests.

## The actual original historical source (NOT the previous PR #651 hypothesis)

GitHub Actions [PR #650 run 37807155179](https://github.com/josuechavando350-png/nexus-engine/actions/runs/37807155179), original head `c2d84ff6486202eb2a5810852e21e89b3ab5e2c5`, artifact ID **11562554317** and immutable ZIP SHA256 `f431bc64770be49ebeee5d48a40f8013592c3a4f1c25fd3abbd4c43f6c66c9f3`, actually authenticated Ethereum Aave V3 Pool LiquidationCall logs for blocks **26095352–26095831**, after an independently constructed and fixed 857-borrower cohort at block 26095351.

The exact signed-less original JSON report's `observed_successful_public_rpc_operator_ids` is **[\"blast\", \"blockscout\"]**, NOT dRPC/BlastAPI and NOT BlastAPI/1RPC. The original first 480-block window yielded **zero observed public Aave liquidation events**, and 6,720 later blocks are UNKNOWN. The relevant historical archive RPC dRPC rejected logs under free-plan code 35 ("ranges over 10000 blocks are not supported"); the experimental Automata 1RPC alternative failed with HTTP 429. An unavailable provider is **not** evidence of empty opportunity flow or proof of unavailable funding.

## Corrective execution

- Preserve PR #651's immutable first-shard content-addressed evidence verification, original D08/D09 archives, original 857-source cohort, strict canonical block/hash/state root validation and positive known-liquidation canary block 25,938,048 from PR #633. The canary only verifies a provider can return a nonempty true historic event, not any NQC previous knowledge of a winner.
- Use **the exact two proven independent original providers** `blast` (BlastAPI) and `blockscout` (Blockscout). Fail the original-source gate if its original source report's provider IDs differ.
- BlastAPI's observed free historical block span is at most **10 blocks per eth_getLogs**. Blockscout previously returned a complete **480-block** archive log range. The two providers must agree on **all public logs**, not just matched 857-member borrower IDs.
- For intermittent Blockscout HTTP 429, perform a finite retry on the same exact URL, RPC method and range, with 2, 6, 15, 30-second backoffs. Do not switch the independent operator, do not repeat a successful partial result and do not convert an exception to an empty list.
- Real evidence must retain each contiguous 480-block source-anchored segment, double-operator match, full log digest, 857-matched log digest and original asset/integer ABI validation; a partially successful run cannot claim complete 7,200 blocks.

## Nonclaims

Historical *executed* liquidations are not all possible temporary HF<1 episodes; an event not in the fixed cohort is not evidence NQC saw it; even a matched original 857-member event cannot establish an actionable prestate, monetizable swap route, positive net value after fees, independent gas underwriting, known builder inclusion, or realized Nexus P&L.

NQC OWN_CAPITAL=0 remains a non-negotiable no-native-gas/no-operator-debt constraint. Authorized external sponsor count remains **zero**. RMC-011 through RMC-017 terminal authority locks stay open. No credentials, signed UserOps, payments, mainnet broadcasts, paid RPC services or source lock edits.

This is a corrective historical-evidence experiment, not authority to close Real Market Census. A full window with no source-member liquidations would be a genuine **negative outcome** for that bounded hypothesis, not a reason to invent favorable income numbers.
