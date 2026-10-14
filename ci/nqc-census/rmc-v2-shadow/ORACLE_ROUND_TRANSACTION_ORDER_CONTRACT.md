# NQC V2 — Authenticated primary/secondary ETH/USD oracle round transaction order

## Why it matters
Correcting the source families in PR #707 revealed **two primary NewTransmission and two secondary SecondaryRoundIdUpdated events** in a preselected 720-block Ethereum window, with 4 distinct transactions and paired round IDs. dRPC completed all 46 exact-topic shards and verified block hashes. BlastAPI failed with HTTP 400 on its first eth_getLogs shard. PR #707 artifact 11873335555, ZIP SHA-256 d3d43c38a0e54f6659957da4159daf0625a05dd934b2c3bd357f10d46456058b.

The key unanswered question: did each primary report precede the secondary synchronization in a **different block** or in a different transaction of the **same block**? Source logs alone did not record transactionIndex. Without that proof we cannot even describe the exact intra-block ordering, much less claim a preinclusion actionable signal.

## Authenticated chain-of-custody and RPC scope

1. Download producer PR #707 ZIP from run 38518805299 and exact artifact ID 11873335555. Require byte-exact SHA-256, 16/16 member digests, commit b4c553e244eb3ac0401e2db96959938502a6935b, and source status SINGLE_SOURCE_DUAL_FAMILY_DESCRIPTIVE_ONLY. Do NOT promote the failed Blast eth_getLogs into a two-source census.
2. Bind strictly to exactly the 4 discovered event hashes and their immutable source log index, topic, round ID, block hash, block number, source data hash, report answer if primary and block timestamp. Group by indexed Chainlink uint32 round ID; require each observed round uniquely pairs one NewTransmission with one SecondaryRoundIdUpdated event.
3. Read only eth_chainId, eth_getBlockByNumber for those exact three event-bearing heights, and eth_getTransactionReceipt for those exact 4 hashes. On dRPC and BlastAPI; no arbitrary other RPC calls. Validate each emitter/topic/index/data against the original log from its receipt, and each receipt against current canonical block headers. Require transaction status SUCCESS and nonzero measured receipt gas; re-check exact headers to reject reorgs.
4. Report primary and secondary receipt transaction indices, block delta, timestamp delta and descriptive order by round. A next-block secondary update implies prior *on-chain* primary data existed; NOT that the pending transaction was visible to our bot before submission and NOT a right to insert transactions in between.
5. Fail closed on unsupported RPC, receipt/header/source drift, provider disagreements, duplicate round, or missing event; preserve every byte with exact-head GitHub Actions evidence. The source's provider-time latency is not measured here.

## Output classification

TWO_ENDPOINT_ORACLE_ROUND_ORDER_RECONCILED_NO_CAPTURE: both RPC URLs agree on the exact receipt ordering for 4 source transactions. Not independent backend operators and not financial/competitive permission.

SINGLE_ENDPOINT_ROUND_ORDER_DESCRIPTIVE_ONLY: dRPC receipts validate but Blast not available.

MISMATCH_ORACLE_RECEIPT_ORDER_NO_AUTHORITY: both complete but incompatible.

INCOMPLETE_ORACLE_ROUND_TRANSACTION_ORDER: source/receipt/header identity failure.

## Commercial limitations

A paired round is **not** an Aave Health Factor crossing or liquidation signal. Even a full confirmed one-block gap does not establish a before-block actionable window, private builder visibility, net EV or successful capture. Historic selection of this **fixed 720-block source window** preceded event-query results, but the follow-up of these 4 events is necessarily retrospective. No new data-source subscription, signing, broadcast, wallets, native gas payment, on-chain deployment or changes to DigitalOcean.

PFT CLOSED; RMC OPEN; Shadow P2 uncertified; LIVE unauthorized; no nonrecourse native-gas sponsor; Commercial score 5.9 unchanged; NQC realized P&L USD0.
