# RMC-011 — Reproduce historical Aave debt-family rejection from original D08 (no D11 terminal certificate)

## Material dependency

The seven bounded capital-family rejection witnesses were independently source-authenticated on [PR #659](https://github.com/josuechavando350-png/nexus-engine/pull/659), leaving **6 native flash/debt families unresolved**. Before considering either debt family (`COLLATERALIZED_BORROWING`, `PERSISTENT_DEBT`) as rejected under `OWN_CAPITAL=0`, the test must replay real Aave reserves from the **original RMC-008 authority**, and verify that NQC has no pre-execution non-operator collateral funding path or authorized independent debt sponsor.

The authoritative original D06–D10 input contract, Git blob `1db0bbd78af36ee61dd6a44630a3b6614f3e9309`, has been restored *byte for byte* from the independently existing D11 upstream authority branch commit `284273331a0db6332af534e7d1184827708d23ba`. It was missing in the downstream #660 branch; we have **not** reconstructed it from guesses.

## Original immutable observations

| Authority | Exact original Actions run | Original ZIP artifact ID |
|---|---:|---:|
| RMC-006 | 36820687233 | 11143129177 |
| RMC-007 | 36952216731 | 11207794300 |
| RMC-008 | 36964016388 | 11237887761 |
| RMC-009 | 36823489219 | 11159396055 |
| RMC-010 | 37053225954 | 11251694539 |

All five referenced original artifacts were observed as **not expired** before attempting the new integration. Their exact archive SHA-256 hashes, original producing workflow/commit, original git tree and authority manifest paths are frozen in `rmc011-real-source-inputs.json`. They may only be accepted after **fresh independently authenticated downloads and per-stage semantic verification**. A source locator or synthetic JSON object is insufficient.

## Exact-head producer gate

`.github/workflows/nqc-rmc011-original-d08-debt-rejections.yml` runs:

1. Verify original five-stage catalog blob, current seven-authenticated-source catalog blob, zero-NQC-provider registry, empty authorized collateral catalog, and still-blocked final Census lock. Check 20 independent offline negative-path tests, plus original six-family debt resolution tests.
2. Build the **unchanged** locked Rust `nqc-rmc011-authority-lock-build` and `nqc-rmc011-aave-debt-discovery` readers, with strict `rustfmt` and `cargo clippy -D warnings`.
3. Download the five original existing Actions archives, verifying run SUCCESS, original head, original artifact ID/name and SHA-256 of the **entire ZIP**. Reject expired, oversized, unsafe, altered and mismatched source manifests.
4. Independently derive the five-stage canonical authority lock, check each original authority against its own git commit/tree and replay the D08 Aave protocol-side borrower/debt discovery **twice** (exact bytes must match).
5. Independently run `verify-rmc011-debt-family-resolution.py` **twice** with the existing explicit empty provider/permissionless/collateral registries. Only `RMC011_DEBT_FAMILY_EXHAUSTIVE_REJECTION_READY` permits output.
6. Publish one real-source evidence file per *debt* family, containing the precise source scope, original D08 authority commitment, original SHA-256 and evidence producer commit/tree/run. Preserve `terminal_d11_closed=false`, `global_nonexistence_claimed=false`, `nqc_borrowing_capacity_claimed=false` and `real_market_census_closed=false`. No original borrower dataset or original ZIPs are re-uploaded.

A GREEN CI for this experiment would **NOT** promote the debt source-universe rows itself. A separate independently replayed GitHub Actions ZIP consumer, with exact member SHA-256 and a new PR updating two source-universe rows, is still required. The four native flash families and independent complete family-universe discovery remain mandatory.

If original source transport fails due rate limiting, memory, or an unavailable original ZIP, this experiment FAILS CLOSED. Do not simulate historical asset balances, pretend Aave reserve liquidity belongs to Nexus, or claim a globally exhaustive absence of third-party funding.

No new external RPC account, paid cloud instance, private-key signing, native ETH payment, on-chain transaction or production trading is performed by this producer.
