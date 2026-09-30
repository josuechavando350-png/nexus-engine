# RMC-013 — Execution Economics and Capture Truth Contract

## Authority

RMC-013 is stacked on RMC-012. RMC-012 proves capital/resource consistency and
prevents double counting. RMC-013 attaches exact execution economics to one
deterministic portfolio candidate without claiming that an uncalibrated capture
model is empirical truth.

## Mission

For every candidate/size/route observation, preserve an exact and
content-addressed decomposition:

```
gross value
- protocol fees
- capital fees
- swap fees
- price impact
- gas
- priority fee
- builder payment
- financing
- hedging
- inventory
- failure/revert reserve
- opportunity cost
- chain-specific cost
= pre-capture net value
```

Then, only when capture probability is empirically calibrated and
evidence-bound, derive a conservative capture-adjusted value with exact integer
arithmetic.

## Exact arithmetic

- Monetary/value amounts are uint256.
- Capture probability is WAD fixed point: integer in [0, 1e18].
- Floating point is forbidden.
- Multiplication by probability is floor-conservative and must not overflow.
- Every cost vector is checked for uint256 overflow.
- Negative net values are represented explicitly; unsigned underflow is never
  interpreted as zero.

## Valuation unit

Every quote declares a deterministic valuation-unit commitment. Gross value and
every cost component in one quote MUST use that exact unit.

RMC-013 does not assume USD. A later producer may use USD-1e18, a settlement
asset, native gas, or another canonical unit, but the conversion/oracle evidence
must be outside the commitment that identifies that unit and must be bound by
the quote evidence.

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

## Capture calibration

A capture model is either:

- UNCALIBRATED; or
- EMPIRICAL, with exact WAD probability, non-zero sample count, observation
  window commitment, model commitment and evidence commitment.

UNCALIBRATED quotes may report pre-capture economics but MUST NOT emit a
capture-adjusted profitability claim.

The capture probability is not allowed to default to 1.

## Capacity curve

Multiple trade sizes for the same execution variant form a capacity curve.

The curve MUST:

- bind one candidate id, anchor and valuation unit;
- use strictly increasing trade size;
- preserve every point, including negative-net points;
- never extrapolate beyond observed/simulated points;
- select a best point only from empirically calibrated, positive
  capture-adjusted points.

This prevents linear extrapolation of one profitable size into fictitious
capacity.

## Scenario risk

RMC-013 supports exact probability-weighted P&L scenarios. Scenario
probabilities MUST sum to exactly 1e18 and every scenario must carry evidence.

The initial risk primitive is intentionally conservative:

- signed expected P&L using floor-conservative probability weighting;
- worst-case P&L;
- explicit probability of loss.

Shadow may add richer empirical distributions/CVaR after observed outcomes
exist. RMC-013 MUST NOT fabricate a distribution to satisfy a target.

## Rejection boundary

A quote is classified fail-closed:

- NON_POSITIVE_PRE_CAPTURE_NET
- CAPTURE_UNCALIBRATED
- NON_POSITIVE_CAPTURE_ADJUSTED_NET
- ADMITTED

A target such as $1,500–$3,000/day or $45,000/month is never used to modify a
cost, probability or rejection result.

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
- anchor;
- trade size;
- valuation unit;
- gross value;
- full cost vector;
- pre-capture net;
- capture calibration;
- capture-adjusted net;
- model/evidence commitments.

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
