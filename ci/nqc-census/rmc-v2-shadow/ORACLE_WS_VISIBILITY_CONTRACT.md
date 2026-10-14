# NQC V2 — Read-only prospective ETH/USD WebSocket visibility gate

## Why this experiment exists

PR #700 established retrospective causal price-path changes for two selected Aave borrowers. PR #701 showed that repeated public JSON-RPC reads of the pending-block tag were mostly censored: 2/6 usable dRPC pending views (133 transaction objects in those views) and 0/6 valid BlastAPI pending views. A successful CI observer must not be confused with successful opportunity detection.

The provider [dRPC Ethereum eth_subscribe documentation](https://drpc.org/docs/ethereum-api/subscriptions/eth_subscribe) documents WebSocket access at wss://eth.drpc.org, newHeads and a provider-specific drpc_pendingTransactions subscription for full pending transaction objects. This PR tests that source without assuming it works on the public endpoint, or that one node's mempool sees a given oracle report before inclusion.

## Bounded prospective test

Run exactly one ephemeral public WebSocket observation, using only the following JSON-RPC methods:
- eth_chainId
- eth_subscribe, with exact parameters newHeads or drpc_pendingTransactions
- The WebSocket closes at or before a 90-second bounded observation duration / 30,000 notification cap. A single test uses 70 seconds / 20,000 notifications by default. No privileged relay or transaction submission is attempted.

Require chain ID 1; parse exact subscription acknowledgements, JSON-RPC messages, source hash identity and canonical header shape. Full pending transaction objects must have valid hashes and null mined metadata. A direct ETH/USD DualAggregator call or the historical forward(address,bytes) call targeting 0x7c7FdFCa295a787ded12Bb5c1A49A8D2cC20E3F8 is a candidate. A match is still only a *pending-view candidate*, not a Chainlink-accepted report or an Aave liquidation trigger.

Store time of **first observation by this process**, recent newHeads identity, transaction hash and SHA-256 of candidate input, not the entire mempool or sensitive endpoints. The provider's first-seen time and real preinclusion status are not authenticated by this experiment. Do not interpret a missing candidate, an unsupported subscription, zero stream notifications, malformed frames or source rate limits as "no market opportunity."

A successful workflow only means bounded observation completed and report/no-claims validations passed. Failures are evidence; preserve them with source hashes and immutable CI ZIP, never turn them into success by relaxing gates.

## Known limits and next authority gate

- Neither the operator's ability to access public *vs private* mempool nor public-mempool exhaustiveness is established.
- The dRPC provider-defined full-object subscription may be unavailable without an API key; it must fail closed.
- The ephemeral runner's wall clock is not an oracle for node-side tx first-seen or builder visibility.
- A candidate cannot be labeled detected-before-inclusion until the same tx hash is linked to an external verified canonical receipt with a valid earlier null receipt or equivalent authenticated timing, and the chain causality and Aave HF impact are measured.
- Cold standalone NQC transaction gasUsed, off-chain sponsorship, builder payments, capture rate and net expected value are still UNKNOWN.
- A single source cannot establish RPC operator independence or full network coverage.
- Production 24/7 operation and any changes to existing DigitalOcean hosts are outside this PR.

Constitutional status: PFT CLOSED; RMC OPEN; P2 Shadow uncertified; LIVE unauthorized; OWN_CAPITAL = 0 not proven for native gas; Comercial 5.9 unchanged; NQC realized P&L USD 0.

If drpc_pendingTransactions does not expose a usable stream, pivot to an explicitly provisioned, authorized source with a documented subscription contract, cost, delivery latency, and coverage. Do not guess access or silently use paid provider keys.
