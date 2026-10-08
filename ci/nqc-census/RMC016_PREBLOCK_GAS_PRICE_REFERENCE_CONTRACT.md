# RMC-016: Historical pre-block WETH gas-reference valuation (NOT economic closeout)

This read-only source-linked diagnostic tests a first **five-block slice** of the 123 distinct Ethereum blocks containing 127 historical Aave V3 winner transactions. It independently queries **dRPC** and **BlastAPI** for the WETH price exposed by the Aave V3 Ethereum oracle at the **previous block end** and **winning block end**, and confirms exact price/header parity. The 127 receipt rows and 139 LiquidationCall records are separately authenticated; each transaction's receipt gas is charged once per tx hash.

## Exact upstream artifacts

- Blockscout raw historical event universe: successful run 37718661409, artifact 11524139188, SHA256 6b4098c1acf153106ac5b67d2c5c7db5cd0295a16c782ad8c34ae75303306204.
- dRPC canonical receipt stage (source workflow failed overall for its BlastAPI phase): run 37719091371, artifact 11524199698, SHA256 182b5e81b00ca04e53c9193c1496a725dc152ade9a17d3ab2dfaeb5045ac86b6. The complete 127-row dRPC stage must be reauthenticated; **the failed workflow is not a terminal source authority**.
- Independently observed WETH historical oracle sample: successful run 37719715290, artifact 11524894285, SHA256 5d321ec4707da6b9b0a0e1b24ce2d28992bb9329dd937baa6466c759359c3f73. Includes block 25883782 with WETH oracle price 243398000000 in USD-1e8 units and block hash ec6d981a... .
- Pin oracle address 0x54586be62e3c3580375ae3723c145253060ca0c2; WETH 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2; function selector 0xb3596f07; base unit 100000000.

## Arithmetic and claim boundary

An observed transaction consumes wei of native ETH in its actual competitor receipt. For a prior-end-block price P denominated USD*1e8 and gas paid G in wei, **reference USD-WAD** is floor(G*P/1e8). Two providers must agree exactly on each pair of block hashes and price values. Price at block B-1 is data known before B; price at B's end may contain effects after the transaction. Neither observation alone reconstructs *intra-block transaction prestate*. If they differ, the report flags an oracle transition; even when equal the report keeps prestate certainty FALSE.

This diagnostic is a preblock **reference valuation** only. It does NOT establish an exact transaction-time gas USD cost, profit of original liquidators, any swap or flash loan cost, actual asset monetization, independent full-month event-source coverage, externally financed gas or principal for Nexus, Nexus inclusion or competition-adjusted capture probability, realized Nexus P&L, the USD 300K/month target or RMC017 closure. No live trades, no signing and no user capital. Every terminal money/census claim remains false.

Production CI authenticates all three immutable run/head/tree/artifact-name/digest pairs before using these source bytes. A partially completed or failed RPC run preserves a diagnostic report and never produces a false PASS. Each later batch requires an explicitly pinned prior source and disjoint winner-block window; avoid look-ahead using the D08 terminal snapshot to price earlier trades.

## Planned next gates

Continue through all 123 unique observed winning blocks under independently corroborated, rate-safe acquisition, then historical oracle pricing of the 23 unique underlying assets (13 appearing as debt and 18 as collateral, with overlapping roles) from the certified 139 event legs, historical decimals/configuration, flash premiums, route costs and Nexus ex-ante feasibility. All observations must remain partitioned by transaction with integer arithmetic and no assumed capture.

## Second immutable historical gas reference batch (blocks 6–10 of 123)

This batch is explicitly **offset 5, count 5**, over the sorted 123 distinct winner blocks. Previous source [GitHub run 37724463691](https://github.com/josuechavando350-png/nexus-engine/actions/runs/37724463691) completed successfully at code commit `1e612f07344425dd32328f145d6b443ea6c13170`, tree `8a1449282ca4cdecbfa32fce704cf871c7201cfc`, artifact `11526732517`, outer SHA-256 `638c24697432ca5b5dd1651ddd1adb494489a6f49714afedac414809e3b5acd5`.

Before querying another block, independently reauthenticate that exact workflow, commit/tree, artifact identity and outer/inner SHA-256; then verify source coverage of exactly sorted blocks indices 0–4, compare evidence timestamps and per-block transaction counts to exact dRPC receipt sources, and reject any overlap with blocks 5–9. On failure, stop without trying to estimate missing prices or promoting the prior batch to terminal money authority.

Reference gas price remains **previous block end only**, from two independently operated RPC providers, and deliberately differs from a certified transaction prestate price. The prior 5-block result is not extrapolated to the rest of the month. Both batches are source observations of competitors, never Nexus cash flow or profit. No final Census closeout.

## Third immutable historical gas reference batch (blocks 11–15 of 123)

The second price-reference producer succeeded at GitHub run 37725048195, exact commit d9c0b8882e84d43e865206c28e008de3d588823e, tree c666c8a8c6d3c91c6a6e12b853f8359b5a1dea74, artifact 11527388437, sha256:4df64e0aec5693165685279999d4c14f1da02404a9cc4434604b129ecc4f0ae0. That archive has five disjoint previous-block WETH gas references at offsets 5–9. This new producer authenticates its entire exact run/head/tree/artifact/inner-manifest identity, enforces source membership at indices 5–9 and no overlap with indices 10–14 before issuing any new RPC price query. Full Nexus P&L, exact pre-transaction prices and capital-feasibility remain unproven.

## Fourth immutable historical gas reference batch (blocks 16–20 of 123)

Third predecessor: workflow run 37725515273 SUCCESS at commit 19a795b750e1670907f2db0c409f0638ec8e7cd7, tree 669aa9e471707f414276eaae1de1fd1bca0a7371, artifact 11527183000 (sha256:260f413126733b639a66fe55d4e9b0cd4150972119819e305af502dec3380e40). That ZIP authenticates five historical prior-block price references at source winner-block offsets 10–14. This fourth batch reauthenticates exact source identity and previous covered blocks, requires zero overlap with offsets 15–19 and invokes two independent RPCs for real historic observations. It does not claim transaction prestate gas cost, Nexus financing or net P&L.
