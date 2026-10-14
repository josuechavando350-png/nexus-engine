# NQC V2 — Prospective oracle NewTransmission / pending / receipt reconciliation

## Correction notice: inherited wrong generic NewTransmission selector

The historical DualAggregator 0x7c7FdFCa295a787ded12Bb5c1A49A8D2cC20E3F8 does **not** use generic OCR2 topic 0xf6a97944... for its positive oracle price-update witnesses. Its actual topics are 0x8d530b9ddc4b318d28fdd4c3a21fcfecece54c1a72a824f262985b99afef009b (SecondaryRoundIdUpdated) and 0xc797025feeeaf2cd924c99e9205ac8ec04d5cad21c41ce637a38fb6dee6016a (custom NewTransmission). The old #703 zero-event numerator is not authoritative for oracle update absence.

The corrected pending detector admits both official function selectors: transmitSecondary 0xba0cb29e and primary transmit 0xb1dc65a4, direct or forwarded. A positive oracle log/receipt is counted as a source event, while the number of **distinct update transactions** is separately deduplicated by hash. None of these gates prove private orderflow access, capture, net EV or revenue.


## Decision-grade question

PR #702 proved a 73-second, 3,396-full-pending-transaction public WebSocket stream, not the availability of the target ETH/USD updates before inclusion. A meaningful capture hypothesis must test *the positive-control denominator*: which updates actually appeared on Ethereum during our prospective observation window, which of those transactions were seen in the pending stream before the local head notification, and whether their receipts match.

## Scope and identity

All reads use the existing public Ethereum dRPC endpoint, with no API key or paid plan:
- WebSocket chain ID, newHeads, drpc_pendingTransactions full transactions, and logs filtered by **both** exact DualAggregator address 0x7c7FdFCa295a787ded12Bb5c1A49A8D2cC20E3F8 and the standard Chainlink NewTransmission(uint32,int192,address,int192[],bytes,bytes32) event topic 0xf6a97944f31ea060dfde0566e4167c1a1082551e64b60ecb14d599a9d023d451.
- After the bounded observation, read canonical headers, exact-address+topic filtered eth_getLogs within the observed head span (max 35 blocks), and exact transaction receipts of oracle updates (max 48), plus at most 24 preselected baseline pending-control transactions. All read-only method and parameter allowlists are explicit, with at most 60 RPC calls and conservative pacing.
- Default 240 seconds (maximum 360 seconds) and 24,000 max pending notifications, 30,000 absolute tool cap. No hidden paid RPC or rate-limit bypass. If a provider errors or output is malformed, preserve negative evidence and mark the denominator UNKNOWN. No overwrite of an earlier attempt.

## Calibration and anti-lookahead

- Record first-observed-by-*this-process* local wall clock / monotonic timestamp, not first-seen by the network or by a builder.
- Preselect normal pending transactions for baseline control by a fixed SHA-256 criterion (first byte modulo 64), capped at the first 24. Selection does not look at receipts or winners.
- A NewTransmission log confirms an emitted update only when matched by exact transaction hash, block hash, block number, global log index and the corresponding receipt; also require the observed head to agree with the current canonical header.
- The numerator is the number of confirmed oracle transmission transactions whose hashes were observed by this process in pending *before* the matching local head notification. This is a **single-source observation overlap**, not an empirically calibrated probability of winning a liquidation and not a census of all oracle updates.
- The first observed block is left-censored if the log happened earlier than subscription. Unobserved pending does not establish private orderflow.
- Do not compare a block timestamp to a local pending timestamp as if they shared a clock. Lead intervals are monotonic elapsed milliseconds from local pending observation to local head notification, not guaranteed transaction pre-inclusion lead.
- Removed/reorged events, absent receipt, API errors, source mismatch, gaps and imperfect head coverage remain censored.

## Outcomes

PROSPECTIVE_ORACLE_LOGS_RECONCILED_NO_CAPTURE: at least one canonical NewTransmission receipt was verified in the observed head span. No capture authority.

NO_ORACLE_TRANSMISSIONS_IN_BOUNDED_CANONICAL_SPAN: exactly zero NewTransmission logs returned by the bounded, authenticated canonical range, with no recorded errors. NOT absence outside this period.

INCOMPLETE_ORACLE_PENDING_TO_CANONICAL_OVERLAP: any missing prerequisite or mismatch. Do not silently promote.

A green GitHub Actions run certifies that code executed, its output respects the no-claims schema, and positive/negative diagnostics were preserved. It does NOT certify complete network coverage, oracle HF crossing, inclusion control, a tradable opportunity, native gas financing, net profits, RMC or Shadow.

## Financial controls

PFT CLOSED; RMC OPEN; Shadow P2 uncertified; Canary/LIVE unauthorized; OWN_CAPITAL=0 including gas not certified; USD 45–55k/month remains a target and NOT PROVEN; commercial score 5.9 unchanged; NQC realized P&L USD 0.

No signing, transaction broadcast, contract deployment, paid service, new host or production monitoring. Use existing ephemeral GitHub Actions runner for the finite measurement.
