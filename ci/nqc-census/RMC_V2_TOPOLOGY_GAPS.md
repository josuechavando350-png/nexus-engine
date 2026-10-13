# RMC-011 V2 — topology-derived source universe (research, not authority)

This is a strict **NO EXECUTION / NO D11-CLOSURE** contract. It expands the
existing D11 13-family inventory to cover two actual *candidate topologies*
without fabricating available capital or resolved venues.

Upstream D11 source head: `3b23804a46bfcc730d57784fb95a349e6e6e726b`.
The existing `rmc011-capital-source-universe.json` and
`capital-census-scope.json` are read, never silently edited.

## Registered paths

1. TOPOLOGY-V2-001: Morpho flash **USDT**, Curve USDT→USDC,
   unresolved USDC→USDtb acquisition, Aave liquidation USDtb→sUSDe,
   Fluid sUSDe→USDT, then Morpho **USDT** repayment. Morpho upstream
   commit `8e26ca6a8dbc5089edcd67fb576248810fd2870a`
   `Morpho.sol` shows flash principal transfer, `onMorphoFlashLoan`
   callback and `transferFrom` repayment of the same amount; deploy and
   call compatibility must still be verified against exact trigger block.
2. TOPOLOGY-V2-002: Aave flash **USDtb**, Aave liquidation USDtb→sUSDe,
   Fluid sUSDe→USDT, unresolved USDT→USDtb reacquisition, then Aave
   repayment USDtb + dynamic premium. Treating post-Fluid USDT as USDtb
   is an invalid shortcut; no conversion quote is established.

Every route retains gas-source and builder unknowns, and requires
`OWN_CAPITAL=0` including gas/collateral and contingent recourse.

## Current D11 delta

Required source families derived from topology: `AAVE_V3_FLASH_LOAN`,
`MORPHO_BLUE_FLASH_LOAN`, `EXTERNAL_GAS_SPONSOR`.

The canonical 13-family D11 source/scope documents do **not** include
`MORPHO_BLUE_FLASH_LOAN`; the validator reports it as a missing family.
Adding the string alone is **not** evidence of real liquidity, callback
compatibility, executable capital or commitment.

Venues derivable from actual steps: `CURVE_3POOL_USDT_USDC`,
`AAVE_V3_LIQUIDATION`, `FLUID_SUSDE_USDT`. The two USDtb acquisition
requirements have no verified pool/venue, so **are not counted as real venues**.

## Run offline

```bash
python3 -m unittest discover -s ci/nqc-census -p 'test_rmc011_execution_topologies_v2.py' -v
python3 ci/nqc-census/verify_rmc011_execution_topologies_v2.py \
  --catalog ci/nqc-census/rmc011-execution-topologies-v2-research.json \
  --scope ci/nqc-census/capital-census-scope.json \
  --universe ci/nqc-census/rmc011-capital-source-universe.json \
  --out /tmp/rmc-v2-topology-gaps.json
```

This preflight fails on missing/reordered route legs, swapped lender
assets, hidden USDtb conversions, forged gas/competition/capture, altered
D11 scope and contaminated opportunity IDs.

**Nonclaims:** D11 OPEN, D17 OPEN, P2 Shadow not certified, no prospectively
observed HF<1 crossing, no principal or gas sponsor admitted, no fork/live
execution, no profit attribution and realized NQC P&L USD 0.

Next: add Morpho to D11 family discovery with authenticated state source;
bind quote/proof evidence to the exact trigger block, calldata/callback and
repayment; retain the existing D11 closeout locks until upstream is reissued.
