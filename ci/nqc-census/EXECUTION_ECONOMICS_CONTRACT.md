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

Gas cost conversion is exact. Gas-price evidence MUST be a non-zero
content-addressed commitment. For an anchor-pinned native/USD WAD price:

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

## Candidate and anchor binding

Every execution quote consumes the concrete RMC-012 candidate, not a detached
candidate id supplied by the caller. The quote anchor MUST equal the
candidate's exact `StateAnchor`; a candidate id from one block/chain cannot be
reused with economics observed at another anchor.

Opportunity, execution-plan and economic-model commitments remain independent
non-zero bindings. Changing any one of them changes the quote commitment.

## Capacity curve

Multiple trade sizes for the same execution variant form a capacity curve.
Multiple execution variants for one candidate remain distinct and MUST NOT be
collapsed into a fictitious single curve point. A materialized candidate record
therefore separates `variants` from each variant's measured size curve.

The curve MUST:

- bind one candidate id, anchor and valuation unit;
- bind one opportunity id, execution-plan commitment and economic-model commitment;
- use strictly increasing trade size;
- preserve every point, including negative-net points;
- never extrapolate beyond observed/simulated points;
- expose two distinct selectors:
  - calibrated admission: best point whose interval-worst, tail-adjusted EV is
    positive;
  - pre-capture Shadow handoff: best explicitly measured point whose
    success-path net remains positive, with no capture probability invented;
- report the largest explicitly measured calibrated-positive size without
  extrapolating beyond it.

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
MUST be at least the declared loss at confidence and MUST NOT exceed the
declared absolute maximum. It is subtracted after the capture-interval worst
case.

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

RMC-013 MUST be able to hand an opportunity to Shadow without fabricating a
capture probability. A capacity curve with at least one positive success-path
net point is Shadow-eligible even when every quote is UNCALIBRATED.

For that boundary the engine deterministically selects the explicitly measured
point with the greatest positive success-path net; ties select the smaller
trade size. No interpolation or extrapolation is permitted.

Every Shadow prediction commitment binds at least:

- candidate id and opportunity id;
- exact StateAnchor;
- capacity-curve commitment and selected quote commitment;
- execution-plan commitment;
- economic-model commitment;
- selected trade size;
- gross value;
- exact success-path cost and net;
- an expiry block strictly after the observation anchor;
- evidence commitments.

A batch commitment binds the complete ordered set of Shadow predictions and
rejects duplicate candidate identity. Candidates with no positive pre-capture
point are not silently counted as Shadow-eligible.

Capture interval, capture-adjusted net and tail-adjusted expected net remain
attached to the underlying quote when empirical calibration exists, but they
are NOT prerequisites for the initial Census -> Shadow handoff. Requiring them
would create a circular dependency because Shadow is the authority that
calibrates capture probability.

The opportunity id, execution-plan commitment and economic-model commitment
are mandatory, non-zero authority. Two otherwise identical quotes that change
only one of those commitments MUST produce a different quote commitment.

Shadow compares these ex-ante commitments with later observed outcomes. It may
not reconstruct a prediction after seeing the winner.

## Non-claims

RMC-013 does not prove:

- live transaction inclusion;
- realized P&L;
- future stationarity of capture probability;
- optimal portfolio scheduling across time;
- Canary safety.

Those require Shadow/Canary evidence.

## Terminal authority

The foundation crate and its unit tests are not terminal RMC-013 evidence.
Terminal RMC-013 is controlled by `ci/nqc-census/rmc013-terminal-inputs.json`
and remains blocked until it pins both:

- one exact successful immutable RMC-012 terminal actionability artifact; and
- one exact successful content-addressed execution-evidence package produced
  from the same candidate/anchor authority.

A terminal execution-evidence package MUST conserve the complete D12
capital-feasible input set. Every input candidate is either:

- execution-simulatable and covered by exact economics; or
- rejected with an explicit non-UNKNOWN reason.

