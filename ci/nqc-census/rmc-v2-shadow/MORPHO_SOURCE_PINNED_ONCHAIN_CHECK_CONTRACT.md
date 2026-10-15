# NQC V2 — Source-frozen Morpho Base cbXRP/USDC three-borrower onchain state witness

## Question, not claim

PR746 [one-shot Morpho indexer precommit](https://github.com/josuechavando350-png/nexus-engine/pull/746) **actually fixed 60 unique borrower IDs before a 35-second later observation**, 60/60 returned with unchanged raw borrow/collateral; source CI run 38680463264, artifact ID **11946944184**, original SHA256 **37699eb2e3055cf1bf990d61937601691c16348fb947d6c57153062982d8b09f**, every 17/17 inner manifest file independently passed. Source status **SOURCE_CENSORED_UNIVERSE_BUT_FIXED_COHORT_VALID**: the 30 highest borrowShares records out of 20,859 API position records, and the 30 nearest-risk source-filtered records out of 628 for market `0xd4a903dc6d949519060c7707f9604fdc9772c046e05c2e3a8fce0bd7196e4109` Base. These counts do NOT certify debtors, profitable liquidations, EVM state or monthly growth. A 35-second no-change indexer interval is not a source-positive future liquidation.

New question: does an explicitly documented independent read-only source — `https://rpc.morpho.dev/realtime` from the [official Morpho bot README](https://github.com/morpho-org/morpho-bots/tree/main/bots/blue-liquidation) — provide Base chain ID 8453, deployed Morpho address and source market / oracle / frozen source borrower raw positions at one authenticated block? **One provider cannot be a quorum**. The official bot warns this endpoint *acknowledges sends but doesn't relay*; NQC invokes **read-only methods only**, no signed transactions, no `eth_estimateGas`, no send.

## Immutable source and borrower choice

This PR embeds the original PR746 exact `frozen-cohort.json` bytes (private repo) and verifies both byte SHA256 **a739994c1d6e7bfa4e22c06a114b0a632928962af9a0d59616667503b18980c3** and original canonical structural SHA256 **896c7fe20be3ba03d4a150d3784382c3678550d57d2ee00339c827da9ceae198**. BEFORE onchain reads, deterministically choose *exactly three* source-precommitted `near_hf_indexer` positions by highest API-USD principal (tie address ascending). At source time their approximate API-USDC valued debt was 80,990.43, 46,167.35 and 28,125.27 USD. These debt values are not profit and source HF filter is not onchain proof.

The inherited original `morpho_base_cbXRP_economics.py` blob from PR742 is pinned as Git blob SHA **2f2e1839b97628d9d0f1d5705b69c1e003f0ca03**, importing its previously certified authentic Ethereum Keccak256 ABI and Morpho market hash verifier rather than writing new unreviewed address/hash logic. Source addresses from the official Morpho Base singleton and PR742: Morpho Blue `0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb`, Base USDC `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`, cbXRP `0xcb585250f852c6c6bf90434ab21a00f02833a4af`.

## Onchain read gate

Within *one ephemeral* GitHub Actions job, **one pinned public endpoint**, max 12 JSON-RPC methods:

1. `eth_chainId` must return `8453` (0x2105) exactly. Wrong network is terminal, not auto-retry on another provider.
2. `eth_getBlockByNumber latest` obtains canonical block height/hash/parent/stateRoot/receiptsRoot/timestamp. Re-fetch SAME number at end to reject reorg or server incoherence.
3. `eth_getCode` for Morpho singleton must show nonempty code; save raw bytecode SHA256 (not equivalence to source repo).
4. `eth_call` on actual Morpho `idToMarketParams(bytes32)`; verify Keccak market ID; exact two token addresses, real `oracle`, `IRM` and immutable LLTV.
5. At that SAME original block height, `eth_call` Morpho `market(bytes32)` with raw totals and lastUpdate, original oracle `price()` and Morpho `position(bytes32,address)` separately for the three **precommitted** addresses. Compute an exact **pre-interest-accrual-stale** debt using *official Morpho SharesMathLib* `VIRTUAL_SHARES=1e6`, `VIRTUAL_ASSETS=1`, `toAssetsUp`; report only `hf_wad_NO_IRM_ACCRUAL`. It is explicitly **NOT** the final health factor after IRM accrual at block timestamp.
6. Preserve raw request/response JSON for each bounded source call, exact commit/tree, original frozen first snapshot, tests and content SHA manifest. On any HTTP402/403/429, malformed ABI, wrong chain, wrong LLTV/tokens or missing oracle contract state, **stop immediately**, never forge source or use an alternative provider to circumvent denial.

**Do not interpret** onchain HF before IRM accrual as definitive eligibility: pending interest can make final debt higher. Source lastUpdate and block timestamp difference are reported. Chain RPC positive would be proof of single-provider **current raw protocol state**, not a profitable route, eligible current liquidation, builder cutoff, prospective competitive advantage, DEX executed output, authorized ERC4337 payer or Gas sponsorship. No transaction or wallet.

## Commercial and operational limits

A single exact-height Morpho price/position *without* accrued IRM simulation and independent RPC parity cannot move economic validation from **4/10**. The current **Comercial 5.8/10** may be revised only for material independently supported commercial changes; the technical result should be graded BUENO if source authenticates, MALO/INCOMPLETE if source denied. NQC realized USD0, `OWN_CAPITAL USD0 incl gas`, owner's MXN2000 reserve untouched, PFT closed, RMC OPEN, Shadow P2 not certified, Canary/live unauthorized, PR remains DRAFT, no main merge, signatures, trades, paid infra, external emails, disclosure or account changes.
