# RMC-013 — Execution Economics and Capture Truth Contract

## Authority

RMC-013 is stacked on RMC-012. RMC-012 proves capital/resource consistency and
prevents double counting. RMC-013 attaches exact execution economics to one
deterministic portfolio candidate without claiming that an uncalibrated capture
model is empirical truth.

## Mission

For every candidate/size/route observation, preserve an exact and
content-addressed decomposition of gross value and the complete cost taxonomy.

Every cost category is split by incidence:

- unconditional: incurred whether the opportunity is captured or not;
- on-capture: incurred only when capture succeeds;
- on-failure: incurred only when capture fails.

The economics engine MUST NOT use the shortcut `p × (gross - all_costs)`,
because gas, builder payments, protocol fees, revert costs and financing do not
necessarily share the same incidence.

Only when capture probability is Shadow-calibrated and evidence-bound may the
engine derive a capture-adjusted value. Admission uses the worst expected value
over the calibrated capture interval and then subtracts an explicit tail
reserve.

## Exact arithmetic

- Monetary/value amounts are uint256.
- Capture probability is WAD fixed point: integer in [0, 1e18].
- Floating point is forbidden.
- Positive/gross probability weighting rounds down.
- Cost and loss probability weighting rounds up so integer rounding can never
  make a quote more profitable.
- Full-width cross-asset valuation uses an exact 512-bit intermediate and
  rejects a uint256 result overflow rather than truncating.
- Every cost vector is checked for uint256 overflow.
- Negative net values are represented explicitly; unsigned underflow is never
  interpreted as zero.

## Valuation unit

Every quote declares a deterministic valuation-unit commitment. Gross value and
every cost component in one quote MUST use that exact unit.

RMC-013 does not force every quote into USD. A producer may use the canonical
USD-WAD unit, a settlement asset, native gas, or another committed unit, but
all conversion/oracle evidence must be bound by the quote.

Cross-market profit buckets are legal only in the canonical USD-WAD valuation
unit. Asset-denominated values may not be silently compared across markets or
chains.

## Cost taxonomy

At minimum the model distinguishes:

- PROTOCOL_FEE
- CAPITAL_FEE
- SWAP_FEE
- PRICE_IMPACT
- GAS
- PRIORITY_FEE
- BUILDER_PAYMENT
- FINANCING
- HEDGING
- INVENTORY
- EXPECTED_FAILURE_REVERT
- OPPORTUNITY_COST
- MEV
- CHAIN_SPECIFIC

No component may be silently folded into another category merely to make the
reported net value look better.

## Gas valuation

Gas cost conversion is exact. For an anchor-pinned native/USD WAD price:

`gas_usd_wad = floor(gas_used × effective_gas_price_wei × native_usd_wad / 1e18)`.

The multiplication uses full-width integer arithmetic. Gas price, gas used and
native/USD conversion evidence remain explicit; gas is never hidden inside a
generic slippage or MEV coefficient.

## Capture calibration

A capture model is either:

- UNCALIBRATED; or
- SHADOW_CALIBRATED with ordered `lower <= point <= upper` WAD probabilities,
  non-zero sample count, observation-window commitment, model commitment and
  evidence commitment.

A point estimate alone is not admission authority. Because expected net is
affine in capture probability for a fixed incidence vector, RMC-013 evaluates
both interval endpoints and uses the worse endpoint exactly.

UNCALIBRATED quotes may report pre-capture economics but MUST NOT emit a
capture-adjusted profitability claim. Capture probability is never allowed to
default to 1.

## Capacity curve

Multiple trade sizes for the same execution variant form a capacity curve.

The curve MUST:

- bind one candidate id, anchor and valuation unit;
- use strictly increasing trade size;
- preserve every point, including negative-net points;
- never extrapolate beyond observed/simulated points;
- select a best point only from Shadow-calibrated points whose interval-worst,
  tail-adjusted EV remains positive;
- report the largest explicitly measured positive size without extrapolating
  beyond it.

This prevents linear extrapolation of one profitable size into fictitious
capacity.

## Scenario risk

RMC-013 supports exact probability-weighted P&L scenarios. Scenario
probabilities MUST sum to exactly 1e18 and every scenario must carry evidence.

The initial risk primitive is intentionally conservative:

- positive scenario P&L is probability-weighted with floor rounding;
- negative scenario P&L is probability-weighted with ceil rounding;
- worst-case P&L;
- explicit probability of loss;
- duplicate scenario evidence is rejected.

Each quote also carries an explicit tail bound: confidence, loss at that
confidence, absolute maximum modeled loss, reserve and evidence. The reserve
may not exceed the declared absolute maximum and is subtracted after the
capture-interval worst case.

Shadow may add richer empirical distributions/CVaR after observed outcomes
exist. RMC-013 MUST NOT fabricate a distribution to satisfy a target.

## Rejection boundary

A quote is classified fail-closed:

- NON_POSITIVE_PRE_CAPTURE_NET
- CAPTURE_UNCALIBRATED
- NON_POSITIVE_CAPTURE_ADJUSTED_NET
- NON_POSITIVE_TAIL_ADJUSTED_NET
- ADMITTED

A target such as $1,500–$3,000/day or $45,000/month is never used to modify a
cost, probability or rejection result.

## Profit buckets

Only positive tail-adjusted values in canonical USD-WAD may enter the Census
profit buckets:

- $0–$1
- $1–$3
- $3–$5
- $5–$10
- $10–$20
- $20–$50
- $50–$100
- $100–$500
- $500+

A bucket is reporting metadata, never an admission override.

## Multichain

Candidate identity comes from RMC-012, whose resource identity contains chain
domain. RMC-013 is therefore chain-agnostic while every quote remains bound to
the exact candidate and StateAnchor.

No chain is ranked by TVL. Later ranking consumes measured net economics,
capture calibration and capacity.

## Shadow handoff

Every admitted prediction must be serializable into a deterministic commitment
containing at least:

- candidate id;
- opportunity id;
- execution-plan commitment;
- economic-model commitment;
- anchor;
- trade size;
- valuation unit;
- gross value;
- full cost vector;
- pre-capture net;
- capture interval and calibration authority;
- point capture-adjusted net;
- interval-worst expected net;
- explicit tail bound and tail-adjusted net;
- model/evidence commitments.

The opportunity id, execution-plan commitment and economic-model commitment
are mandatory, non-zero authority. Two otherwise identical quotes that change
only one of those commitments MUST produce a different quote commitment.

Shadow compares those ex-ante commitments with later observed outcomes. It may
not reconstruct a prediction after seeing the winner.

## Non-claims

RMC-013 does not prove:

- live transaction inclusion;
- realized P&L;
- future stationarity of capture probability;
- optimal portfolio scheduling across time;
- Canary safety.

Those require Shadow/Canary evidence.