The package MUST bind, for every execution-simulatable candidate, measured or
simulated points sufficient to prove the complete cost taxonomy, gas evidence,
route/fee/price-impact evidence where applicable, exact size points and an
ex-ante Shadow prediction commitment. It MUST NOT interpolate or extrapolate
between points and MUST NOT invent capture probability. Capture may remain
`UNCALIBRATED` at Census close.

Terminal conservation is therefore:

```
D12 capital-feasible candidates
  = execution-simulatable candidates
  + explicitly rejected execution candidates
```

and:

```
execution-simulatable candidates
  = exact economics candidate coverage

Economics candidate coverage and quote/variant coverage are distinct
cardinalities. A candidate may expose multiple independently simulated
execution variants at the same or different measured sizes. Therefore:

```
economics_candidate_count = unique candidate ids with >=1 exact quote
economics_quote_count = exact execution quote rows
execution_variant_count = exact distinct execution-plan/route variants
economics_quote_count >= economics_candidate_count
```

No terminal verifier may force one candidate = one quote. Every emitted quote
must bind one concrete execution variant; every capacity-curve row must group
only variants/points for one exact candidate without collapsing distinct route
evidence.
```

with zero UNKNOWN rejections, zero unexplained mismatches and zero uncovered
candidate ids. Synthetic fixtures, detached candidate ids, mutable latest
artifacts, hand-entered P&L and foundation-only CI MUST NOT satisfy this gate.

### Zero-own-capital gas closure

RMC-012 intentionally leaves gas funding uncertified because exact gas belongs
to a concrete execution plan. RMC-013 is therefore the first stage allowed to
close that remaining capital obligation, but it may do so only by reusing the
exact D11 capital-source authority referenced by the authenticated D12
certificate.

For every execution-simulatable candidate, terminal RMC-013 MUST bind the
measured/simulated gas requirement to an eligible external gas-funding source
or reject the candidate. Flash principal available only after EVM execution
MUST NOT be counted as transaction gas funding. Operator-owned ETH or any other
operator-owned prefund is forbidden by the `OWN_CAPITAL = 0` constraint.

If terminal RMC-013 reports any execution-simulatable candidate, it MUST prove:

- gas-funding candidate count equals execution-simulatable candidate count;
- operator-owned gas-funding count is zero;
- external gas funding is evidence-bound at the same execution authority; and
- `zero_own_capital_proven=true` for the resulting executable candidate set.

Without that proof, the candidate remains non-executable for terminal Census
purposes even if its flash principal, route and nominal P&L are otherwise
positive.

### Gas-funding binding artifact

Terminal execution evidence MUST include `gas-funding-bindings.jsonl`, with
exactly one row per execution-simulatable candidate. Each row binds:

- `candidate_id`;
- `required_native_gas_amount` as canonical uint256 hex;
- a non-empty `allocations` array of exact D11 `source_id` plus uint256
  `amount`;
- non-empty evidence commitments.

The terminal verifier independently re-downloads the exact D11 package carried
by the authenticated D12 certificate and refuses any gas allocation unless the
referenced D11 source is `GAS_FUNDING`, denominated in `NATIVE_GAS`,
non-operator-owned, execution-eligible, blocker-free and anchored to the exact
D12 state anchor. Per candidate, allocated gas MUST equal the exact declared gas requirement and
each allocation MUST be individually bounded by the referenced source's exact
D11 `executable_capacity`.

RMC-013 MUST NOT sum gas allocations across mutually exclusive future
opportunities as if all candidates execute simultaneously. Doing so converts a
shared-source contention problem into a false capital shortage and can
materially understate executable capacity. Instead, RMC-013 emits deterministic
shared gas-source claims for every candidate/source pair. Reuse of one source
by multiple candidates becomes an explicit conflict resource for portfolio and
temporal scheduling in RMC-012/RMC-016.

The candidate set in `gas-funding-bindings.jsonl` MUST equal the unique
candidate set in `execution-economics.jsonl`. Quote rows may exceed candidate
rows because one candidate may retain multiple exact execution variants.
This prevents an economically positive quote from becoming Shadow-eligible
while silently relying on unfunded transaction gas, without pretending
mutually exclusive opportunities consume shared gas capacity concurrently.
