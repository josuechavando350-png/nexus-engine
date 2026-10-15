# NQC V2 cbXRP/USDC — Three canonical Base Morpho liquidation witnesses

Parent original PR741 GitHub artifact ID 11944154144, ZIP SHA256 f65c2b526fe93d105b096716515b4eac7b98698cb331048d3c6a8cf936b65ce4, 23 complete indexed days only; 418 cbXRP/USDC indexed Liquidate logs, 227 unique transactions, ~1,281,537.248484 NOMINAL USDC repaid (indexer USDC decimals unverified before this test). 20 largest winner transactions contain 88.08% nominal repaid volume; median unique tx value ~186.50 USDC.

This experiment fixes three sample txs BEFORE calling chain RPC: top 11-event source tx with 154,844.072724 nominal USDC repaid, one median single-event tx with 186.502312, one four-event upper-tail tx with 58,348.075368. All original (tx,block,timestamp,global log index, caller, repaidAssets,seizedAssets) tuples pinned as code literals from PR741 source archive, no dynamic hindsight selection after RPC.

Only 2 public Base RPC providers https://mainnet.base.org and https://base-rpc.publicnode.com; allowlist ONLY read-only eth_chainId, eth_getCode, eth_call, eth_getBlockByNumber, eth_getTransactionReceipt, eth_getTransactionByHash. Maximum 30 calls/provider. Network/permission error is INCOMPLETE, not false absence.

Exact canonical source: Morpho Base address 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb from official Morpho addresses. Market ID 0xd4a903dc6d949519060c7707f9604fdc9772c046e05c2e3a8fce0bd7196e4109 from original PR741. Read historical idToMarketParams bytes32 (five ABI words), recompute market Keccak, exact token addresses, oracle, IRM, LLTV; dual-RPC decimals and deployed code. Verify each original Liquidate event against real receipt topic, global log index, repaid/seized raw integer, caller and zero bad debt; require actual ERC20 loan repayment to Morpho and seized collateral Transfer from Morpho. Both RPC receipts, block headers, transaction identities and gas observations must match.

Compute only theoretical LOAN-TOKEN ORACLE incentive from immutable LLTV under official Morpho max factor 1.15 and cursor 0.3. The incentive is NOT a tradable collateral sale quote, not actual profit and not independent token price. L2 gas only is separately reported; absent OP Stack l1Fee is unknown, NOT ZERO. Receipt recipient/operator is not proof of profit owner.

A SUCCESS in source job can mean status INCOMPLETE source, since tests passing means fail-closed correctness, not onchain claims. Preserve artifact, manifest and source error. Can upgrade only after positive exact three-chain transcript AND separate DEX exit quote, empirically eligible opportunity in advance, sponsor and builder competition.

Official docs: https://docs.morpho.org/developers/contracts/addresses/ ; https://docs.morpho.org/learn/concepts/liquidation/ ; https://basehub.org/api-reference/rpc-overview/ .
OWN_CAPITAL=USD0 (gas included); owner MXN2000 untouched; no signatures, funds, live transactions, orders, merges or disclosures. NQC P&L USD0, commercial 5.6/10, economic scale 4/10 until new decisive proof.

## Revision: additionally read official Morpho API market metadata

The original canonical RPC 403/429 issue, if any, must be retained with its literal HTTP status and failing method. Separately call the *official public Morpho GraphQL marketById* once to source the immutable market loan/collateral contract addresses, decimals and LLTV. It is the SAME INDEXER trust tier as PR741 and NEVER upgrades Base onchain verification. Only when the API returns valid market ID, USDC (6 decimals), cbXRP collateral and WAD LLTV may this producer compute an illustrative **oracle-pricing-model incentive** from PR741 23-day nominal debt. This is not DEX sale consideration, searcher profit, market accessibility, monthly repetition, an underwriter quote or own-capital-zero execution. An API error must yield MORPHO_METADATA_INCOMPLETE, not a fallback of invented metadata.

## Independent liquidity discovery and exact scenario limits

One additional public DexScreener GET for the verified Morpho-API cbXRP token is an **independent indexer snapshot** of advertised Base pool liquidity, not an onchain quote for any seized-collateral size and not a pool-level slippage proof. Record returned pair count and up to 5 largest reported pools; the public list may be truncated, stale, inconsistent or missing aggregators. A 403/429 must be reported and never evaded. No trades or signing.

Separately calculate for the three frozen indexed transactions the exact integer-valued exit-haircut sensitivities at 0%, 3%, 5%, 10%, 12% using Morpho metadata LLTV/LIF and ORIGINAL loan principal. These are expressly **hypothetical after-haircut and before native gas, builder, flash financing, execution, failures and sponsor fees**. No observed future quote and no expected NQC earnings. LIF 1.1267605633 implies price haircut tolerance 11.25% BEFORE additional costs; the liquidation bonus 12.676% is measured against debt, not seized collateral. Neither rate establishes any actual DEX execution.
