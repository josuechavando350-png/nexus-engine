# RMC-016: Missing historical rank-2 WETH/WETH price source

STATUS: READ-ONLY PRE-BLOCK HISTORICAL COMPETITOR ORACLE EVIDENCE, NOT NEXUS TRADING PROOF.

## Correct source population

The authenticated Ethereum Aave V3 block window `25880316..26095351` contains 139 historical liquidation events and 127 unique winning competitor transactions. Nine events are WETH collateral/WETH debt and **nine** have positive collateral-minus-debt-minus-whole-competitor-tx-gas. Eight remain positive after the **illustrative only** 5bps premium, before all other costs. The previously price-authenticated two transactions are **ranks 1 and 3**, not ranks 1 and 2.

The true historical rank-2 transaction is `0xb5b3f61e5a0becc1e2007d87cbea708fe40139478fac4c5eea5633b4b4beb1fb` in Ethereum block 26024990, at sorted distinct winner-block offset 80 of 123, unique within its block.

Immutable integer witnesses:
- debt repaid = 1.827043650017560428 WETH
- collateral seized = 1.909260614268350646 WETH
- competitor full transaction gas paid = 0.000523017715007964 ETH
- WETH collateral minus debt minus competitor gas = 0.081693946535782254 WETH
- WETH remaining after a **hypothetical** 5bps premium rounded up = 0.080780424710773473 WETH.

These are historical competitor transaction amounts and an assumed flash premium, NOT a forward signal, realized P&L, guaranteed sponsor repayment route or tradeable available execution.

## Actual independent price acquisition

Reauthenticate four immutable GitHub Actions archives against exact producing run/commit/workflow/artifact IDs and ZIP SHA256:
1. Event run 37718661409, artifact 11524139188, SHA256 `6b4098c1acf153106ac5b67d2c5c7db5cd0295a16c782ad8c34ae75303306204`.
2. Receipt run 37719091371, **FAILED OVERALL** (completed dRPC 127-receipt stage preserved), artifact 11524199698, SHA256 `182b5e81b00ca04e53c9193c1496a725dc152ade9a17d3ab2dfaeb5045ac86b6`.
3. Raw leg run 37722878737, artifact 11525823668, SHA256 `b5927f49a5099a9fe8971df82f1ea5fa2c4a169b11a846f2f3c2671b1efa71ee`.
4. Independent dRPC/Blast WETH oracle source sample run 37719715290, artifact 11524894285, SHA256 `5d321ec4707da6b9b0a0e1b24ce2d28992bb9329dd937baa6466c759359c3f73`.

Use existing strict `rmc016_preblock_gas_oracle_batch.acquire(offset=80,count=1)` against the original source event/receipt/sample archives. Compare two independent RPC operators (dRPC and BlastAPI), Ethereum chain ID=1, identical block hashes and Aave oracle WETH prices at the previous block **26024989** and at winner block **26024990**, and matching original transaction hash/block/gas receipt. The previous-block price is a valuation reference, not the intra-transaction prestate. Report no total-window price claim; this only prices one missing rank-two transaction.

No native gas funding, authorized flash principal/fee, swap route, transaction-replay counterfactual, competition-adjusted capture, ex-ante signal, realized monthly NQC P&L or final Census closure are inferred. OWN_CAPITAL=0 remains unchanged. No signed transaction, project deployment, or paid service provisioning.
