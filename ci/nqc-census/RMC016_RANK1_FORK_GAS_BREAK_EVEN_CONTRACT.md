# RMC-016 — Physical Aave liquidation gas budget, NOT Nexus net P&L

This diagnostic is limited to ONE retrospectively selected Ethereum Aave V3 historical WETH/WETH competitor winning liquidation. It does not prove ex-ante discovery, a real transaction, third-party funded native gas, competitive capture, or reliable monthly net capacity.

## Immutable sources

- [Original no-WETH-subsidy real fork PR #637](https://github.com/josuechavando350-png/nexus-engine/pull/637): workflow 37741109591 SUCCESS, head 5b5402ff373f06804f8714d91dfe247f0c230c92, artifact 11534051574, ZIP SHA256 9af974b4f87a68ef9e9dcf932e146b2440f197939b8bd75a7e993755b06c8bf1.
- Original WETH after actual fork Aave flash principal and fee repayment = 90814117763741536 wei (0.090814117763741536 WETH), with original fee 5342006927278914 wei; no fork-minted fee or collateral. This is not native gas ETH.
- [Original historical two-operator WETH oracle sample](https://github.com/josuechavando350-png/nexus-engine/actions/runs/37726618359): artifact 11527902751, ZIP SHA256 5ae6c45b53ded26f327270758c248f7f4ec0ff1365f550e54dcf28feb4a83a03, previous-block price 250480170000 base 1e8 = USD 2504.8017 per WETH. This is a previous-block reference, not exact winner-transaction prestate.
- Source block is Ethereum winner block 25938048, hash 0xf143f9988199037938e4dff57aaf24301a4c26770aefc0ec64774954cbf2dbe4, parent 0x42cf44b75185587327a1aa8fc859cc5f49a639e7256547511430d6068b6f09ab.

Both upstream ZIP artifacts must be authenticated by exact original GitHub Actions run/head/workflow/artifact/name/digest, full ZIP SHA, full internal SHA manifest and original report commitment. Reject altered surplus, fee, block, parent, all false-nexus-P&L flags or altered oracle.

## Physical measurement

Foundry v1.7.1 on Ethereum historical predecessor fork at block 25938047; clock-only to winner block 25938048. Original verified T36 flash coordinator raw Git blob aa3883fa141aa096006e90e56d8d4150c9ee14ef, post-forge-format SHA256 bbb5962171f2c1da5067e21ac705a627a35028fdafe5c9403f601bb813d39320. The borrower and timestamp are authenticated from original counterfactual #637 ancestry.

Place gasleft() before and after the cross-contract call to flashExecutor.execute(), when calldata plan has already been built. This includes the EVM Aave flash loan, actual liquidationCall, callbacks, repayment and WETH sweep, but EXCLUDES test setup, test contract deployment, intrinsic transaction and actual top-level calldata costs, refund effects, EIP-1559 priority fee, failed candidate attempts, gas sponsor and builder payments. This **does not equal an original Nexus mainnet transaction receipt gasUsed**. No false claim of full execution-gas bound.

Read Ethereum winner-block baseFeePerGas and header independently through dRPC and BlastAPI. Reject any disagreement, reorg, mismatched parent, malformed fee, missing code or invalid gas metrics. A winning-block fee is a retrospective cost comparator, not a prior-block quoted or guaranteed inclusion price.

## Integer-only sensitivity, not actual cash flow

Illustrative budget EVM units = measured call gas + 21000 intrinsic + assumed additional overhead. Stress over [0, 50k, 100k, 200k, 300k] overhead gas units paired respectively with [0, 1, 2, 5, 10] gwei hypothetical priority tips. Compare cost in ETH wei with positive surplus in WETH wei only under a **1:1 ETH/WETH par assumption** and price historical WETH using earlier-block oracle. The underlying surplus is WETH, but native ETH gas must be prepaid by a real wallet/builder/sponsor; accounting ETH/WETH parity does NOT solve upfront gas financing, sponsor repayment or transaction inclusion.

All outputs explicitly have zero-operator-native-gas-funding PROVEN FALSE, no actual Nexus transaction receipt, no captured opportunity, no full cost-adjusted realized profit and no RMC017 closure. The zero own capital constraint includes native ETH for gas. Never promote this diagnostic to D11 terminal admission or an expected monthly P&L.

No live trading, keys, wallet, new paid provider, or deployment.
