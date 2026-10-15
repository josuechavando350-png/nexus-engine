# NQC V2 PREINCLUSION-004 — Ground-truth SVR oracle updates against historical MEV-Share hints

## Decision-grade question

PR734 proved access to **public** Flashbots MEV-Share SSE (144 events in ~24 seconds), and PR735 proved a fully sampled 180-second stream (1,498 events), but their WETH source control did not undergo a new `latestRoundData` update during the pinned samples. Those negatives are not a denominator for target feed recall. Do not spend more CI time on blind short SSE sessions without known oracle updates.

Instead of repeating the same watch, test whether any **verified historical onchain WETH DualAggregator `transmitSecondary`** updates are recoverable as hints from the *public* MEV-Share archive at all. This test is deliberately **retrospective**, calibrated with genuine onchain positives rather than simulated historical liquidations. It answers **archive linkage and hint disclosure**, NOT delivery before inclusion, builder deadline, eligibility, bid acceptance, profit or zero-capital gas financing.

## Precommitted controls, before any new network access

Blockscout Ethereum indexed internal successful `transmitSecondary` calls into the exact WETH DualAggregator authenticated through Aave in PR732: `0x7c7fdfca295a787ded12bb5c1a49a8d2cc20e3f8`. Its method selector is `0xba0cb29e`. Two preselected 14-Oct-2026 events from different hours:

1. **22:10:59 UTC**, block **26,193,643**, receipt TX index **1**, hash `0x8a25a63c628cca85d613e577bfbd0f89d9c5a0112c409abf1f5474b0d96ab8da`.
2. **23:11:11 UTC**, block **26,193,944**, receipt TX index **287**, hash `0x53de29056359c29351d353fff7542daf50416053842385e9cb6013834140dc40`.

Blockscout indexing is only an *admission list*. The transactions must be corroborated independently against **both** public Ethereum dRPC and PublicNode responses: chain ID 1, exact receipt TX hash/status/index, canonical current/prior headers and parent/stateRoots, original WETH DualAggregator emitted `SecondaryRoundIdUpdated` or `NewTransmission` event topics, actual transaction identity, before/after `latestRoundData()` by EIP-1898 canonical blockHash, rechecked headers to reject reorgs. Two RPC URL strings do not prove independent backend operators. If any source disagrees, classify `INCOMPLETE_SOURCE_CONTROLS` and preserve errors, not zero updates or missing market demand.

## Flashbots historical test

Use the documented mainnet `https://mev-share.flashbots.net/api/v1/history/info` (one GET) and a maximum of **four** pages of **400** hints per **fixed oracle-positive control**. `blockStart=receiptBlock-8`, `blockEnd=receiptBlock+1`; each page requires only `blockStart,blockEnd,limit,offset`. Maximum **1,600** entries per control, **8** pages total and **9** GET operations including `/history/info`; each HTTP body <=8MB. Respect HTTP 403/429, no retry, bypass or identity-switching.

Per page, classify available `txs.functionSelector==0x6fadcf72`, completeness of `callData`, oracle-decodable hints using the already-tested PR733 ABI, and exact *candidate linkage*: MEV-Share event hash may be `keccak256(canonical TX hash)`, not an Ethereum receipt hash. Verify the Ethereum Keccak empty string and the documented Flashbots double-hash golden vector before applying linkage. If a hint comes from a bundle hash or lacks data, no inverse mapping may be possible: missing double-hash is **not absence of SVR**. Do not publish third-party raw hints, calldata, user tx hashes, wallet addresses or private source bytes; only bounded counters, source payload SHA256, and immutable precommit are retained. Onchain positive control TX hashes are already publicly included.

`/history` entry `block` means the chain tip observed when the hint was generated, **not the inclusion block**. Thus the window is a bounded heuristic, and no positive archive match or timestamp can be interpreted as verified prospective first-seen or a builder deadline. If an archive range is unavailable, page cap is reached, or a provider errors, return `INCOMPLETE_*`, not a zero-match conclusion.

## Outcomes and commercial firewall

- `ONCHAIN_CONTROLS_AND_ARCHIVE_BOUNDED_READ_COMPLETE_NO_PROSPECTIVE_AUTHORITY`: both positive controls authenticated and archive pages exhausted within caps; report whether exact double hashes, hints for the WETH target, and sufficient ABI were visible in those **two windows only**.
- `INCOMPLETE_SOURCE_CONTROLS`: dual provider/receipt/header/oracle route insufficient.
- `INCOMPLETE_POST_ONCHAIN_ARCHIVE_READ`, `INCOMPLETE_ARCHIVE_COVERAGE_NOT_ABSENCE`: historical API errors, unavailable ranges or pagination censor.

Never elevate archive matches, private flow descriptions, an ABI decode, or a green workflow to `CANARY`, `LIVE`, `OWN_CAPITAL=0 including native gas`, expected capture rate, commercial price/bid, or profitable trading. PFT CLOSED, RMC OPEN, SHADOW P2 UNCERTIFIED, LIVE UNAUTHORIZED, operator OWN_CAPITAL=USD0, MXN2,000 reserve untouched, NQC realized USD0. No wallet, signing, bundles, bids, transaction sends, gas, deployment, paid infrastructure, host modifications or merges. Keep NQC signals, algorithm and source intellectual property under operator control.

Sources: GitHub PRs #732–#735, Blockscout indexed precommit selected **before** MEV-Share archive lookup, https://docs.flashbots.net/flashbots-mev-share/searchers/event-stream and https://docs.chain.link/data-feeds/svr-feeds/searcher-onboarding-ethereum.

## Follow-up revision: archive source-generated timestamps (NOT NQC reception)

For a **matched double-Keccak** hint only, record historical `hint.block` and `hint.timestamp` from Flashbots and the onchain consensus block timestamp of the actual included receipt. Report `included_slot_timestamp - archive_source_timestamp` as a **nominal, uncalibrated historical source-time difference**, never a builder-cutoff measurement or NQC process first-received timestamp. Historical `hint.block` is the chain tip at generation time; it is not a promise about builder inclusion timing. When the original hint carries an ABI-decodable target report, compare its exact integer raw median to the original Ethereum transaction's decoded `transmitSecondary` report median. A matching price+double-hash confirms historical information correlation, not a trade or income.
