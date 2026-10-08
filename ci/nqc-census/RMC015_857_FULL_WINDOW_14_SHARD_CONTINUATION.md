# RMC-015 — Complete historical 7,200-block *executed liquidation event* audit of 857 fixed borrowers

## Exact research claim, and what is not being claimed

The original full-historical Aave D08/D09 read-only archives at Ethereum mainnet block **26,095,351** generated an immutable **857-account fixed healthy material-borrower cohort** before any later event was considered. [PR #647](https://github.com/josuechavando350-png/nexus-engine/pull/647) established the cohort's real subsequent endpoint health for all 857 accounts via independent dual-RPC Multicall. Endpoint health does **not** rule out intermediate temporary liquidations.

[PR #648](https://github.com/josuechavando350-png/nexus-engine/pull/648) correctly failed its 7,200-block monolithic read-only historical LiquidationCall scan on Blockscout HTTP 429. [PR #650](https://github.com/josuechavando350-png/nexus-engine/pull/650), SHA `c2d84ff6486202eb2a5810852e21e89b3ab5e2c5`, proved exactly the **FIRST 480 blocks** ([26,095,352, 26,095,831]) with independent real dRPC/BlastAPI mainnet agreement: **zero observed Aave LiquidationCall events** in that first shard. Dedicated workflow run **37807155179** SUCCESS, artifact **11562554317**, exact ZIP SHA256 **f431bc64770be49ebeee5d48a40f8013592c3a4f1c25fd3abbd4c43f6c66c9f3**. That did not certify the other 6,720 blocks.

This PR authenticates the original exact PR #650 run/head/artifact/digest and inner SHA manifest, reproduces the exact source 857-account D08/D09 preselection **without ever selecting later winning accounts**, then processes the **remaining fourteen predetermined consecutive nonoverlapping 480-block shards**. It outputs a combined full event-window certificate only if both genuinely independent Ethereum archive RPC operators agree on all fourteen successor shards and exact contiguous Ethereum canonical header ancestry, with all checkpoints preserved cryptographically.

## Technical invariants

1. Source immutable archives: D08 SHA256 `9431ea07144ae78e68e0ffcc7f650fa32068ee63fb53ca41ff8a062b87845913`, D09 SHA256 `9aa6a4beb3ebc90f40d07d1889f84c1bcf94b3dea90b0e7b596dc6ff70fda0f6`; their original GitHub workflow run/commit/artifact independently reauthenticated and source selector original Git blob `5542bbec0840335994cbbab272e6228756ba6eb0`.
2. Original first-shard PR #650 report SHA256 is independently recomputed from canonical report body. Accepts exclusively 480 blocks, 857 original source cohort, zero observed events plus correct SHA of empty event stream, original `rmc015_terminal_authority_closed=false`, provider source admissions, source watched accounts commitment and signed-zero-realized-PnL nonclaim.
3. For each subsequent shard `i=1..14`: exact `START=26095352+480*i`, `END=START+479`. Both RPCs verify original D09 anchor, historical prior/shard-first/shard-last headers, their temporal monotonicity, exact predecessor hash chain and matches to previous verified shard ending hash. All raw `LiquidationCall` events must have correct Aave Pool address, canonical ABI, positive amounts, event block hash/parent header, no reorg removed logs, no duplicate transaction+log-index.
4. Both **dRPC and BlastAPI use exactly <=10-block** historical `eth_getLogs` partitions (48 per operator per 480-block shard), to avoid the public free-tier restrictions actually observed. dRPC returned `ranges over 10000 blocks are not supported on free plan` even for a historical 480-block request on the first continuation shard (original failing CI run 37809176661); this is a provider error, NOT evidence of empty logs. BlastAPI separately documented/enforced a 10-block historical range cap. Each operator must return the complete same canonical set; **no paid API keys, services or subscriptions**. Operator identity and actual endpoint must differ. Any failure prevents a full-window certificate; no substitution or one-operator-only consensus.
5. Every shard is saved to `shard-XX.json` and SHA committed **only after** both providers agree exactly on the whole public event set, source-cohort matches, event hashes and canonical headers. Prior successful shard evidence remains available as limited-scope evidence even if later public API requests fail; no partial evidence can masquerade as full coverage.
6. If and only if all fourteen pass and authenticate the original first shard, the aggregate result may say 7,200 historical blocks' **publicly EXECUTED Aave LiquidationCall events have been observed**. It must NOT claim that all transiently eligible positions were liquidated, that an NQC strategy could see or win those events in real time, that there was no other profit, or that a 857-borrower cohort exhausts the Aave universe.
7. Source cohort private account list is not uploaded. Only aggregate event counts, cryptographic commitments and block bounds are published. Public event IDs stay local to the Action runner.

## Adversarial test plan

Negative tests cover first-source report forgery, SHA tamper, incorrect ERC20 source binding, missing borrower, 15-shard exact partitions, block reorg, dual-RPC disagreement, zero-window false extrapolation, injected valid/synthetic liquidation mismatches, duplicate observations, interruption at a later shard with earlier append-only checkpoints preserved, overlapping shard starts, fake gas provider and false future dollar predictions.

## Econ/Capital/Census boundary

- **Third-party historical events are NOT NQC revenue.** `NQC_realized_profit_usd="0"`.
- A complete 7,200-block historical *executed event ledger* does not establish undetected/profitable opportunities, inclusion odds, gas sponsorship, capital feasibility, execution economics or $15k / $55k monthly net reliability.
- NQC approved external gas financing remains **ZERO**. Historical outside paymaster ETH deposits do not grant NQC a credit line.
- RMC011, RMC012, RMC013, RMC014, RMC015 terminal temporal, RMC016 independent net capacity, and RMC017 final global Census certificates **remain open**. This PR does not change their source authority.
- No wallets, actual mainnet signed transactions, paid resources, production deployment, user funds, source asset trading or merge to `main`.

An independently verified **negative** market result is valuable because it reduces unsupported opportunities. This is how Census advances without being cosmetically closed.
