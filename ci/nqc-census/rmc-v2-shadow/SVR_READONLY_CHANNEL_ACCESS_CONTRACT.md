# NQC PREINCLUSION-002 — Flashbots MEV-Share source access one-shot witness (READ ONLY)

## Single falsifiable question

Can one uncredentialed, explicitly documented **Ethereum mainnet Flashbots MEV-Share public SSE** endpoint return an HTTP-200 stream, and can the already tested NQC #733 hint parser process any source-local event during one bounded real observation? This is a **source connectivity and received-message witness**. It is NOT proof that the Aave WETH oracle is in SVR, that a target Chainlink report was emitted, or that NQC can win inclusion or earn money.

Parent PR733 commit `ecc8b395e695d57f2bcd15fd8088056d9508a7c1`, tree `1e93a4e1fa2b1bcfa1cecdeef33f65f604e06c52`; inherits verified PR732 Aave Ethereum WETH one-hop aggregator `0x7c7fdfca295a787ded12bb5c1a49a8d2cc20e3f8` at historic pinned block 26,193,763. This source identity does **not** establish an SVR-eligible feed. Target and method are frozen in `precommit-before-network.json` **before** a network connection.

## One-time public access trial

1. HTTP GET `https://mev-share.flashbots.net` (Accept: `text/event-stream`). Explicitly documented endpoint in Flashbots [Event Stream](https://docs.flashbots.net/flashbots-mev-share/searchers/event-stream). One connection, 24-second observation ceiling, at most 1200 message frames, 512 KiB received, 200 KiB/frame. No retries, identity switching, alternate hosts, proxy changes, keys or private header impersonation. Stop immediately on access-denied HTTP 401/403/429, DNS/transport failure, unexpected redirect, invalid SSE framing or read limits.
2. On every received `data:` frame, record receiver-local UTC nanoseconds, monotonic nanoseconds, SHA256 of exact in-memory bytes and the **#733 parser verdict**. Never upload raw third-party private calldata, event hashes, addresses, receipts or signal contents to public GitHub CI artifacts; retain at most 40 hash-only receipts. An event `hash` from MEV-Share is **double-Keccak**, not necessarily an Ethereum transaction hash usable for `eth_getTransactionReceipt`; docs explicitly distinguish them.
3. If SSE HTTP 200 succeeds, optionally GET once `/api/v1/history/info` and one bounded `/api/v1/history?blockStart=maxBlock-8&blockEnd=maxBlock&limit<=25&offset=0`. This secondary archive diagnostic is retrospective, limited and never establishes access before inclusion. Missing hints, a 403, HTTP429, EOF and no target in 24 seconds are all **censored or bounded**; not market-wide zero opportunity.
4. The only live method is HTTP GET to one pinned public Flashbots host. No Ethereum JSON-RPC, websocket subscription, wallet, signatures, bundles, bids, eth_sendRawTransaction, funds, deploys, emails, service creation or paid infrastructure. Existing ephemeral GitHub CI infrastructure is used one time; there is no watcher deployment.

## Gate semantics

- `BLOCKED_SOURCE_ACCESS_CONTROL` (HTTP 401/403) or `INCOMPLETE_SOURCE_RATE_LIMIT` (429): the actual environment did not prove channel availability. Respect the denial and request legitimate onboarding; do not evade controls or retry.
- `INCOMPLETE_SOURCE_TRANSPORT_OR_FRAMING`: no authenticated channel proof, not a denial of access from other permitted environments.
- `PUBLIC_MEV_SHARE_SSE_HTTP_200_NOT_SVR_ACCESS_PROOF`: transport responded 200; only a hash-anchored source-local live event can support evidence of process reception. **No** Chainlink SVR searcher eligibility is inferred.
- If the source returns hints, even a decoded target price remains `TARGET_PRICE_DECODED_UNAUTHENTICATED` until independently verified Chainlink/Aave trigger and a builder deadline. No result here can output `BEFORE_BUILDER_CUTOFF_PASS`, `BUNDLE_WIN`, `FLASH_GAS_FUNDED` or a dollar P&L.

PFT CLOSED; RMC OPEN; SHADOW P2 NOT CERTIFIED; CANARY/LIVE NOT AUTHORIZED; OWN_CAPITAL = 0 including gas and contingencies; user's MXN 2,000 reserved intact; technical/commercial scores unchanged; NQC realized P&L USD 0.

## Observability and source integrity

Code/frozen target/report timestamps SHA256, exact HEAD/TREE, source/workflow, result, logs and fail-closed immutable manifest must all match the same commit. The CI gate can be green for an honestly recorded HTTP403; a green result only attests faithful source observation and no-claims checks.
