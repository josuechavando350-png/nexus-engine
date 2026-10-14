# NQC V2 — Aave WETH/USD current oracle identity vs two historical positive triggers

## Reason for gate

A source-bound historical price-freeze experiment (#700) proved that two Aave liquidation-trigger HF crossings were caused by ETH/USD price changes. However, new research (#704) showed **zero NewTransmission topics from the assumed DualAggregator address in a source-complete 720-block (2h25m) dRPC window**, while the second public RPC returned HTTP400 at its first shard. Neither output warrants "ETH/USD did not update"; a stale source, alternate report topic, secondary route or infrequent reports could explain it.

Do not waste a permanent sniper subscription on a static historical target before checking which oracle Aave actually reads.

## Exact read-only questions

1. At the current pinned Ethereum block (latest minus 16 confirmations), resolve Aave V3 Pool.ADDRESSES_PROVIDER -> PoolAddressesProvider.getPriceOracle -> AaveOracle.getSourceOfAsset(WETH) -> Chainlink proxy aggregator(), all at the **same EIP-1898 blockHash with requireCanonical=true**.
2. Read current Aave getAssetPrice(WETH), Chainlink source decimals() and latestRoundData() (price, round and updatedAt) at that exact block. Record stale/future update timestamps without promoting a commercial trigger.
3. Authenticate the canonical headers, status and **transactionIndex=0 receipts** from historical blocks 26,142,067 / 26,149,038. The two exact tx hashes were derived from PR #700's original causal first transactions.
4. Enumerate actual topics emitted from the immutable historical DualAggregator address in each verified receipt. Test whether the standard NewTransmission topic 0xf6a97944f31ea060dfde0566e4167c1a1082551e64b60ecb14d599a9d023d451 was emitted. Do not infer an emitted topic merely from another oracle's ABI.
5. Compare exact normalized results independently requested from dRPC and BlastAPI. A second RPC may rate-limit; preserve explicit source failure and accept a source-scoped observation, not false two-operator authority.

## Interpretation

- static_target_matches = false at a current pinned block: the old DualAggregator target is NOT the currently returned aggregator of the Aave WETH source. This invalidates continuing to use it as the only prospective trigger source.
- contains_expected_new_transmission_topic = false for a verified historical positive tx0: the previously selected topic filter does not represent that historical update. Reclassify PR #704's zero-topic results accordingly; do not claim a lull in price updates.
- Both true: the topic and source were historically/currently compatible, but the zero-event bounded sample may be a valid time-scoped absence of that event, not all price changes or liquidation opportunities.
- Missing/reverting source calls or provider divergence: UNKNOWN, no trading promotion.

## Safety and profit boundary

Everything is RPC read-only. No reorg state override, no signing/broadcast, no builder bid, no deployment, no new servers/API plan, no payment. PFT CLOSED; RMC OPEN, P2 Shadow uncertified, Canary not authorized, OWN_CAPITAL=0 including native gas not proven, Commercial 5.9 unchanged and realized NQC P&L USD 0. This is an oracle adapter discovery and source-authority research gate, not a profitability certificate.
