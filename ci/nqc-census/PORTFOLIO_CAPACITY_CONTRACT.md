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

## Actionability boundary

RMC-009 intentionally does not certify liquidatability. RMC-012 therefore owns
the next exact boundary: every below-one borrower and every enumerated
collateral/debt position pair must be conserved as either one PFT-sized
actionable liquidation or one explicit rejection.

The protocol-agnostic core records:
- a stable pair key that survives block changes;
- an observation-specific pair id bound to the complete StateAnchor;
- borrower, collateral/debt assets and reserve ids;
- exact debt-to-liquidate and collateral-to-liquidator integers;
- exact liquidation protocol fee, flash premium and repayment;
- exact oracle collateral/repayment values and oracle edge;
- effective liquidation bonus;
- PFT market/account snapshot commitments;
- explicit rejection reason and evidence for every rejected pair.

Actionability coverage is fail-closed. The record count must equal the declared
pair universe, admitted + rejected must equal that same count, and every
below-one borrower must appear in at least one classified pair. Duplicate
pairs, duplicate candidate ids or mixed anchors are errors.

The concrete Aave adapter MUST execute the immutable recovered PFT liquidation
math for sizing and collateral accounting; it MUST NOT duplicate that integer
math. The recovered PFT opportunity implementation is an additional
equivalence check over the subset where its strategy policy applies. It is not
allowed to erase protocol-liquidatable pairs merely because that higher layer
requires flash-loan availability, a positive oracle edge or another economic
policy condition. Those belong to later capital/economics stages.

Synthetic actionability fixtures are foundation evidence only. Terminal
RMC-012 authority requires the isolated PFT bridge to consume exact admitted
RMC-006/RMC-008/RMC-009 bytes and prove its complete coverage commitment.

## Liquidation capital promotion boundary

RMC-011 deliberately imports the RMC-009 position universe with zero certified
liquidation requirements because RMC-009 does not prove liquidatability.
Therefore an admitted PFT liquidation MUST be promoted in RMC-012 into a new
capital requirement; no pre-existing RMC-011 requirement id may be invented or
reused for it.

For the Aave V3 protocol-native flash path, the promotion MUST bind:
- the exact actionable-candidate commitment as the capital target/evidence;
- debt-to-liquidate as `ACTION_PRINCIPAL`;
- the same principal as the exact `REPAYMENT` obligation;
- the PFT/D08-derived flash premium as `FUNDING_FEE` when non-zero;
- same-transaction atomicity;
- only `PROTOCOL_NATIVE_FLASH_LOAN` as an allowed class;
- the PFT market/account commitments as capital evidence.

The premium semantics are provider-specific. For the Aave V3 Pool, premium
rounding MUST follow certified PFT-COMPAT-009: positive fractional basis-point
fees use integer ceiling, never half-up. The exact measured witnesses
`83,727,306,811 @ 5 bps -> 41,863,654` and
`186,298,226 @ 5 bps -> 93,150` are terminal regressions. Feasibility MUST be
recomputed only against the exact Aave V3 Pool authenticated by RMC-008/D11,
with the matching debt asset, provider namespace, source contract, repayment
semantics, StateAnchor and canonical D11 source state. A different flash
provider is not interchangeable merely because it has the same capital class.

This promotion has scope
`PRINCIPAL_AND_FLASH_SETTLEMENT_ONLY_GAS_UNCERTIFIED`. It MUST set
`requires_native_gas=false` only because gas amount depends on the downstream
execution plan; this is not permission to assume free/operator-funded gas.
Every retained artifact MUST carry `gas_funding_certified=false` until D13
has an exact gas requirement and proves an external gas funding source. D14
MUST NOT interpret principal-only feasibility as full `OWN_CAPITAL=0`
execution feasibility.

Every admitted actionability candidate MUST produce exactly one capital
promotion record. The promoted count MUST equal the actionability admitted
count, and feasible + rejected promotions MUST equal that same count. Capital
rejections remain explicit; they do not retroactively erase protocol
actionability.

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
- CAPACITY: exact integer capacity in the resource's declared unit, including
  zero when the resource is observed but exhausted/unavailable at the anchor.

Zero capacity MUST remain an explicit observed state. It MUST NOT be collapsed
into absence. Any positive claim against a zero-capacity resource therefore
produces an exact over-subscription conflict with capacity zero.

Every shared resource used in a real portfolio MUST carry evidence and be pinned
to the same StateAnchor as the requirement that claims it.

Terminal Aave pre-state capacity is conservative by construction. Every admitted
liquidation MUST claim all three of the following before any concurrent-principal
capacity statement is allowed:

- one EXCLUSIVE borrower-prestate resource keyed by borrower identity and bound
  to the exact D09 account snapshot. Multiple liquidation candidates sized from
  the same borrower pre-state are alternatives until a later execution layer
  proves an explicit sequential state-transition composition;
- one debt-position CAPACITY resource keyed by borrower + debt asset + reserve
  id, with capacity equal to the exact D09 debt balance and claim equal to the
  PFT-sized debt-to-liquidate;
- one collateral-position CAPACITY resource keyed by borrower + collateral
  asset + reserve id, with capacity equal to the exact D09 collateral balance
  and claim equal to collateral-to-liquidator plus liquidation protocol fee.

