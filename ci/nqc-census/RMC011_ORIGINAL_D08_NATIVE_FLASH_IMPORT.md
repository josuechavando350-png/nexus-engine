# RMC-011 — Full ORIGINAL D08/D09 native flash import (source truth, not D11 terminal)

This experiment runs the **existing locked Rust capital importer** over the complete originally certified RMC-008 state and RMC-009 borrower universe, without a new Ethereum RPC query. The purpose is to measure precisely the Aave V3 and Uniswap V2 **source observation** counts from historical D08 and demonstrate original source replay through the D11 capital and upstream verification contract. It neither asserts inclusion/capture nor admits an NQC flash execution without external **native gas**.

## Immutable source inputs

The source-only exact-head producer requires original upstream-input Git blob `1db0bbd78af36ee61dd6a44630a3b6614f3e9309`, RMC011 nine-of-thirteen source-universe blob `c1b9f136a13f220af9dceaae50e5caa3105121eb`, zero gas-provider registry `a9c1427bb05828d08ade537899ee1b8e43b97ed2`, and blocked final-Census lock `b1182b27b0ff3856b17a6f829ac3c693eab74400`.

Original D08 source: RMC-008 Actions run **36964016388**, artifact **11237887761**, immutable ZIP SHA256 `9431ea07144ae78e68e0ffcc7f650fa32068ee63fb53ca41ff8a062b87845913`. Original D09 source: RMC-009 run **36823489219**, artifact **11159396055**, immutable ZIP SHA256 `9aa6a4beb3ebc90f40d07d1889f84c1bcf94b3dea90b0e7b596dc6ff70fda0f6`. The original authenticated five-stage source identity witness is #661 run **37832286518**, artifact **11573678487**, ZIP SHA256 `151847cdf85b1b49298d59b41d1bf939f6854d4556060a03ab7dd5a2e1359916`.

The producer fetches and verifies successful exact workflow heads, ZIP SHA256, authority bytes, source git trees and D08/D09 stage/anchor commitments, then calls the already existing `run-rmc011-real-source-closeout.sh` and `nqc-rmc011-upstream-replay-verify`. Every source ledger and blocker remains unchanged; it produces **only aggregate, source-hashed summary metadata** without republishing original borrower, account or ZIP bytes.

## Historical source loader repair

A real D08 source uses **523,491 market rows**, including 67 Aave V3 and 523,424 Uniswap V2 observations. Previously the importer parsed all rows into one `Vec<Json>`; `upstream.rs` now streams original D08 market-state lines sequentially while preserving the exact source, candidate uniqueness, integer arithmetic, source class counts, SHA commitments and fail-closed behavior. This is a memory/scale refactor, not an excuse to truncate the corpus.

Prior #661 independently confirmed **44 non-identical duplicated D08 token admission records**. Its conservative reconciliation marks `D08_INCONSISTENT_DUPLICATE_TOKEN_ADMISSION` and preserves the union of all observed blockers. No compatible token is admitted by choosing a permissive record over a blocked record.

## Tests and promotion boundary

`python3 ci/nqc-census/test_rmc011_original_d08_native_flash_import.py -v` covers original frozen metadata, malicious run/head substitutions, synthetic accounting conservation and explicit negative certification flags. The GitHub Actions workflow also runs strict locked Rust fmt/Clippy, the D08 source tests and the unchanged original D11 closeout and independent replay.

A successful result gives only `RMC011_ORIGINAL_D08_AAVE_V3_AND_UNISWAP_V2_SOURCE_IMPORT_REPLAY_ONLY` with actual historical capital **source-class counts**. A separate independently authenticated source ZIP consumer and explicit source-universe promotion PR would be necessary to resolve the two relevant source families. **Balancer V2** and **Uniswap V3** still require independently acquired two-provider D11 observations. Full family discovery, external gas funding, D12/D13 costs, D14 locks, D15 temporal coverage, D16 opportunity economics and D17 final Census remain separate obligations.

No original on-chain transaction or wallet is operated; no new paid infrastructure or RPC is provisioned; `main` unchanged and no claim of monthly USD 15k/55k or NQC realized P&L.
