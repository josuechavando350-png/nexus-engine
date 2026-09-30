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

The output must distinguish gross value, cost incidence, capture uncertainty,
tail reserve and final expected value.

## Exact arithmetic

No floating point is permitted.

Amounts use uint256. Probabilities use integer parts-per-billion in [0, 1e9].
Multiplication/division uses a full 512-bit intermediate and fails closed if the
final uint256 value overflows.

Gas valuation uses floor(gas_used * effective_gas_price_wei *
native_usd_wad / 1e18) with exact integer arithmetic.

## Complete cost taxonomy and incidence

Every quote carries exactly one evidence-bound component for each mandatory
cost category:

- protocol fee;
- capital fee;
- swap fee;
- price impact;
- gas;
- priority fee;
- builder payment;
- financing;
- hedging;
- inventory;
- expected failure/revert;
- opportunity cost;
- MEV;
- chain-specific cost.

A category may be zero, but it may not be omitted.

Each category separately records:

- unconditional cost;
- cost conditional on capture;
- cost conditional on failure/non-capture;
- evidence commitment.

This is required because p * (gross - all costs) is generally wrong.
For capture probability p, RMC-013 computes:

    expected value =
      p * gross
      - unconditional_costs
      - p * capture_only_costs
      - (1-p) * failure_only_costs

No cost is silently moved between incidences to improve reported EV.

## Capture calibration

A capture estimate is an ordered interval (lower, point, upper) plus one of:

- PriorOnly: permitted for ex-ante Shadow prediction, never for certified
  capture profitability;
- ShadowCalibrated: requires a non-zero empirical sample count plus explicit
  observation-window, model and calibration commitments.

certified_expected_realized_ev fails closed unless capture evidence is
Shadow-calibrated.

The conservative interval bound evaluates both probability endpoints. Expected
value is affine in capture probability, so the minimum over an interval occurs
at an endpoint; RMC-013 MUST NOT assume that lower capture probability is always
the worse endpoint.

## Tail risk

Every quote carries an explicit tail-risk bound:

- confidence;
- loss at that confidence;
- absolute maximum modeled loss;
- explicit reserve.

The reserve is evidence/model input, not a hidden coefficient.
Loss-at-confidence and reserve may not exceed the absolute maximum.

The default admission value is the conservative capture-interval lower bound
minus the explicit tail reserve.

## Scenario risk

RMC-013 also supports explicit discrete P&L scenarios.

- scenario probabilities must sum exactly to 1e9;
- every scenario has an id and evidence commitment;
- expected P&L uses exact signed probability weighting;
- worst-case P&L is preserved;
- loss probability is explicit.

The engine does not fabricate scenarios or a distribution to satisfy a target.
Shadow may replace prior scenarios with empirical distributions and later add
richer CVaR/quantile estimators.

## Capacity curves

A capacity curve is an ordered set of trade-size points for exactly one:

- RMC-012 candidate id;
- opportunity id;
- StateAnchor;
- valuation unit;
- execution-plan commitment;
- economics-model commitment.

Trade size is included in the quote commitment itself. A curve point whose
external size differs from the committed quote size is rejected.

Trade sizes must be strictly increasing. No interpolation or extrapolation is
treated as evidence. RMC-013 selects the best positive conservative
tail-adjusted point by value, not the largest nominal trade, and reports the
largest observed size that remains positive.

This prevents linear extrapolation of P&L through slippage, capital, gas or MEV
capacity limits.

## Candidate variants

RMC-012 candidate identity is distinct from capital-requirement identity.
RMC-013 therefore supports multiple routes, venues and execution plans for the
same capital requirement without treating them as the same candidate.

A single capacity curve may not mix those variants.

## Profit buckets

Profit buckets are calculated only for USD-WAD normalized conservative
tail-adjusted EV:

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

## Fail-closed decision boundary

A quote is classified as exactly one of:

- NonPositiveSuccessNet;
- CaptureUncalibrated;
- NonPositiveTailAdjustedNet;
- Admitted.

The target $1,500–$3,000/day or $45,000/month is never used to alter a cost,
capture estimate, tail reserve or decision.

## Multichain invariant

The exact StateAnchor includes chain identity. Economics is not allowed to
assume Ethereum is superior. Chain-specific gas, MEV, liquidity and capture
evidence determine whether an opportunity survives.

The same contract must support Ethereum, Base, Arbitrum, Optimism, Polygon,
Avalanche, BNB Chain, Monad and later admitted chains without redefining the
economic arithmetic.

## Shadow handoff

RMC-013 emits deterministic ex-ante commitments before the outcome is known.
Each commitment binds candidate, opportunity, anchor, trade size, valuation
unit, gross value, every cost component and incidence, capture interval and
calibration state, tail bound, execution plan, model and evidence.

Shadow Execution later binds that commitment to the observed winning
transaction, route, gas and fees, inclusion latency, competitor outcome,
capture result, net value and prediction error.

No hindsight-derived opportunity may be presented as an ex-ante prediction.

## Non-claims

RMC-013 does not prove realized P&L, live transaction inclusion, future
stationarity of capture probability, a particular monthly income, that
$1,500–$3,000/day exists, or that P(monthly net P&L >= $45,000) >= 0.90.

Those are empirical targets to falsify with Shadow, Canary and real P&L
evidence.
