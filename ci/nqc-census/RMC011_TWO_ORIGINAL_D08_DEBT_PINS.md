# RMC-011 — Independent original D08 two-debt evidence, 9/13 partial capital family source lock

**This is not D11 terminal certification.** The exact current `rmc011-capital-source-universe.json` (Git blob `c1b9f136a13f220af9dceaae50e5caa3105121eb`) now declares seven original bounded-family rejections previously verified under PR #659 plus **two additional, source-scoped zero-owned-capital debt-family rejections**, with four *protocol-native flash liquidity* families still unresolved.

## Original evidence source

- Source producer [PR #661](https://github.com/josuechavando350-png/nexus-engine/pull/661) exact commit `5b79e7be1c185cbb4924d592991b9c990fc0465a`.
- Immutable producer Actions run [37832286518](https://github.com/josuechavando350-png/nexus-engine/actions/runs/37832286518), **SUCCESS**; original artifact **11573678487**, exact ZIP SHA-256 `151847cdf85b1b49298d59b41d1bf939f6854d4556060a03ab7dd5a2e1359916`.
- `COLLATERALIZED_BORROWING` original evidence JSON SHA-256 `78e130c871ecf881a90cbe37996046864cb7afc27d79a31dc36c2804a4ba052c`.
- `PERSISTENT_DEBT` original evidence JSON SHA-256 `b8b22443a5a3491a1ed64cb8c8c11958503784e42c6537877ac92b70e988b478`.
- Original D06–D10 source registry Git blob `1db0bbd78af36ee61dd6a44630a3b6614f3e9309`. The producer independently downloaded all 5 immutable original successful GitHub Actions ZIP files (runs 36820687233, 36952216731, 36964016388, 36823489219, 37053225954), verified their exact ZIP SHA256s, reconstructed the original 5-stage canonical state authority and performed D08 Aave debt discovery **twice with byte-identical results**.
- Original D08 historical protocol side: 67 candidate debt facilities, 67 facilities, zero protocol-side rejected. **These are not NQC-funded/borrowable credit.** The two NQC execution-scoped family rejections arise from zero authorized external debt providers, zero registered permissionless debt facilities, and **zero authorized pre-execution non-operator collateral funding paths** under OWN_CAPITAL=0. No global absence-of-credit claim.

## Separate independent authenticator

The new `NQC RMC-011 Independent Original D08 Two Debt Pins` GitHub Actions gate, independent of the first source producer, rechecks:

1. Exact current **nine** family source-universe Git blob, original upstream-input Git blob, empty provider/permissionless/collateral catalogs and still-blocked final D14 lock.
2. Successful GitHub Action run, producing commit/tree and artifact metadata for the original **two-debt** report, plus exact SHA-256 of original ZIP and every internal member, manifest and report self-hash.
3. Independently re-queries and compares original producing run/artifact/tree metadata for **all five** D06–D10 source artifacts, and checks original producer report's exact authority digests, D08 facility counts, stage provenance and explicit non-claims.
4. Rejects fabricated source-universe rows, forged native-gas sponsorship, hashes, status/owner drift and attempts to self-certify Census. Adversarial source-byte tests use the original authentic ZIP as their only positive witness. Replays the final audit twice and compares bytes.

## Four still unresolved

- `AAVE_V3_FLASH_LOAN`
- `UNISWAP_V2_FLASH_SWAP`
- `BALANCER_V2_FLASH_LOAN`
- `UNISWAP_V3_FLASH`

`family_universe_discovery.status=NOT_CERTIFIED`, `terminal_claim_allowed=false`, `d11_terminal_closed=false`, configured external native gas sponsors 0; the D14 final-census lock is unmodified with zero stage pins. D12/D13 and D15/D16/D17 terminal authority remain outstanding. No P&L, revenue reliability or production action is certified.

No trading, wallet, account/provider onboarding, RPC spending, new DigitalOcean infrastructure, or raw borrower data upload occurs in this independent verifier.
