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
