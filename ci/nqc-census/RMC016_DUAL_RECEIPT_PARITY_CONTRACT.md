# RMC-016 — Independent dual-operator winner-receipt parity

## Authenticated source

The exact [RMC-016 full-window Blockscout acquisition](https://github.com/josuechavando350-png/nexus-engine/actions/runs/37718661409) produced **139 actual Aave V3 LiquidationCall logs across 127 unique winning liquidation transaction hashes**, covering Ethereum chain 1, blocks 25880316..26095351. Its exact source authority is:

- GitHub Actions run `37718661409`, commit `abe54f1f23bd7bff8c37871200f7da7c59c45ac3`, tree `c74f8d9d2c317a011284398643b2d4aa6de06e83`.
- Artifact `11524139188`, named `rmc016-full-liquidation-events-abe54f1f23bd7bff8c37871200f7da7c59c45ac3`.
- Immutable GitHub artifact ZIP SHA-256: `6b4098c1acf153106ac5b67d2c5c7db5cd0295a16c782ad8c34ae75303306204`.
- Canonical event JSONL SHA-256: `c59b5c7f647229f436a7062d5a8a2e6d4193b3c02e3cfdaa6361f848dec34ad5`.
- Canonical 127 distinct transaction hashes SHA-256: `53aa2e421be59d9021b65d9d39be9ba63c8e1ef59cab6013f3cccff1629c550d`.

These source rows are public-chain-derived from a **single operator**. The already-passed independent RPC access preflight covers only the two exact block headers, the last 10 blocks and one historical receipt, not the full month. Do not treat the preflight as 139-event independent source consensus.

## Real receipt gate

1. Reauthenticate the exact source GitHub workflow run/head/tree, artifact ID/name/digest, outer ZIP bytes, complete internal SHA-256 manifest and canonical 139-event/127-transaction content.
2. Fetch each of 127 exact transaction receipts from **dRPC and BlastAPI**, two separately administered operators, not relays pretending to be independent.
3. Require success status, exact source block/hash/order and **every** LiquidationCall event including full ABI content commitment to agree with the source. Gas must be nonnegative integer arithmetic in wei, with EVM execution gas and optional blob fees separately recorded; no duplicated charges for transactions with multiple event logs.
4. Independently compare normalized receipt facts including events and gas from both operators for **all 127** transactions. A single mismatch/missing receipt blocks admission.
5. Preserve an append-only local/Actions SHA manifest with source provenance, sanitized transaction/gas witnesses, and partial per-provider evidence if acquisition fails. Do not upload raw transaction receipts or borrower identities.

## What this can prove and what it cannot

- If the gate passes: historical winner receipt identities and total gas paid in **wei**, as reproduced by two providers for the 127 transactions captured by *other market liquidators*.
- It does **not** prove global completeness of unobserved historical liquidatable windows, execution routes, flash premiums, asset monetization, ETH-USD oracle prices at each historical block, net profits of original winners, gas funding of Nexus, Nexus transaction inclusion, Nexus profit or the Month-1 USD 300k target.
- `OWN_CAPITAL=0` is still a mandatory independent capital-source constraint. Even a perfect dual-provider Ethereum gas ledger never proves it.
- No D14/D17 terminal status or PFT authority may be changed, and no live transactions may be signed or broadcast.

## GitHub gate

The input file `ci/nqc-census/rmc016-dual-receipt-inputs.json` must bind immutable exact GitHub source identities. Only the **push** event can execute external receipt downloads, while PR CI uses synthetic fixtures and source authority checks. CI tests must not downgrade any field from `NOT_PROVEN` to `PROVEN` based only on fixture arithmetic.

The repository already contains a strict source-event discovery gate. This additional stage is for **per-tx receipts and gas**. The financial next gate is historical ETH/USD pricing and fully attributed 15-category route/economic costs, followed by an evidence-grounded Nexus-specific counterfactual.
