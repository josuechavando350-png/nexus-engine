# RMC-011 — Original Balancer V2 and Uniswap V3 dual-provider source truth

This audit independently consumes an **already existing immutable GitHub Actions artifact**, **not** new Ethereum RPC, and does not authorize D11 terminal closure, native ETH gas funding, shadow capture, gas spending or profitability.

## Original immutable source and disputed workflow status

- Source repository: `josuechavando350-png/nexus-engine`.
- Producing commit `ea488b9dc13b690921416dd11c4369cfb76912e5`; producing tree `095942bdca0ef08b835d66e6807f30ccb8d601ff`.
- Original [workflow run #37689816997](https://github.com/josuechavando350-png/nexus-engine/actions/runs/37689816997) was **FAILED** overall. The specific acquisition job `authoritative-real-source-certification`, id **113026823480**, was independently **SUCCESS**; a downstream closeout job was not. Reporting the whole run as SUCCESS would be false.
- Original artifact id **11514391050**, name `rmc011-live-acquisition-ea488b9dc13b690921416dd11c4369cfb76912e5`, 443,289,357 compressed bytes, full ZIP SHA256 `a0ab50b41f5653e7749dc7360eb8006f3f088477372654ade9d966b3373f006f`.
- The original ZIP contains **30,031 file entries**, including `LIVE-ACQUISITION-SHA256SUMS` which binds **30,030** independent original files. The initial read-only audit found **zero mismatches**, but GitHub Actions must reauthenticate all members on the exact PR head, not trust that audit.

## Canonical block and separate operators

Ethereum chain_id 1, original block **26,095,351** (block hash `0x0d7a15fbb72e69696a33c65bc20902fe08e5630862ada64b065a97405c70c781`; state root `0x295ca34af4c1652ded4210d6353703c7acea726c04c27978df4a3a88d9e7bbfd`). Authority lock SHA256 `7f48d35f0373785ff2fbd6f84b385efe58dbb831f6c3cc7953adb50e3c999d95`; original D08 manifest SHA256 `1276491d349176fdd0ac63aaaa2c326c002c1a17384ba1e6db4704687842a279`.

| Family | Two observed operators | Rust reconciled sources | Executable under observed token controls |
|---|---|---:|---:|
| `BALANCER_V2_FLASH_LOAN` | Bware Labs Blast API + MEV Blocker | 67 | 0 |
| `UNISWAP_V3_FLASH` | MEV Blocker + Tenderly public gateway | 69,748 | 0 |

Original per-family Rust reconciliation member SHA256:

- Balancer V2: `bf93eb4ee786995123781241e8f159ffe50cb4cfbb909b814ebc2c495f690b02`.
- Uniswap V3: `6337a671a405e427a7ae9f2479651e3d4e2e96da55bed652999c4b452e542143`.

All original 69,815 sources have unique source IDs/key IDs, `execution_eligible=false`, zero original `executable_capacity`, and the conservatively unproven fee-on-transfer, rebasing and token-hook blockers. Uniswap V3 additionally records **28,235** `UNISWAP_V3_ZERO_ACTIVE_LIQUIDITY` conditions. These facts are **at the declared historical block**, not a statement that protocol liquidity, executable candidates, or token behaviors were absent in all markets/times.

## Independent auditor contract

The new source verifier and 17 adversarial tests reauthenticate actual run/head/tree, exact successful producer job despite failed overall workflow, original ZIP SHA256, complete 30,030-member manifest, four original capture files and two Rust-reconciled documents. It checks independent providers, exact block, universe hashes, immutable source identities, source counts and original executed eligibility. All checks are read-only.

The original 9-of-13 RMC011 family source-universe remains **unchanged** in this PR. Both Balancer and UniV3 rows remain source-universe **unresolved** until another independently reviewed PR pins these exact original witnesses under their narrow source-observation scope. D11 complete family discovery and funding are separate authority gates.

**Nonclaims:** NQC-approved independent native ETH gas sponsor count = 0; NQC realized net P&L USD 0; no D11 terminal certification; no 8/8 D14 stage lock; no D12/13 full execution economics, D15 full nonlookahead coverage, D16 fully monetizable opportunity cost ledger or D17 final closeout. No new RPC, paid DigitalOcean service, wallet, contract, gas spending or on-chain transaction.
