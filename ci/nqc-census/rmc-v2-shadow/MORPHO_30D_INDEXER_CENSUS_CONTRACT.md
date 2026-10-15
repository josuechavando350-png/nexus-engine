# NQC V2 — Morpho 30-day cross-market liquidation activity / competition index (source-only)

## Commercial question
Without Chainlink SVR onboarding, do Morpho's public market-liquidation records demonstrate a wider competitive/capacity surface than the previously studied Base cbBTC/USDC niche? This is an indexer-only starting denominator. It cannot establish profit or market completeness.

## Protocol + source contract
- Official API: https://docs.morpho.org/developers/borrow/tutorials/get-data/ ; public GraphQL endpoint https://api.morpho.org/graphql .
- Query strictly `marketTransactions` with `type_in:[Liquidation]`, fixed trailing 30-day UNIX timestamp bounds, ascending timestamp, 100 events per page, 30 disjoint consecutive day windows and maximum 5 pages per day, only public source, no credentials.
- Capture source identity `chain id / tx hash / log index` and independent *winning tx* identity `chain id / tx hash`. One multi-event tx counts as one winner; never double count by market/pair.
- Require a constant indexer `countTotal` throughout pages within each disjoint day window; reject out-of-window events, absent borrower market/token/liquidator/amounts, duplicate event identity and incomplete pagination. Rate-limit calls and bound response sizes/timeouts; record every daily shard/page count and chronological first/last event timestamps. No retries or alternate provider substitution on HTTP denial. The result must state `INCOMPLETE_MORPHO_API_WINDOW` if the API denies any day-window query or the endpoint cannot be drained within its fixed budget. No automatic substitution of indexer zeros for canonical event absence.
- Report markets sorted by distinct tx count, unique liquidator count, leading liquidator event share, all with market/chain identity; raw numbers in token base units, NOT USD net. These numbers may indicate competitive concentration but do not prove collusion or monopoly.
- Source authority absent: Ethereum RPC independently verified receipt ledger; archival completeness; protocol-market factory union; success-at-prefix HF; executable route and cost; zero-owned-capital gas payer; builder inclusion; latency; ownership of positive token balances.
- No signing, wallets, live operation, paid RPC, deposits, emails, secrets or mainnet writes. The observer may only POST bounded public GraphQL analytics queries; it must not create or send blockchain transactions.

## Existing evidence used for strategy, NOT merged as census observations
- NQC PR #685 Morpho-USDT conditional 12,408.499781 USDT surplus had Aave HF>1 and is NOT an opportunity.
- NQC PR #641 actual EntryPoint v0.7 mock-gas sponsorship fork; historic sponsor native gas draw and token recovery; success and revert both tested. No NQC real sponsor.
- NQC PR #655 Aave Ethereum 30d baseline 139 liquidation logs / 127 competitor winning txs / USD 138,045 oracle gross. Not NQC net.

## Terminal label
`INDEXED_MORPHO_MARKET_ACTIVITY_ONLY` on complete indexer pagination, NEVER `SHADOW_P2`, `RMC_CLOSED`, `CAPTURE_RATE_PROVEN`, `LIVE`, or `PROFIT_PROVEN`. Preserve all API error provenance and SHA256 manifests; no authority from a CI green badge alone.
