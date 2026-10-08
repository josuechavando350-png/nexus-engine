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

Continue through all 123 unique observed winning blocks under independently corroborated, rate-safe acquisition, then historical oracle pricing of the 13 debt and 18 collateral underlying assets (31 distinct total from certified 139 leg events), historical decimals/configuration, flash premiums, route costs and Nexus ex-ante feasibility. All observations must remain partitioned by transaction with integer arithmetic and no assumed capture.
