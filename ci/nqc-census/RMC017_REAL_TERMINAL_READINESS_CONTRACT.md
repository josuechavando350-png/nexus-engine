# RMC-017 — Live source-lock readiness ledger (not a Census certificate)

**This is a deliberately negative, source-addressed status audit of the actual canonical Nexus Census authority locks. No changes to terminal input JSON, stage authority, profitability, provider registry or executed transactions.**

## Purpose

After many historical and physically replayed WETH flash/liquidation tests, the NQC project has meaningful technical evidence. That evidence cannot be equated to an official percentage of final Real Market Census closure or a profitable NQC trading business. This gate prevents the false assertion that green auxiliary GitHub workflows, a third-party paymaster with historical ETH on deposit, or an uncalibrated conservative capacity report constitute terminal authority.

The eight source files listed below are **read without modification** from the exact GitHub tree in this branch and independently checked against their original raw Git blob hashes. No mutable latest-success artifact and no fabricated complete flag is admitted.

| Structural/source truth | Canonical file | Git blob |
|---|---|---|
| D11 required 13 capital families | ci/nqc-census/rmc011-capital-source-universe.json | 8f42e9ab127cc567409c20383de3fea4e3618e5f |
| D11 authorized external-provider registry | ci/nqc-census/rmc011-external-capital-provider-registry.json | a9c1427bb05828d08ade537899ee1b8e43b97ed2 |
| D12 real terminal actionability inputs | ci/nqc-census/rmc012-terminal-inputs.json | 5f2694c73568938099a62978476eae37a32db9bb |
| D13 terminal economics inputs | ci/nqc-census/rmc013-terminal-inputs.json | 72b1e612732aec8118bed320bc4e55e9f206514d |
| D14 original RMC006-RMC013 structural source lock | ci/nqc-census/final-census-authority-lock.json | b1182b27b0ff3856b17a6f829ac3c693eab74400 |
| D15 original source temporal-trigger inputs | ci/nqc-census/rmc015-trigger-inputs.json | 6859795b3d976db4a5f7dd64ffb6eabcd4a7baad |
| D16 source conservative capacity input | ci/nqc-census/rmc016-capacity-inputs.json | 7fec5200a97ed56cb07501af5f66b66cfcb758c6 |
| D16 original P&L/capacity evidence | ci/nqc-census/rmc016-production-evidence.json | 5d5ed3635a426d686c8a98aa3547fd5b9d8b95aa |

The separate D17 foundation current source is NOT merged into this branch. It is independently fetched from original [PR #606](https://github.com/josuechavando350-png/nexus-engine/pull/606) head eda95cbb90aa12ae69a13b4fbc41f1e0b9cba2a3, exact Git blob 3cf64b2bdfb9891033850683d8aecf056612d4cb of ci/nqc-census/rmc017-final-inputs.json. That source explicitly reports BLOCKED_AWAITING_RMC014_RMC015_RMC016 with no three stage authority witnesses pinned. This tool never pretends the separate branch was merged or that an absent local input file is a positive D17 certification.

## Actual source status, not a percentage

1. **D11**: 13 required source families are enumerated; zero have authenticated terminal resolution in this canonical source lock. The universe itself remains BLOCKED_INCOMPLETE_SOURCE_UNIVERSE / family_universe_discovery NOT_CERTIFIED. The independently configured execution-authorized external gas-provider registry has provider_count=0. This is NOT proof that no external gas provider exists in the world.
2. **D12**: status BLOCKED_AWAITING_CERTIFIED_RMC011, with d11=null. No terminal actionability certificate.
3. **D13**: status BLOCKED_AWAITING_CERTIFIED_RMC012_AND_EXECUTION_EVIDENCE, with d12 and execution_evidence both null. No terminal complete economics evidence.
4. **D14**: status BLOCKED with all **eight RMC006-RMC013 canonical structural stage rows unpinned** in this original terminal lock, seven explicit blockers, pipeline_counts=null and economic_boundary=null. This is not evidence that every original earlier stage has no valid work; only that the canonical terminal pin set is not yet reauthenticated and admitted.
5. **D15**: the trigger-authority source lock has no RMC014 structural source, declared historical window, source-authenticated two-operator provider acquisition or production trigger acquisition. Auxiliary historical WETH temporal tests do not count as this full temporal authority.
6. **D16**: actual PRE-SHADOW conservative model/observed transaction economics authority says PASS with 139 observed competitor events and 127 historical third-party winner transactions, but NQC capture probability is UNCALIBRATED and conservative lower bound daily/monthly NQC capacity is **0**, not a forecast of actual zero profit. The D17 original foundation does not admit a final D16 stage from this alone.
7. **D17**: separate original foundation BLOCKED, with three upstream authorities unpinned. No REAL_MARKET_CENSUS_CLOSED marker.

PFT remains certified at historical commit 5b4a0cb778cb4370cd54eb6fcba765dc8d7cecdf and immutable tree ef3498da528f85cdb9fdd82222d64773a557f853.

## What closing Census would require

Reconcile every D11 family with *authenticated available external capital* OR a genuinely exhaustive, auditable no-availability/no-execution rejection reason. Then independently authenticate D12 real terminal actionability and D13 complete cost coverage. Source-pin the eight mandatory stage artifacts in D14; acquire D15 full historical window opportunity/censoring temporal authority without lookahead; independently validate the D16 conservative capacity/collision/conflict authority; finally certify all three D14/D15/D16 artifacts under the sole D17 final authenticator. A **negative but complete, reproducible and adversarially validated Census is legitimate**; a global financial success finding is not a necessary Census precondition. Shadow/Canary/real trading profitability remain subsequent stages.

No engineering percentage is statistically derivable merely by counting green PRs or locked stage checkboxes. This source ledger intentionally emits engineering_percentage_certifiable_from_these_locks=false.

No production trades, exchange/API credentials, paid infrastructure, user capital, provider gas, wallets, live transactions, source lock rewrites or profit claims are introduced. Any source alteration must fail closed until independently repinned from new immutable evidence. This is a progress diagnostic, not an approved terminal artifact.
