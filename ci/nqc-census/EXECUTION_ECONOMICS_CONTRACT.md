# RMC-013 — Execution Economics and Capture Truth Contract

## Authority

RMC-013 is downstream of RMC-011 capital truth and RMC-012 portfolio-capacity
truth. It MUST NOT make an infeasible candidate profitable by changing capital
or conflict assumptions.

RMC-013 is predictive economics, not realized P&L.

## Mission

For every explicit execution candidate and trade size, bind one exact economic
prediction to the exact StateAnchor and chain domain, RMC-012 candidate id,
underlying opportunity id, execution-plan commitment, economics-model
commitment, evidence digests, and one common valuation unit.

The output must distinguish gross value, success-path costs, loss-path costs,
capture probability, tail reserve and final expected value.

## Exact arithmetic

No floating point is permitted.

Amounts use uint256. Probabilities use integer parts-per-billion in [0, 1e9].
Multiplication/division uses a full 512-bit intermediate and fails closed if the
final uint256 value overflows.

Gas valuation uses floor(gas_used * effective_gas_price_wei *
native_usd_wad / 1e18) with exact integer arithmetic.

## Success-path cost vector

The success-path vector includes independent fields for protocol fee, capital
fee, swap fee, price impact, gas, priority fee, builder payment, financing,
hedging, inventory, opportunity cost, MEV and other chain-specific cost.

Conditional loss/revert cost is NOT hidden in that vector. It is represented
separately as failure_cost_if_lost, preventing double counting.

## Expected realized EV

Let S = gross_value - success_costs, p = point capture probability, and L =
loss cost conditional on not capturing.

expected_realized_ev = p * S - (1 - p) * L

Probability scaling is integer-exact and rounded down.

A quote with negative success net is retained as evidence but cannot pass a
positive-success admission gate.

## Capture calibration

A capture estimate is an ordered interval (lower, point, upper) plus one of:

- PriorOnly: allowed for ex-ante Shadow predictions, but never a certified
  capture-rate claim.
- ShadowCalibrated: requires non-zero empirical sample count and a calibration
  commitment.

certified_expected_realized_ev MUST fail closed unless capture evidence is
Shadow-calibrated.

This prevents invented capture probabilities from becoming profitability
claims.

## Tail risk

Every quote carries an explicit tail-risk bound: confidence, loss at that
confidence, absolute maximum modeled loss and explicit reserve.

tail_adjusted_ev = expected_realized_ev - reserve.

The reserve is evidence/model input, not an implicit hidden risk coefficient.
Loss-at-confidence and reserve may not exceed the declared absolute maximum.

## Capacity curves

A capacity curve is an ordered set of trade-size points for one opportunity,
anchor, valuation unit and economics model.

Trade sizes must be strictly increasing. RMC-013 selects the best positive
tail-adjusted point by value, not the largest nominal trade, and reports the
largest size that remains positive.

This prevents linear extrapolation of P&L through slippage, capital, gas or MEV
capacity limits.

## Candidate variants

RMC-012 candidate identity is distinct from capital-requirement identity.
RMC-013 therefore supports multiple routes, venues and execution plans for the
same capital requirement without treating them as the same candidate.

Mutually exclusive variants remain constrained by RMC-012 shared-resource
claims.

## Profit buckets

Profit buckets are calculated only for USD-WAD normalized tail-adjusted EV:

- $0–$1
- $1–$3
- $3–$5
- $5–$10
- $10–$20
- $20–$50
- $50–$100
- $100–$500
- $500+

Asset-denominated values cannot be silently compared across markets or chains.

## Multichain invariant

The exact StateAnchor includes chain identity. Economics is not allowed to
assume Ethereum is superior. Chain-specific gas, MEV, liquidity and capture
evidence determine whether an opportunity survives.

The same contract must support Ethereum, Base, Arbitrum, Optimism, Polygon,
Avalanche, BNB Chain, Monad and later admitted chains without redefining the
economic arithmetic.

## Shadow handoff

RMC-013 must be able to emit deterministic ex-ante predictions before the
outcome is known. Shadow Execution later binds those prediction commitments to
the observed winning transaction, route, gas and fees, inclusion latency,
competitor outcome, capture result, net value and prediction error.

No hindsight-derived opportunity may be presented as an ex-ante prediction.

## Non-claims

RMC-013 does not prove realized P&L, live transaction inclusion, a particular
monthly income, that $1,500–$3,000/day exists, or that
P(monthly net P&L >= $45,000) >= 0.90.

Those are empirical targets to falsify with Shadow, Canary and real P&L
evidence.
