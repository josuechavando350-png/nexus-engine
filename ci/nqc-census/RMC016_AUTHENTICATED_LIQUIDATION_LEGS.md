# RMC-016 — Authenticated historical LiquidationCall token legs

The producer re-acquires all raw Aave V3 LiquidationCall events over inclusive Ethereum mainnet blocks 25880316..26095351 and matches each decoded event commitment against the immutable historical single-operator ledger.

Exact historical source: GitHub Actions run 37718661409, head abe54f1f23bd7bff8c37871200f7da7a9014e2ff9a, tree c74f8d9d2c317a011284398643b2d4aa6de06e83, artifact 11524139188, SHA-256 6b4098c1acf153106ac5b67d2c5c7db5cd0295a16c782ad8c34ae75303306204.

The original public-chain event archive identifies exactly 139 events and 127 distinct winner transactions. Any changed amount, altered indexed address, missing/extra log, invalid ABI boolean, removed log or mismatch with the original SHA-256 commitments MUST fail closed.

The output contains integers debt_to_cover_raw and collateral_liquidated_raw in underlying token base units, plus corresponding collateral/debt token addresses. Borrower and liquidator identities are output as SHA-256 commitments only. Neither unit total is USD; never sum unrelated token amounts or infer net P&L from a token amount.

Single-operator historical source agreement is not independent full-month event coverage. This evidence does not prove flash principal availability, externally paid gas, DEX route output, competition-adjusted Nexus capture, realized net profit, or the month-one target. OWN_CAPITAL=0 remains mandatory; D14/D17 unchanged.

Next independently priced stage: exact block-pinned token decimals, oracle configuration and prices, protocol/flash costs, price impact, route feasibility, gas and inclusion at the decision-time prestate, not the winning transaction's poststate.