The borrower exclusivity rule is intentionally conservative. RMC-012 MUST NOT
manufacture additive capacity by independently sizing multiple pairs against one
unchanged borrower snapshot. A later execution-composition proof may refine that
bound, but absence of such proof cannot increase capacity.

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

The report commitment (V4) MUST use explicit section counts/framing, be
independent of input ordering, and MUST bind the full evaluated candidate set,
exact capital-source observation ids, exact shared-resource observation ids,
candidate claims, feasibility outcomes, capital rejections, conflicts and
deterministic contention components.
A conflict-free report is not allowed to collapse to a count-only commitment.

Terminal evidence MUST also expose the complete shared-resource inventory and a
deterministically ordered candidate-claim ledger. Every promoted actionability
candidate must appear exactly once in that ledger, including candidates later
rejected by capital feasibility. The artifact must therefore permit an
independent auditor to recompute resource subscriptions and conflicts without
treating the in-process commitment as self-authenticating.

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

## Certified PFT actionability bridge

RMC-012 carries an isolated bridge at
`ci/nqc-census/rmc012-pft-actionability-bridge`. The bridge is outside the
Census workspace so the immutable recovered Protocol/Fork Truth dependency
graph is not absorbed into the Census core.

The bridge:

- pins PFT commit `5b4a0cb778cb4370cd54eb6fcba765dc8d7cecdf` and tree
  `ef3498da528f85cdb9fdd82222d64773a557f853`;
- verifies the recovered `nqc-aave-math` and `nqc-core` paths are byte-identical
  to that certified commit before testing;
- calls `max_liquidatable_debt` and
  `calculate_available_collateral_to_liquidate` from that recovered package
  directly rather than copying their integer formulas;
- treats protocol-liquidatable pairs independently of flash availability, gas,
  routes, MEV, capture probability or profitability;
- fails closed on zero snapshot commitments and malformed liquidation inputs;
- preserves rejected pairs explicitly instead of deleting them from coverage.

The pure sizing bridge is necessary but not sufficient for terminal RMC-012
certification. The terminal bridge must additionally consume the exact admitted
RMC-008 and RMC-009 closeout bytes, enumerate the complete below-one
borrower/collateral/debt pair universe and produce the exact
`ActionabilityCoverage` commitment with zero unexplained omissions.

Terminal inputs are controlled by
`ci/nqc-census/rmc012-terminal-inputs.json`. Until that document is
`PINNED`, terminal certification MUST fail closed and no terminal RMC-012
authority may be claimed.

A pinned document MUST name exactly one successful self-contained RMC-011
real-source certification package by repository, workflow run id/name,
producer commit/tree, GitHub artifact id/name/digest, and package inventory.
RMC-012 MUST NOT independently choose mutable "latest successful" D08/D09
artifacts. Instead it consumes the exact D08/D09 bytes and canonical
RMC-006..RMC-010 external authority lock already authenticated and archived by
that D11 package.

Before actionability runs, terminal CI MUST:
- verify the pinned D11 run completed successfully at the pinned head;
- verify the artifact id/name/digest belongs to that exact run and is not expired;
- verify the producer tree from Git against the pin;
- verify the package-wide SHA-256 inventory and D11 capital archive inventory;
- require the D11 real-source closeout to be canonical terminal evidence and
  bind the same external authority-lock commitment/SHA-256 used below;
- extract D08/D09 only from that authenticated package.

The terminal bridge then re-hashes the consumed D08/D09 evidence manifests,
requires their code identity and full/available anchor fields to equal the
external authority lock, decodes `d11/capital-sources.jsonl` back into
canonical `CapitalSource` values, and runs twice from the same bytes. The two
output trees MUST be byte-identical. It MUST reuse the RMC-011 parser for the
D08 Aave Pool/premium facts rather than maintaining a second JSON
interpretation.

The retained RMC-012 certification record MUST bind the exact D12 commit/tree,
the exact D11 run/artifact/package identity, external authority-lock
commitment/SHA-256, actionability coverage commitment, admitted/rejected
counts, principal-capital promotion counts, D11 capital-source SHA-256 and the
SHA-256/byte length of every emitted terminal artifact.

The terminal actionability/principal-capital certificate is NOT a full concurrent
portfolio-capacity certificate. It MAY certify concurrent principal capacity only
after capital-source contention plus borrower-prestate, debt-position and
collateral-position shared-resource claims have all been evaluated for the
promoted candidate set. Gas, DEX/route liquidity, block/builder inclusion and
other execution-plan resources remain downstream obligations, so terminal D12
MUST retain `portfolio_concurrent_capacity_certified=false` until those resources
are explicitly observed and claimed.

## Non-claims

RMC-012 does not prove:
- positive gross or net EV;
- capture probability;
- route execution quality;
- MEV inclusion;
- realized P&L;
- optimal portfolio selection.

The portfolio engine can prove simultaneous resource/capital consistency for
an explicit fully declared candidate/resource set. The current terminal
actionability/principal-capital artifact proves only conserved PFT
actionability plus exact provider-bound principal/flash-settlement feasibility;
it does not claim concurrent portfolio capacity or complete zero-own-capital
execution while gas funding remains uncertified.
