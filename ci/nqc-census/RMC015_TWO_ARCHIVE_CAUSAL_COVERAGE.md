# RMC-015 — Source-locked partial causal coverage, two real archived witnesses

**Status:** bounded partial evidence only. NOT RMC-015 terminal, NOT Shadow, NOT NQC P&L. No new Ethereum RPC, subscription, wallet or real trade.

## Two independently produced, already successful source artifacts

| Original evidence | Commit SHA | Run | Artifact | ZIP SHA-256 |
|---|---|---|---|---|
| full fixed 857 account end-snapshots | 38fe58debbd729753f84d4587a9f3b961a542bc9 | 37802830152 | 11561622884 | 15bbe3f90214c95692f0fa64997d1bd103177f02ed78049f17a8500925408829 |
| first 480 successor blocks, independent dual-operator Aave events | c2d84ff6486202eb2a5810852e21e89b3ab5e2c5 | 37807155179 | 11562554317 | f431bc64770be49ebeee5d48a40f8013592c3a4f1c25fd3abbd4c43f6c66c9f3 |

The workflow checks success, exact head, unexpired archive metadata, immutable archive SHA-256, the internal ZIP manifest, canonical source reports, source watchlist, authority commitments, Ethereum anchor, exact block partition and independent RPC operator evidence. No individual borrower addresses are uploaded.

## Scope and economic nonclaims

- Ethereum mainnet original selection anchor: block 26,095,351, 857 source healthy material-debt accounts.
- First successor event window: **[26,095,352..26,095,831]**, **480 contiguous blocks**, zero canonical publicly executed Aave LiquidationCall logs observed by the original two operators.
- Missing event coverage: **[26,095,832..26,102,551]**, **6,720 blocks**. They are censored/unknown. Never call them zero or claim 7,200 blocks verified.
- Two actual 857-account endpoints: first successor block had 857 healthy with debt; at +7,200 there were 851 healthy with debt, six without debt, zero below HF 1 at that specific endpoint. Intervening position paths are unknown.
- Six debt-free accounts do not prove liquidation; zero executed events in 480 blocks do not prove zero unexecuted opportunities.
- A retrospectively fixed risk cohort is not a genuine live precommitted positive alarm. Precision, recall, capture probability and latency remain NULL. Do not assign 857 false positives or a positive market-share estimate.
- NQC realized net USD = 0; zero authorized nonrecourse external gas providers; terminal RMC-011..017 remain open.

## Safeguards

Adversarial offline unit tests reject changed report SHA, wrong anchor/ancestry, synthetic source universe, inconsistent 857 denominators, boolean or negative account counts, forged fully verified windows, vanished segments, duplicated RPC operators, inconsistent zero-event digests, false P&L/capital/Census closure and timestamp reversal. Pure unit-test composition is explicitly NOT artifact-authenticated. Only the production function that verifies the exact original ZIP bytes can emit an authenticated *partial* join.

## Reproduction

Run the negative test suite:

    python3 ci/nqc-census/test_rmc015_dual_source_causal_coverage.py

After independently obtaining the two immutable Actions ZIP files and verifying the SHA-256 values above, run:

    python3 ci/nqc-census/rmc015_dual_source_causal_coverage.py --population-archive /path/to/11561622884.zip --event-archive /path/to/11562554317.zip --out /tmp/nqc-causal-coverage.json

The workflow performs two byte-identical offline production runs and uploads the aggregate report plus hashes, never borrower account data. No extra public historical requests or expenditure.

**Next remaining blocker:** obtain two independent available historical RPC providers for the 14 missing 480-block segments, or find independently authenticated immutable original event archives for those segments. For capture, subsequently add true decision-time positive alarms and negative controls, physical executable routes, and actual nonrecourse native-gas underwriting. Do not merge to main or certify Census on this auxiliary artifact.
