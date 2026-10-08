# RMC-016: Actual oracle reference for the two largest historical WETH/WETH margins

This is a **read-only historical competitor measurement**, not a Nexus backtest, approved flash source, capture forecast, wallet receipt, or profit estimate.

## Exactly selected observed market liquidations

- Ethereum block 25938048, tx `0x6313fb267755f3cfa48214bf74309505984306129ee09a558efe4801006dcbba`. Competitor WETH debt 10.684013854557827871, observed competitor gas 0.000019694395579376 ETH, observed collateral-minus-debt-minus-competitor-gas 0.096136430295441074 WETH.
- Ethereum block 26071849, tx `0x3c8757b8e83e098f64d88d0244709c7cdcf50ef67238e24d32357bcb679b5adb`. Competitor WETH debt 0.866504893554112580, observed competitor gas 0.000216584522059332 ETH, observed collateral-minus-debt-minus-competitor-gas 0.038776135687875734 WETH.
- These transactions are the **two largest** among seven WETH/WETH in the verified 127-historical-winner corpus. Selection was retrospective; NEVER use it to backtest an ex-ante selection signal.

## Exact source authentication

Read-only GitHub Actions verifies the original full 139-event Blockscout source (run 37718661409, artifact 11524139188, outer SHA256 6b4098c1acf153106ac5b67d2c5c7db5cd0295a16c782ad8c34ae75303306204); the 127 dRPC winner receipts (failed overall run 37719091371 but full dRPC receipt stage in artifact 11524199698, SHA256 182b5e81b00ca04e53c9193c1496a725dc152ade9a17d3ab2dfaeb5045ac86b6); and the already source-authenticated WETH oracle sample (run 37719715290, artifact 11524894285, SHA256 5d321ec4707da6b9b0a0e1b24ce2d28992bb9329dd937baa6466c759359c3f73).

For each of the two exact block numbers, the workflow validates the transaction hash and receipt block hash against the authenticated original rows, independently invokes dRPC and BlastAPI for Ethereum mainnet block headers and historical Aave V3 getAssetPrice(WETH) at the prior block and transaction block, and requires exact consensus. The only USD conversion admitted is a **historical pre-block oracle reference**, never exact transaction intrablock prestate.

## Financial modeling boundary

Any 5-basis-point flash fee example is a conditional sensitivity, not a verified fee quote from a historical eligible source. Even collateral-debt-gas-flashFee is only a conditional remaining amount, not Nexus P&L. Additional protocol liquidation fees, flash-loan contractual terms and capacities at exact state, router slippage, MEV or builder payments, failing/reverting transactions, external financing of GAS, competition timing and successful Nexus execution are **not proven**.

User capital remains **OWN_CAPITAL = 0 USD**. No realized Nexus income, calibrated probability of capture, month-1 USD 300,000 target proof, or RMC014/RMC017 terminal closure is claimed. The workflow does not sign or broadcast a transaction, mutate infrastructure, or touch Cano Penal/Vercel.
