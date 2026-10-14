# NQC V2 — Exact ETH/USD oracle RPC source capability matrix

## Why this gate matters

The source-identity audit #705 proved that the Aave WETH/USD DualAggregator's genuine historical price-update paths use custom NewTransmission and SecondaryRoundIdUpdated topics. #706 corrected the source filters, but a 720-block historical scan still produced INCOMPLETE rather than a verified zero: dRPC returned a JSON-RPC error and BlastAPI returned HTTP 400 at the first OR-topic shard. A CI success that archives those negative findings does not certify oracle absence, source coverage, or capture.

## Experiment: precise positive control, provider capability, recent fixed scope

1. Use dRPC and BlastAPI public Ethereum endpoints only, strict allowlist: eth_chainId, eth_getBlockByNumber, eth_getTransactionReceipt for two whitelisted tx0 hashes, and exact-address/topic eth_getLogs with at most 32 blocks per call.
2. Authenticate the two originally selected historical tx0 receipts at blocks 26,142,067 and 26,149,038. These are positive controls of actual emitted ETH/USD update events, not profit evidence; their receipt block hash, chain, status, index and event topics must be exact.
3. On each known-positive block, query both **single-topic** SecondaryRoundIdUpdated and NewTransmission filters and also a single OR-topic filter. Compare events for the controlled transaction against its authenticated receipt. Record whether each query is PARITY, MISMATCH or ERROR. An OR-topic failure does not erase a successful single-topic result; a single-topic error does not mean zero events.
4. Before observing any recent logs, freeze a stable 64-block window anchored at latest minus 16 blocks. Query both topics separately in two nonoverlapping 32-block shards each (four calls per source). Authenticate every returned event's actual canonical header hash, and recheck window boundaries. Require full source completeness and agreement to claim two-provider recent parity. No substitution of Blockscout-indexed counts for canonical RPC.
5. Conserve public provider quotas (max 30 RPC calls/provider, no paid plans, no retries when throttled), retain structured provider errors and exact per-call result SHA-256. A partial source result remains INCOMPLETE; do not impute zero. Backend RPC operator independence is not proven.

## Authority and failure taxonomy

- TWO_SOURCE_ORACLE_LOG_CAPABILITY_AND_RECENT_PARITY: both known positive control blocks match by single-topic queries, and full 64-block recent event sets agree. Historical cadence is still descriptive only. OR-query can remain unsupported and is a separate capability signal.
- INCOMPLETE_ORACLE_RPC_SOURCE_CAPABILITY: any positive control missing/mismatched, unreadable provider, event set disagreement, partial range, or unverified recent canonical header.

An authenticated historical event means an on-chain oracle report occurred. It says nothing by itself about Aave borrower liquidation eligibility, public pending visibility before inclusion, access to private relays, probability of competing successfully, ability to fund native gas without own capital, or NQC profit. All such gates stay UNKNOWN.

PFT CLOSED, RMC OPEN, P2 uncertified, LIVE unauthorized, OWN_CAPITAL=0 not yet certified for native gas, commercial score 5.9 unchanged, realized NQC P&L USD 0. No signing, submission, transactions, deployment, subscriptions, hidden requests, credentials, new droplets or new paid services.
