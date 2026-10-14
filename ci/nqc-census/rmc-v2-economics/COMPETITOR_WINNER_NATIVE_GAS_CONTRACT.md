# NQC V2 — 47 original competitor liquidation receipts: exact historical native-gas costs

## Why this matters

PR718 completed all 83 source-known Withdraw owners and found no HF<1 at its pinned block. That is excellent *known-cohort coverage*, not a general opportunity or profitability test. The next commercial blocker is execution competition: actual liquidation winners on mainnet *paid gas* and may have paid out-of-band builders. Knowing their real complete receipt gas is materially better than using only NQC's internal 1,115,038 / 948,267 gasleft deltas or invented gas tariffs.

This gate measures gas from **47 distinct actual competitor winning transactions** in the immutable PR693 89,390-block source and 53 source-indexed Aave V3 LiquidationCall logs. It does not pretend that competitors ran NQC's contracts or that their gasUsed is a cold full-NQC route quote. The indexer is **not** an exhaustive authoritative whole-Ethereum liquidation census.

## Authenticated source authority

- Producer PR693 head 219b8e97ee667c0797980e3e28edf34030ad1a03, CI 38489472232 SUCCESS, artifact 11861430884, ZIP SHA256 5a198ad15588e6e2ec692ef05ab16f51127141b3b00b0949b6ea7d945b20d1c4.
- Original nested Blockscout archive SHA256 b3d82ccd21cd683424b99c020732d2e2978ce2981a51b46df177a2d22c7bb722, old positive-control corpus 139 events / 127 original winner transactions; exact 53/47/21 postwindow source and immutable raw event hashes. The original discovery is an INDEX, not a truth source for receipts or completeness.
- Reuse the already source-authenticated PR712 archive verifier, and independently re-compute the 47 transaction groups / 45 distinct Ethereum event-bearing block heights. Exact tx source rows are 53 liquidation logs; one winning tx may carry multiple logs and must pay gas **only once**.
- Validate original GH Actions producer run state/commit and artifact ID/digest; no use of mutable latest-success.

## Ethereum audit

Only allow eth_chainId, eth_getBlockByNumber(number,false) and eth_getTransactionReceipt(original exact tx hash) over two public RPC endpoints, dRPC and PublicNode. Authenticate chain ID 1, exactly 45 historical canonical block headers (hash, parent, stateRoot, timestamp, baseFeePerGas, gasLimit), exactly 47 original competitor receipts per endpoint (transactionHash/blockNumber/blockHash/transactionIndex/status=1/gasUsed/effectiveGasPrice), and precisely every original LiquidationCall log byte: Pool emitter address, all four topics, four ABI words and original indexed borrower/collateral/debt/amounts/global log index. Re-read source boundary headers after the scan for reorg detection.

A missing/invalid receipt, provider HTTP 429, RPC error, mismatch, log missing or altered Aave event must be **INCOMPLETE / MISMATCH**, never a zero-gas winner. Every network call remains read-only with a strict original-TX/header allowlist; at most 110 calls per RPC endpoint and 0.5s pacing per request, no provider key/quota bypass.

For each complete actual competitor receipt:
- native paid gas wei = receipt gasUsed * effectiveGasPrice + (blobGasUsed*blobGasPrice if a complete EIP-4844 receipt);
- block base fee burned wei = gasUsed * block.baseFeePerGas;
- onchain priority fee wei = gasUsed * max(0, effectiveGasPrice - baseFeePerGas); effective price below base fee is rejected for this Ethereum period;
- no off-chain builder transfer/bundle bid, rebates, refunds, bribes, other paid transactions or opportunity failure costs inferred.
- Count each transaction's gas **once**, even when multiple LiquidationCall events were emitted in it. Compare 47 identical reconstructed economic witnesses across two public URLs (no claim of different backend operators).

Produce deterministic nearest-rank p50/p90/p99 gasUsed, on-chain effective/priority gas prices (wei per gas), and total native ETH wei, together with full authenticated receipt identity and source transcripts. These are *historical descriptive sample statistics*, NOT probability of winning, NQC net profit, current market fees or full-NQC transaction gas.

## Why this is not yet the answer to profitability

NQC PR698 historical fork showed WETH/USDC gross surplus 2273.989378 USDC and WETH/USDT 150.882941 USDT before native gas, inclusion/builder, sponsor, failed bids and operations. Its gasleft deltas are internal calls NOT independent cold whole-transaction gasUsed. Substituting historical competitor gasUsed for cold NQC gasUsed would be a serious false-PASS; this gate forbids that substitution.

After this ledger the next gate must measure **NQC's own cold standalone complete transaction** on a local historical fork with exact calldata/gas/initial warmed state assumptions and no transaction submission to Ethereum, then link a prospective observed candidate, accessible ordering, flash financing, actual costs and a contracted nonrecourse gas payer. The user's MXN2000 buffer must remain untouched absent transaction-specific authorization and a conscious change to OWN_CAPITAL=0 including gas.

No PR merge, deployment, signing, broadcasting, wallet access, paid API, DigitalOcean changes, external contacts, or strategy/live trading. PFT CLOSED; RMC OPEN; P2 Shadow UNCERTIFIED; LIVE unauthorized; commercial 5.9 unchanged; realized NQC P&L USD 0.
