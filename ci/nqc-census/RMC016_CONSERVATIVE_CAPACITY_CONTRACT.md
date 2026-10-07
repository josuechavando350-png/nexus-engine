# RMC-016 — Conservative Realizable Capacity Contract

## Mission

RMC-016 converts authenticated RMC-015B temporal opportunities into a conservative,
non-double-counted physical/economic capacity lower bound suitable for Shadow.

It MUST NOT invent capture probability, claim unobserved private-flow advantage,
or extrapolate a short observation window into a month.

## Temporal conflict rule

A shared resource is a conflict only while candidate execution intervals overlap.
Reusing the same flash source, DEX venue or gas source hours later is not itself
contention.

Every opportunity binds a closed execution interval in canonical ordering and a
set of resource claims. Capacity is solved over those intervals, not over a
timeless static conflict graph.

## Required conflict/resource domains

At minimum the model must support:

- OPPORTUNITY_LINEAGE — mutually exclusive variants of one economic opportunity;
- BORROWER_POSITION — unchanged borrower pre-state cannot be consumed twice;
- FLASH_CAPITAL — exact source capacity;
- DEX_LIQUIDITY — exact admitted route/liquidity capacity;
- BLOCK_BUILDER_SLOT — mutually exclusive inclusion slot;
- ORACLE_MOVE — shared trigger lineage;
- GAS_FUNDING — exact external gas-funding capacity;
- PROTOCOL_MARKET_CAP — protocol/market cap constraints;
- ROUTE_VARIANT — mutually exclusive variants of one candidate.

No resource identity may be inferred from display labels; stable content-addressed
keys are required.

## Optimization

For small contention components, exact branch-and-bound is required and must be
differential-tested against brute force.

For components beyond the exact-solver bound, a deterministic feasible lower
bound may be emitted. In that mode:

global_optimum_claimed = false

The lower bound must satisfy every resource/time constraint. It may be
conservative; it may not be optimistic.

## Time-window boundary

Monthly capacity requires a complete declared monthly observation window. A
7-day sample multiplied by 30/7 is forbidden.

If the authenticated temporal window is shorter than the requested reporting
window, RMC-016 reports only the observed-window statistic and an explicit
INSUFFICIENT_TEMPORAL_WINDOW blocker for the longer horizon.

## Capture boundary

Before Shadow calibration:

capture_probability = UNCALIBRATED
capture_adjusted_capacity_claimed = false

RMC-016 may report conservative physical/economic success-path capacity and the
Shadow-eligible set. It must not turn that into expected realized capture P&L.

## Terminal admission

RMC016_CONSERVATIVE_REALIZABLE_CAPACITY_PASS requires:

- exact authenticated RMC-015B temporal opportunity authority;
- every Shadow-eligible temporal opportunity covered;
- zero UNKNOWN terminal exclusions;
- no resource/time double counting;
- exact-solver differential tests passing for the exact domain;
- deterministic order-independent results;
- conservative_realizable_capacity_only = true;
- global_market_maximum_claimed = false;
- capture_adjusted_capacity_claimed = false unless later empirical Shadow
  authority is explicitly bound.

Foundation tests are not terminal authority.
