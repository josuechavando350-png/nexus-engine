# RMC-015 — Material risk frontier (auxiliary historical discovery)

## Scope and non-authority

This read-only selector is a deterministic, content-addressed snapshot-derived **prioritization aid**. It does **not** advance RMC-015A trigger acquisition, RMC-015B executable opportunity episodes, RMC-016 conservative capacity or RMC-017 terminal Census authority. It does not authorize execution, P&L, revenue or any capital-source promotion.

An Aave borrower with `healthFactor >= 1e18` is **not liquidatable** solely because they enter the watchlist. An oracle-base-unit debt figure is **not** liquidator-receivable value or revenue. One observed anchor does not establish future price movements or opportunity arrival rates.

## Authenticated inputs

For the exact A1 Ethereum mainnet block 26,095,351, reference immutable GitHub Actions archives:

| Stage | Run | Artifact ID | SHA-256 of artifact ZIP |
|---|---:|---:|---|
| RMC-008 state/oracle | 36964016388 | 11237887761 | `9431ea07144ae78e68e0ffcc7f650fa32068ee63fb53ca41ff8a062b87845913` |
| RMC-009 accounts | 36823489219 | 11159396055 | `9aa6a4beb3ebc90f40d07d1889f84c1bcf94b3dea90b0e7b596dc6ff70fda0f6` |

Validate against the exact commits `36c732a36789e1967ce7178010889427ad7cf0f2` (D08) and `6db82ca89d4ef3a66a1b236de95670a6967eb3ea` (D09). Never substitute "latest passing" or a synthetic source.

The selector independently authenticates archive ZIP SHA-256; evidence-ledger member lengths and SHA-256; code commits; exact block number/hash/timestamp; D08 Aave-oracle base currency unit across all oracle records; and D09 account/debt/position/health-factor cardinality conservation.

## Computation and outputs

- D09 `getUserAccountData` `totalDebtBase` is the second array field; `healthFactor` is the sixth. All monetary operations use exact `uint256` parsing and native integer arithmetic. The unit is bound from D08's oracle records, not assumed from floating-point price conversions.
- Partition the entire debt-bearing universe into disjoint, half-open health-factor intervals: below 1, [1,1.01), [1.01,1.05), [1.05,1.10), [1.10,1.20), [1.20,1.50), [1.50,2), [2,+inf).
- Watchlist admission is **strictly** `1e18 <= healthFactor < 1.2e18` and `totalDebtBase >= 10,000 * authenticated_oracle_base_unit`. This generates **historical monitoring targets**, not liquidation candidates.
- The tool may optionally emit the ordered, exact watchlist for subsequent historical reconstruction; the canonical workflow publishes only aggregate stats and its watchlist commitment, not borrower addresses.
- Output includes the A1 source artifact commits/digests, manifest digests, exact quantity strings, partitions, and SHA-256 commitment, with explicit nonclaims. No extrapolation or capture probability is ever computed.

## Production next step

For any selected watchlist account, RMC-015 must reconstruct historical **pre-trigger** state and verify an actual crossing with full block/transaction order, oracle mutation, reserve index evolution, collateral eligibility, liquidatability, executable capital, exact route and gas/builder costs. Two independent provider/operator authorities and no look-ahead remain mandatory. This selector alone cannot satisfy RMC-015/016 or provide an estimated daily/monthly earning rate.

## Acceptance / failure tests

CI requires exact-commit tests, internal tampering detection even if outer ZIP is re-pinned, anchor substitution rejection, schema and source-unit validation, identical output under account-order reversal, no double counting, and fail-closed rejection of unknown states, false health-factor annotations and noncanonical monetary fields. A true `CERTIFIED` or final Census marker from this tool is forbidden.
