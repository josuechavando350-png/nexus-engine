# RMC-016 — Complete Historical Aave V3 LiquidationCall Discovery (one operator)

## Exact source and objective

The independently published RMC-015B temporal certificate reports **139 Aave V3 Ethereum liquidation events / 127 unique winning transactions** over inclusive Ethereum mainnet blocks **25880316..26095351**. It also explicitly censors any unproven arrivals. This tool attempts to acquire and conserve the **actual event and transaction hashes**, not assign gross economics or fictitious Nexus captures to them.

The Ethereum pool address is `0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2`, and the LiquidationCall event topic is `0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286`.

The execution source depends on the exact RMC-016 commit `96a0b3e3c0b55df1b1d890f8c70a7a9014e2ff9a` and immutable D16 economic source blob `5d5ed3635a426d686c8a98aa3547fd5b9d8b95aa`. The full D15 source begins at block hash `0x0b29e0c8c1997f059f82e7fed67e047269f68422ab194d56546c1c9833469d96` and ends at `0x0d7a15fbb72e69696a33c65bc20902fe08e5630862ada64b065a97405c70c781`.

## Scope and strict admission

- Rate-safe wide-range mode first attempts a single full-window log query, splitting deterministically only where providers explicitly require smaller block ranges. The GitHub producer uses a minimum **22-second interval between HTTP requests** to respect unauthenticated public-provider limits. This is throttled access, not rate-limit circumvention. A mid-run 429 remains a source blocker.
- On interruption, every already completed shard remains separately committed with a content-addressed **partial** event record. No partial record may be interpreted as complete enumeration. The full source admission still requires every block, all event identities, and exact cardinality reconciliation.
- Queries `eth_chainId`, both exact block headers, and `eth_getLogs` over a disjoint exhaustive partition. Bounded adaptive splitting is permitted for genuine range limits; forbidden/unauthorized or pruned RPC data is a terminal source blocker, not an invitation to forge completeness.
- Each log must match pool/topic/ABI shape, canonical event ordering, block range, transaction hash, block hash and valid non-reorg state. Reject duplicate logs, overlapping/missing shards, provider result caps and any input from a different chain.
- Complete single-source discovery can *corroborate* exactly 139 events / 127 distinct transaction hashes, but is always labelled `RMC016_SINGLE_SOURCE_WINNER_EVENTS_COUNTS_RECONCILED` and `independent_provider_consensus=false`. Any different count remains a mismatch rather than being pruned to force 139 or 127.
- The optional receipt mode verifies all 127 receipts on the same source and aggregates gas **in wei**. No conversion to USD or historical net is allowed without independently pinned ETH price and the cost ledger. One provider's receipt array never certifies two-provider provenance, and gas paid by competing liquidators is not Nexus P&L.
- The workflow begins with a full Blockscout acquisition, after the smaller official-provider preflight independently admitted dRPC, BlastAPI and Blockscout on the last 10 blocks and one historical receipt. The full Blockscout scan is a new independent acquisition, not an extrapolation of the empty ten-block sample.
- A successful scan produces content-addressed public Ethereum transaction hashes and sanitized event provenance. No borrower-address index, private keys, wallet credentials, live transaction signing or broadcast is included.
- `OWN_CAPITAL = 0` remains an execution requirement. These logs cannot establish it or the $300K/month economic objective.

## Required next gates

1. Independently compare every returned event and transaction with at least one other distinct provider, including chain hash, receipt and log index. A 10-block sample does not prove full-month complete cross-operator enumeration.
2. Fetch 127 receipts and reconcile each winner's transaction gas in wei, then bind gas-asset oracle prices at exact historical decision time.
3. Recover or independently reproduce original D16 transaction ledger with SHA `55d5d6be9e09f2e499e1ca8949c4305d05824dffa61e363f4371c615537dcb1c`; do not claim hash equivalence unless bytes match.
4. Simulate Nexus counterfactual execution with external financing for principal and gas, exact fork route, protocol/flash fees, gas/MEV/competition and out-of-sample capture. Only then consider a P&L estimate.

Neither this collection nor its adversarial fixtures close RMC-014, RMC-015, RMC-016, RMC-017 or certify profit. No Cano Penal or unrelated NEXUS runtime is modified.
