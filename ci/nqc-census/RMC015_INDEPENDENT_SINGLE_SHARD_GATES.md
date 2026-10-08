# RMC-015: independently recover one true 480-block Aave cohort outcome shard per run

**Goal**: create an honest, bounded, independently re-checkable unit of temporal evidence when a full 6,720-block public event-retrieval run exceeds free archive RPC quotas. One shard is **not** the complete temporal census.

## Source authority
- Original Aave V3 Ethereum D08/D09 archive owner-selected health cohort: 857 real accounts selected at canonical block 26095351, commit/blob/ZIP pinned in original PR #605; original immutable source selector Git blob SHA1 `5542bbec0840335994cbbab272e6228756ba6eb0`.
- Previously verified first 480 successor blocks [26095352, 26095831] in original [PR #650](https://github.com/josuechavando350-png/nexus-engine/pull/650), exact head `c2d84ff6486202eb2a5810852e21e89b3ab5e2c5`, workflow run `37807155179`, artifact `11562554317`, ZIP SHA256 `f431bc64770be49ebeee5d48a40f8013592c3a4f1c25fd3abbd4c43f6c66c9f3`, with zero actually EXECUTED public Aave V3 LiquidationCall events in that **bounded first** 480-block interval; no inference about unexecuted liquidatability or later blocks.
- Original continued source [PR #653](https://github.com/josuechavando350-png/nexus-engine/pull/653) exact head `9a2905e56f1efb7e6dcefc59c27bc09152a24add`: actual original PR #650 source operator ids **blast, blockscout**; 27 offline adversarial tests pass but full 14-shard historical CI failed from Blockscout rate limiting. The full-window success flag must remain false.
- Actual known positive liquidation canary outside the source cohort: Ethereum block `25938048`, source hash `0xf143f9988199037938e4dff57aaf24301a4c26770aefc0ec64774954cbf2dbe4`, historic unrelated competitor tx `0x6313fb267755f3cfa48214bf74309505984306129ee09a558efe4801006dcbba`; used **only** as positive RPC log capability check, never to select the 857 cohort or infer profit.

## Procedure for each individually selected shard

- Each shard `i in [1,14]` covers EXACT blocks `26095352+480i` through `26095352+480(i+1)-1`. First 480 remain immutable original source PR #650.
- Recover and authenticate the exact original two D08/D09 ZIP artifacts, source code blob hash and original PR #650 ZIP manifest in each independent run. Materialize the original 857 borrower identities only in private local runner state; upload **no watchlist**.
- Confirm two independent archive RPC operators are original source-observed BlastAPI and Blockscout, not newly manufactured substitutes.
- Prove a known positive historical Aave log event exists in both archives and their normalized representations agree. Canonically validate both providers' immediate predecessor block hash and state root before observing the shard.
- Inspect one shard using 48 × 10-block BlastAPI public log queries, one 480-block Blockscout log request (plus needed real canonical headers), validate actual source Aave ABI, all public events, event hash vs canonical header, no overlaps or duplicate event identities, and cross-operator full event-set equality.
- Retain only a SHA256 source-anchored **one-shard result**, actual public event count, exact 857 preselected-member intersection count, and immutable checksums. There is no artificial zero event on 429 or other RPC failure. Bounded same-operator Blockscout 429 retry already enforced by PR #653.
- After first + precisely one later shard are validated, the only truthful lower-level finding is 960/7200 blocks examined and **6240 blocks remain unverified by this report**. One shard cannot claim overall incidence or sum unique borrowers across other shards.

## Future independent aggregation, separate work

Repeat for the other shards, storing exact successful workflow head/run/artifact IDs, ZIP SHA256 and source report hashes. Construct an independent aggregator that downloads **all 14 individually successful immutable artifacts**, checks their exact source lineage, shard index uniqueness (1–14), adjacency by independently anchored canonical parent/end hashes, overlapping event identities, and consistency of the original 857 preselected source cohort. **Only then** may the narrow 7,200-block *executed-public-LiquidationCall incidence* subclaim be marked complete. This still cannot count unexecuted eligible positions, build an out-of-sample forecast, infer runner capture probability, or certify Census terminal closeout.

## Business/economic boundary

- Actual income realized by Nexus: **USD 0 verified**.
- Provider gas financing authorized under zero own capital: **0**.
- Estimated probability of capturing competitors' historical liquidation events: **UNKNOWN**.
- $15,000/$55,000 monthly net income reliability: **not certified**.
- Census D11, D12, D13, D14, D15, D16, D17 terminal authorities: **not closed by this shard**.
- No paid endpoints, accounts, secrets, mainnet broadcasts, wallets, infrastructure charges or modification to `main`.

This design shifts the unit of work from a huge repeatedly failing run to small, independently reviewable, reproducible historical evidence. It improves engineering throughput but does **not** prove profitability.
