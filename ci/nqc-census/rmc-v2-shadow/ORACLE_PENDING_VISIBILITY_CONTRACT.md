# NQC V2 — Prospective public-RPC pending view for ETH/USD oracle

This is the next research step after #700's authenticated historical price-freeze causality, not a trading strategy or certification of market capture.

## Narrow objective

Falsify the assumption that public Ethereum JSON-RPC endpoints expose oracle reports **before canonical inclusion**. Use existing documented public endpoints (dRPC and BlastAPI), with one bounded, rate-conscious probe from an ephemeral GitHub CI runner. No new droplets, RPC subscriptions, paid plans, keys, wallets, broadcasts, active transaction filters or privileged data streams.

For each time round and provider (dRPC then BlastAPI, interleaved):
1. Check eth_chainId == 1 once and enforce a strict allowlist for eth_getBlockByNumber(latest,false), eth_getBlockByNumber(pending,true), and (only for a detected candidate) eth_getTransactionReceipt.
2. Require matching latest block number/hash/parent/time before and after the pending read. Reject reorgs, tip changes, pending blocks with a non-null hash, wrong parent/height or absent full transaction objects.
3. Search pending transactions solely for a direct ETH/USD DualAggregator report or the canonical forward(address,bytes) wrapping the report selector observed historically. Strict ABI, target address 0x7c7FdFCa295a787ded12Bb5c1A49A8D2cC20E3F8, transaction hashes and null mined metadata are required.
4. Request a receipt for each matching pending transaction; a non-null receipt censors the candidate due to a possible inclusion race. A null receipt is a provider-local, time-stamped observation, **not** verified mempool first-seen timing or accessible private ordering.
5. Record samples, latency, source URL identifier (not credential-bearing URL), RPC error classifications, SHA-256 of public response and candidate calldata, and explicit uncertainty. An invalid provider response or rate limit is CENSORED, not zero opportunities.

Default 6 samples per provider with a 3-second interval, now round-robin between endpoints to reduce source time skew. Hard limits: <=6 samples, <=30 calls/provider, <=5000 transactions in a pending block, <=8MB per RPC response. Stop probing a provider on first transport failure; never bypass or evade rate limits. The GitHub runner terminates after its one-shot job. No persistent service claim.

## Interpretation contract

- PENDING_ORACLE_REPORT_OBSERVED_UNCALIBRATED: a source returned a valid pending-view candidate with no receipt at the probe moment. This is NOT proof of winning same-block inclusion, public mempool first-seen, viability of submitting a transaction, price report acceptance, or an actionable HF trigger.
- BOUNDED_OBSERVATION_NO_TARGET_NOT_EXHAUSTIVE: the bounded sampled views were supported and had no matching report. NOT evidence that reports were absent, exclusively private, or commercially unviable.
- INCOMPLETE_PENDING_SOURCE_CAPABILITY: malformed/stale responses, provider errors, incomplete samples, unsupported pending views, or head races. This is an informative blocker; **not** a negative market census.

A workflow CI PASS is only a PASS for producing structurally valid evidence (including complete negative or censored evidence). It never promotes P2, RMC, live, net EV, or revenue. No number of samples can alone establish a calibrated capture rate.

## No-claims preserved

PFT CLOSED; RMC OPEN; Shadow P2 uncertified; Canary LIVE unauthorized; OWN_CAPITAL=0 remains unproven for native gas; Comercial 5.9/10 unchanged; Nexus realized P&L USD 0. No maker/relay payments, priority bidding, gas, financial obligations, signing, trade execution or smart-contract deployment.

Next falsifiable step after a positive observation: perform prospective block-hash pinned accounting and compare the exact pending-observed tx hash with its subsequently confirmed receipt, timestamp, HF transition and competitor ordering (or preserve censored failures), with enough samples to calibrate detection and capture. If this feed fails, investigate a legal/authorized private or relay-specific observational channel with its own permission, reliability and cost contract. Never infer private flow from a public endpoint's silence.
