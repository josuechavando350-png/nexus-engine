# RMC-016 — Append-only Blockscout receipt batches

This change recovers real public-chain receipts from an authenticated **failed** producer without asserting that the failed workflow or the incomplete evidence became terminal authority.

## Exact immutable sources

1. Full Blockscout event universe: GitHub run 37718661409, artifact 11524139188, SHA-256 6b4098c1acf153106ac5b67d2c5c7db5cd0295a16c782ad8c34ae75303306204; 139 LiquidationCall events, 127 distinct public transactions, one event-source operator.
2. Full dRPC receipt stage: failed run 37719091371, artifact 11524199698, SHA-256 182b5e81b00ca04e53c9193c1496a725dc152ade9a17d3ab2dfaeb5045ac86b6; all 127 historical receipt witnesses reauthenticated byte-for-byte, cumulative gas 448369976498898050 wei.
3. Blockscout prior partial: failed run 37720137160, artifact 11525810815, SHA-256 b64e15fde2112efa32564a224dbf38b2b338bda35d2aefc68c0cb78b3f6339da; **10** Blockscout receipts independently matched with the dRPC source. The subsequent Blockscout request returned HTTP 429, so the prior workflow correctly failed.

## Incremental algorithm

The batch producer reauthenticates the complete GitHub run/head/tree/artifact identity of all three archives and verifies each outer and inner SHA-256. It loads the source's exact ordered 127 transaction hashes, dRPC canonical normalized receipts and the first ten Blockscout receipts. It rejects forged, noncanonical, duplicated, reordered, incomplete, gas-inconsistent or rehashed-but-modified previous records. Then it requests **up to six NEW receipts** from Blockscout, with at least seven seconds between requests and explicit 45/90-second limited retry waits if HTTP 429 occurs. It never re-queries the ten previously authenticated receipts.

Every matching receipt is compared to the dRPC transaction's block/hash/ordering, full LiquidationCall data and gas in integer wei, including optional blob gas. Even partial progress is saved with SHA-256 in an immutable archive and reports `RMC016_SECOND_OPERATOR_BATCH_CHECKPOINT_PARTIAL`, `real_market_census_closed=false` and `nexus_realized_pnl_proven=false`.

Future runs must **explicitly repin** the preceding exact run ID, commit/tree, artifact ID/digest and monotonic verified prefix. No floating latest, no inferred artifact SHA-256, no resubmitting failed requests as success. A complete 127/127 two-provider receipt result would still not prove an independently complete second full-month log census, historic USD oracle gas conversion, principal/flash capital, gas sponsorship, route monetization, MEV capture, Nexus inclusion, positive P&L or Month-1 target.

The upstream RMC-015/D16 certificate is unchanged; the entire effort is read-only and financially non-authoritative. No live signing or transaction broadcast; OWN_CAPITAL=0 remains the user constraint.

## Second immutable batch: 16 → at most 22 verified receipts

The first batch succeeded on exact push run 37721062634 at commit 264dd05e346a3b2fe65d4022f4fccaf7f966c312, tree 11ebf1d196e66e9f978a0e85043f4b85bf5c414b, artifact 11525961944, outer SHA-256 8ffc179a69f535c47035d5d4ef6201a44e56956ec7dbbed125f0729aa264f7ce. It authenticated 16 unique Blockscout receipts in exact sorted order and reported 111 still unmatched. The second-batch producer **does not download or authenticate the failed 10-row artifact as its direct parent**: its exact direct parent is the successful 16-row artifact above, which in turn binds the failed 10-row evidence. Original 127-row dRPC and 139-event Blockscout identities remain unchanged.

The second batch may acquire at most 6 NEW receipts, preserving the immutable existing 16, source-linked gas in wei and a complete SHA-256 ledger. The final marker, capture calibration, Nexus financing and economic claims remain forbidden. Earlier failed workflows are historical context, not authoritative closing gates.

## Third immutable batch: 22 → at most 28 verified receipts

Previous exact GitHub push run 37721369826, commit 011bba0975ae585ebb8efe6daedb2d5a4dd88ae0, tree 1c6a0262297be41b7294c7def324bd08620e3b2b, artifact 11525806907, ZIP digest sha256:85e2ad6262d556a69c210469419feaab3966693b955f332579b9c28bc2cbbafc. The archive contains precisely 22 receipts (16 earlier plus 6 newly matched), SHA-256 verified, with 105 pending. Continue from this exact predecessor; request only the next six, preserve rate-limit failures, and keep economic/Census authority claims false.

## Fourth immutable batch: 28 → at most 34 verified receipts

Run 37721652969 at commit 369df8fabec17f43a1e91bd00c3a9c46500e2f21 (tree 7ca569d76d703d1eb22e6f05de29b3c1b6deea83) ended SUCCESS. Artifact 11526366948, digest sha256:a05e5ed45a7a702aedac40e442362e9cb57044d2f8a491a43acac366f8d53f87, contains 28 immutable independently matched receipts (22 previous + 6 new), 99 pending. The fourth producer exact-pins this archive, only requests the next six at the same public-provider pacing, and preserves all Census and economic nonclaims.
