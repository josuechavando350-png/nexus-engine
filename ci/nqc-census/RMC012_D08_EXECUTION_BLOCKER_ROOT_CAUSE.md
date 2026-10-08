# RMC-012 — Real-source execution-blocker root cause, not an admission

**Status:** RMC012_EXECUTION_BLOCKER_ROOT_CAUSE_DIAGNOSTIC_ONLY. No token status is modified; no positive Nexus earnings or final Census certificate.

## Immutable upstream

1. **RMC-008** Ethereum block 26095351, [run 36964016388](https://github.com/josuechavando350-png/nexus-engine/actions/runs/36964016388), artifact 11237887761, immutable GitHub ZIP SHA-256 `9431ea07144ae78e68e0ffcc7f650fa32068ee63fb53ca41ff8a062b87845913`. `token-admission.jsonl` independently checks SHA-256 `f7ada7b07f1efef31e3cd9d9d8ddcae0ecd1bfa6ced96e6d6ff94bc8ee48d65d` against the ZIP's own evidence manifest and checksum list. It has 514,279 tokens, **all BLOCKED** (this is a source compatibility admission state, not evidence they are all malicious).
2. **RMC-012** terminal actionability source, artifact 11519153831, outer SHA-256 `bbe6a6365d563eb41125d9fcdba79ac384c21182f31f6761897e0ce2ee8fa3b8`. Exact `actionability-records.jsonl` SHA `1c2d4ffe4970f418c495d917e9b28e34494d67f29052669d775583e2240f5baf`, `capital-promotions.jsonl` SHA `6bcba8925d60b30aa46f6772f6ffb1d1f6dfc5f3c0b3310efbfb50b09d6b1569`. The archive's terminal SHA manifest and source artifact manifest are checked.

## D12 source-bounded diagnosis

- 474 borrower collateral/debt pairs examined, 432 marked actionability ADMITTED, 42 REJECTED. **All 432 admitted** have capital status REJECTED with reason `EXECUTION_BLOCKED`. The capital check covered only **principal plus flash repayment**, not gas; zero principal feasible and gas funding not certified.
- The 432 candidate pairs touch **27 distinct debt assets** and **33 distinct collateral assets**, union **43 tokens**. The original D08 manifest contains **75 separate source-role observations** for them: exactly **43 Aave reserve-underlying** observations and **32 additional Uniswap V2 token** observations. Every one of the 43 Aave records remains `BLOCKED`. Repeated token addresses across different source roles are expected and MUST NOT be silently deduplicated or treated as a duplicate-record error.
- **All 43 Aave underlying observations** have `FEE_ON_TRANSFER_UNPROVEN`, `TRANSFER_HOOKS_UNPROVEN` and `REBASING_UNPROVEN` blockers; 30 have `UPGRADEABLE_UNPROVEN`, while 13 have `UPGRADEABLE_PRESENT`. Among the **32 separate V2 observations**, 32 report `RUNTIME_CODE_IDENTITY_NOT_ACQUIRED`; one V2 USDT record contains a balance-vs-pair-reserve mismatch that is **not** a reason to label the Aave USDT reserve itself as having that V2 mismatch. UNPROVEN is not equivalent to proven malicious or unsafe.
- D12's actual capital-rejection classifier in `nqc-census/crates/nqc-census-capital/src/lib.rs` returns `EXECUTION_BLOCKED` when, for the unmet funding leg, non-execution-eligible sources with matching asset/anchor/atomicity have nominal capacity >= the unmet amount. The D08 importer in `upstream.rs` assigns token compatibility blockers to those source objects. **This is a principal execution-admission problem, not automatically proof of missing flash liquidity.**
- The arithmetic oracle-base gross differences in this terminal A1 snapshot are tiny and are not economic or portfolio authority. No inference about uncaptured liquidations, other dates/chains or the true end-to-end P&L distribution is permitted.

## Required engineering evidence before removal of a blocker

D08 compatibility must be proven for a **specific asset, version, chain and historical block** with runtime code identity/proxy implementation lineage; actual transfer, mint, redemption and allowance delta behavior (including fee-on-transfer/rebasing/hook cases); PFT/fork execution equivalence; and independent chain witnesses. Transfer gas, flash premium and collateral sale execution are separately required. Do **not** set `PROVEN_COMPATIBLE` or change `execution_eligible` from a model, label, token popularity or a code-presence call.

A priority starting point for targeted tests is tokens participating in many capital-rejected obligations (USDT 128, USDC 86, GHO 42, UNI 39, and others). Raw pair counts describe the old dust snapshot; **they are not a ranking of current expected profit.** Separately, historical RMC-015/RMC-016 opportunity detection and the next executable-candidate validation must remain the economic priority. Resolve principal, gas, route, MEV and capture using actual proof, not synthetic admissions.

The script intentionally emits only source-bound aggregate token address/blocker counts, never borrower identities or user positions. It is read-only, O(1) parse-memory per JSONL record except the 43 required asset records and 474 D12 pair rows. No deployment, trade, wallet access, paid provider provisioning or alteration of RMC-014/017 is authorized.
