# NQC V2: historical ETH/USD oracle attribution and price-freeze counterfactual

Status: RESEARCH GATE ONLY. Never infer prospective detection, guaranteed ordering, or revenue from a historical winner selected retrospectively. This PR is stacked on #699 and does not merge, broadcast, deploy, pay gas or touch the production service.

## Authenticated inputs

Predecessor artifact 11861179989 / producer #695 has SHA-256 1c5837ad97607fda9cb60c4888a77648645c48326a93a67adcb9f121e52d7fb8. Intrablock artifact 11864125025 / producer #696 has SHA-256 819106f72a95eb1b894161fc3447d856fbe18c6e6f7d0dc0c5d3648e5b36a6f5. The latter producer's **full CI failed** due to RPC rate limiting; only a source-authenticated successful dRPC subset can be used as a reference. No relabeling to PASS is allowed.

The original retrospectively selected winners were WETH/USDC block 26,142,067 (winner transaction index 1) and WETH/USDT block 26,149,038 (winner index 10). The first transaction in each winner block was sufficient to cross Aave HF below one in #696's historical prefix replay. These are not live trigger detections.

## Verification sequence

1. Authenticate producer ZIP SHA-256, manifests, immutable source commit and exact partial-source limitations.
2. Verify parent/winner block hash, transaction ordering, chain ID, and both provider RPC replies before and after each fork. Obtain exact index-zero eth_getTransactionByHash. Parse canonical ABI forward(address,bytes), validate the nested selector and require the same ETH/USD DualAggregator target 0x7c7FdFCa295a787ded12Bb5c1A49A8D2cC20E3F8 on both URLs. Preserve the hash of the full calldata.
3. On an independent, exactly pinned Foundry fork BEFORE index-zero execution, recover WETH price source from Aave's on-chain addresses provider and price oracle. Require Chainlink proxy aggregator equals the forward-call target.
4. Replay only the exact index-zero transaction; require its DualAggregator log, decreasing ETH/USD feed answer and Aave WETH price, and an exact borrower HF crossing matching authenticated producer metrics.
5. In a LOCAL fork only, mock Aave WETH price to its pre-update value while leaving all other post-TX0 state unchanged. Require that restores HF >= 1. Clear the mock and require exact HF return. This is a limited causal counterfactual, not evidence about public mempool visibility.
6. Require equal normalized fork metrics and forwarded transaction identity from dRPC and Blast. Any mismatch, rate limit, unknown field, missing historical state or wrong causal result is a FAIL and must preserve diagnostics.

## Non-claims and remaining gates

A passing gate attributes these selected historical HF threshold crossings to a changed ETH/USD price dependency under a price-freeze counterfactual. It does NOT prove knowledge of a pending update before inclusion, accessible transaction ordering, competitor displacement, calibrated capture probability, cold standalone transaction gas, net profit, availability of a non-recourse native-gas sponsor, or portfolio monthly capacity. Two compatible RPC URLs do not prove operator independence.

No state override on Ethereum. No wallet, signature, mempool submission, deployed contract, new infrastructure or provider plan. PFT remains CLOSED; RMC OPEN; Shadow P2 uncertified; Canary LIVE unauthorized; Commercial score 5.9 unchanged; NQC realized P&L USD 0.

A negative result is valid evidence requiring attribution/strategy redesign. Never massage fixtures to obtain a PASS.
