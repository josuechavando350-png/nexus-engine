# NQC V2 — PREINCLUSION-001: source-limited admission of private SVR price hints

## Decision to falsify

Before paying for infrastructure or sending an Ethereum transaction, can NQC reliably recognize a **complete, price-decodable** Chainlink SVR MEV-Share hint for the **Aave WETH oracle aggregator already authenticated in PR732**, while refusing to turn partial event hints, locally observed block times, or unauthenticated data into proof of available liquidation or economic profit?

This is an **offline decoder/readiness test**, NOT evidence that NQC has received any private live signal. Onboarding, a genuinely received prospective event, independently documented builder cutoff, capital source, and competitive inclusion remain external gates.

## Provenance and precommit

- Parent PR732 source commit: `1ead6fb230056fec3c1dd520512a1c49f28aa13b`.
- PR732 block 26,193,763 Ethereum Aave price route identified the **WETH one-hop aggregator** `0x7c7fdfca295a787ded12bb5c1a49a8d2cc20e3f8`. This address is an onchain source witness, NOT proof it is on a searcher-accessible private SVR route.
- Official Chainlink SVR Ethereum onboarding: <https://docs.chain.link/data-feeds/svr-feeds/searcher-onboarding-ethereum>. Official `forward(address,bytes)` selector is `0x6fadcf72`, inner `transmitSecondary(bytes32[3],bytes,bytes32[],bytes32[],bytes32)` selector `0xba0cb29e`. The first official TypeScript snippet contains a shortened `6fadc72` typo; never copy it. Locally authenticate both selectors against Ethereum Keccak-256 using the existing independent utility.
- Flashbots MEV-Share partial hints are intentionally optional; missing `callData`, `txs`, price or data must be **CENSORED**, not interpreted as absence of target updates. MEV-Share source material: <https://github.com/flashbots/mev-share-client-ts/blob/main/src/api/interfaces.ts>.

## Boundary of authority

`svr_hint_admission.py` makes exactly one synthetic-data classification per externally supplied byte sequence: `TARGET_PRICE_DECODED_UNAUTHENTICATED`, `INCOMPLETE_HINT_CENSORED`, `NO_TARGET_IN_COMPLETE_BOUNDED_HINT`, or `INVALID_HINT_CENSORED`. A target match means ABI decode only. No signature authenticity, Chainlink commitment validity, Aave post-update HF, private authorization, builder inclusion, or profitability is inferred.

The decoder validates exact selectors, target aggregator, canonical bounded ABI offsets/padding and nested `int192` report values; it rejects unsigned/invalid prices, unsorted observations, malformed dynamic regions, excessive input, duplicate JSON properties, and selector/calldata inconsistency. It returns an **integer raw median**, NEVER a floating-point USD number or liquidation P&L. Non-target hints are not evidence of market-wide absence.

`deadline_gate` refuses to claim early completion without a separately authenticated prospective source observation and a verified independent builder cutoff using the same monotonic clock; a public mined block timestamp can never substitute for that cutoff. A status of `PREPARED_BEFORE_CUTOFF_ONLY_NOT_INCLUSION_OR_PROFIT` would still not certify successful bid or inclusion. The offline CI **does not call this path with live observations**.

## CI and strict limits

- Only deterministic offline fixtures and tests. The specialized workflow has read-only repository permissions; no network traffic from application code, RPC calls, wallet, signing, message stream, trading, bids or paid services. GitHub Actions checkout and upload-artifact are the only infrastructure operations.
- Save exact commit/tree, test transcript, code/contract/workflow, sorted `sha256sum` manifest and immutable artifact. Specialized green CI means parser **SOURCE TESTS PASS**, not `ACCESS_PROVEN`.
- In case of unsupported hint shape or provider rejection, the conclusion remains `INCOMPLETE`, not zero profitable events.

## Next actual commercial test

Obtain *authorized* Chainlink SVR searcher onboarding or a lawful stream with field guarantees; obtain an actual pre-inclusion observed event, freeze borrower/feeds BEFORE outcome, capture UTC/monotonic timestamps + payload SHA + source, verify report->Aave effective update and full route with independent deadline/capital controls. No `LIVE` or `CANARY` without the owner's **specific** authorization.

PFT CLOSED; RMC OPEN; SHADOW P2 NOT CERTIFIED; LIVE NOT AUTHORIZED; OWN_CAPITAL USD 0 including gas; user MXN 2,000 reserved not spent; commercial score 5.9 unchanged; NQC realized P&L USD 0. No merges, no repo visibility modifications and no intellectual property shared with competing searchers.
