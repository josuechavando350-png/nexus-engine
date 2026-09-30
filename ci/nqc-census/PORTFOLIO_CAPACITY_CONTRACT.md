# RMC-012 — Portfolio Capacity and Conflict Contract

## Authority

RMC-012 is stacked on RMC-011 Capital Census. RMC-011 proves whether each
capital requirement is feasible in isolation. RMC-012 exists because isolated
feasibility is not portfolio feasibility.

The layer MUST prevent double counting caused by candidates that share:
- the same capital source;
- the same borrower/position;
- the same market or protocol cap;
- the same debt/collateral resource;
- the same flash pool;
- the same DEX liquidity;
- the same oracle movement;
- the same block/builder slot;
- any later domain-specific scarce resource.

## Mission

Given explicit candidate requirements, RMC-011 feasibility results, exact
capital-source states, and block-pinned shared-resource observations, produce a
deterministic proof of whether the candidate set is simultaneously feasible.
RMC-012 MUST independently recompute every supplied RMC-011 feasibility result
from the exact requirement and source states and require byte/semantic equality;
caller-supplied `FEASIBLE` or rejection labels are not authority.

This layer is value-agnostic. It MUST NOT select a portfolio by guessed profit.
Selection/ranking belongs downstream after net-EV, capture probability and
tail-risk evidence exist.

## Identity

Every shared resource has two identities:
- stable key id: chain domain + resource kind + canonical locator + unit;
- observed resource id: stable key + exact state anchor + observed limit +
  evidence.

A changing capacity MUST change the observed id without changing the stable key.
Identical locators on distinct chain domains MUST never alias.

## Candidate identity

Portfolio candidate identity is separate from capital-requirement identity. A single certified capital requirement may have multiple deterministic execution variants. Each variant is bound to the requirement plus an execution-variant commitment.

Execution variants that share one certified capital requirement are implicitly
exclusive with unit capacity one. RMC-012 creates that conflict itself; a
caller cannot omit it. An explicit EXCLUSIVE `Opportunity` shared resource is
still required when distinct capital requirements represent alternatives for
the same economic opportunity. Route enumeration therefore cannot multiply
portfolio capacity through either same-requirement variants or separately
sized/encoded requirements.

## Exact capacity rules

All resource amounts use exact uint256 arithmetic. No floating point is
permitted.

Capital allocations are aggregated by RMC-011 stable capital-source key.
Individually feasible candidates that jointly exceed one source's executable
capacity MUST create a conflict set. A feasibility record that does not equal
fresh RMC-011 recomputation on the supplied source state MUST fail before any
portfolio-capacity claim is emitted.

Shared resources support:
- EXCLUSIVE: exact capacity one; each claim must be exactly one;
- CAPACITY: exact integer capacity in the resource's declared unit.

Every shared resource used in a real portfolio MUST carry evidence and be pinned
to the same StateAnchor as the requirement that claims it.

## Fail-closed rules

The evaluator MUST fail closed on:
- duplicate candidate ids;
- any attempt to count multiple execution variants of one capital requirement
  as additive capacity;
- duplicate requirements or feasibility results;
- a feasibility result that differs from exact RMC-011 recomputation;
- failure to recompute RMC-011 feasibility from the supplied requirement/source state;
- unknown capital sources;
- conflicting observed states for one stable capital-source key;
- unknown shared resources;
- conflicting observed states for one shared-resource key;
- candidate/requirement anchor mismatch;
- resource/requirement anchor mismatch;
- operator-owned capital allocation;
- amount overflow;
- malformed exclusive claims.

A capital-rejected candidate is preserved explicitly in the portfolio report;
it is never silently dropped.

## Conflict-set output

For every over-subscribed resource, the report MUST include:
- canonical resource identity;
- exact capacity;
- exact aggregate claim;
- deterministically ordered claimant candidate ids.

The report commitment MUST be independent of input ordering and MUST bind
the full evaluated candidate set, exact capital-source observation ids, exact
shared-resource observation ids, candidate claims, and feasibility outcomes.
A conflict-free report is not allowed to collapse to a count-only commitment.

The engine MUST also emit deterministic contention components. Two candidates
belong to the same component whenever they share a capital requirement,
capital-source key, or shared-resource key. Components with no edge between them are independent and
may be solved in parallel by downstream portfolio optimization. Construction
must be near-linear in claims (union-find / equivalent), rather than an
all-pairs O(n^2) scan, so millions of positions remain tractable.

## Multichain invariant

Chain identity is part of every shared-resource key. Ethereum, Base, Arbitrum,
Avalanche, BSC, Polygon, Monad, or any later admitted chain can therefore use
the same engine without accidental cross-chain aliasing.

No chain is assumed economically superior. Chain admission, live state,
execution cost, MEV, liquidity, and capture evidence decide whether its
opportunities survive downstream gates.

## Non-claims

RMC-012 does not prove:
- positive gross or net EV;
- capture probability;
- route execution quality;
- MEV inclusion;
- realized P&L;
- optimal portfolio selection.

It proves only simultaneous resource/capital consistency for the explicit
candidate set.
