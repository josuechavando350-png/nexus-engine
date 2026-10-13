# RMC V2 — block 26,184,415 economic negative preflight

This directory is an explicitly **non-authoritative** economic reconciliation
from the single-provider Ethereum Aave account-data observation collected on
2026-10-13. A real production opportunity is **not** established: the
health factor exceeds 1, the block hash was not pinned, and the original ABI
response was transmitted as rounded JSON numbers. This evidence cannot be
used to approve a trade, certify P2, close D17 or increase the commercial score.

## What is quantified

- Value of collateral **decreased** USD 1,178.11750102 in Aave's 8-decimal
  USD base units between blocks 26,184,199 and 26,184,415; total debt
  **increased** USD 49.55335624. These are account-data changes; they do
  not prove an oracle price move, interest carry or borrower action.
- HF fell approximately 1.823032141124 basis points. The mechanical
  constant-effective-threshold identity fits the source snapshots. It
  cannot replace exact ABI plus bytecode/configuration evidence.
- The ~USD 1,024 collateral headroom and ~USD 942 debt headroom are *local
  sensitivities holding other variables fixed*, not a crossing forecast.
- Morpho USDT nominal token balance: 65,581,714.595588 USDT at that block.
  It is not executable or committed funding.
- Aave USDtb flash premium: 5 bps. For a **hypothetical** 472,000 USDtb
  amount, the fee is 236 USDtb using Aave half-up integer arithmetic.
  Aave USDtb underlying at the aToken failed to read and remains UNKNOWN.
- Morpho USDT needs USDT→USDC→USDtb acquisition, liquidation into sUSDe,
  and sUSDe→USDT to repay USDT.
- Aave USDtb flash needs USDtb liquidation, sUSDe→USDT monetization and an
  additional USDT→USDtb conversion to repay USDtb. This leg is unresolved.

Both variants remain BLOCKED because there is no real trigger, direct
capital/executable callback proof, complete quoted routes, externally
underwritten nonrecourse gas, builder terms or competition survival.
None of these observations is NQC revenue, live transaction evidence or
shadow-certified prospectively collected data.

## Verify offline

```bash
python3 -m unittest discover -s ci/nqc-census/rmc-v2-economics -p 'test_driver_gate.py' -v
python3 ci/nqc-census/rmc-v2-economics/driver_gate.py \
  --input ci/nqc-census/rmc-v2-economics/fixtures/ethereum-26184415-research-only.json \
  --out /tmp/rmc-v2-block26184415-negative.json
```

Output includes an SHA-256 commitment to the input JSON for reproducibility.
No external state or provider commitments are authenticated by that hash.

## Status

PFT CLOSED (inherited). RMC OPEN. D11–D17 terminal authorization incomplete.
P2/Shadow not certified. Commercial 5.9 (unchanged). Realized NQC P&L USD 0.
