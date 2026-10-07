# RMC-015A — Temporal Trigger Discovery Authority

## Mission

RMC-015A proves that the declared historical window has a complete, fail-closed
enumeration of every state-transition class that can create, destroy, or
materially change an Aave liquidation opportunity. Event-only discovery is
explicitly insufficient.

RMC-015A is a temporal trigger authority, not an opportunity/P&L authority. It
must not infer opportunity birth/death, capture probability, realized P&L,
monthly capacity, or Census closure.

## Required trigger classes

Exactly these seven trigger classes are mandatory:

1. POSITION_MUTATIONS
2. PROTOCOL_CONFIG_MUTATIONS
3. ORACLE_PRICE_TRANSITIONS
4. RATE_INDEX_SEGMENTS
5. INTEREST_ONLY_CROSSING_CANDIDATES
6. LIQUIDATION_OUTCOMES
7. CANONICAL_CHAIN_REORG_AUTHORITY

Every class must cover the exact declared historical block window or fail
closed.

### POSITION_MUTATIONS

Coverage must include, at minimum:

- SUPPLY
- WITHDRAW
- BORROW
- REPAY
- ATOKEN_TRANSFER
- VARIABLE_DEBT_MINT_BURN
- STABLE_DEBT_MINT_BURN when supported by the deployment/window
- COLLATERAL_USAGE_CHANGE
- USER_EMODE_CHANGE

Unsupported deployment-specific surfaces must be explicitly classified and
evidence-bound; they may not disappear silently.

### PROTOCOL_CONFIG_MUTATIONS

Coverage must include, at minimum:

- RESERVE_CONFIGURATION
- LIQUIDATION_THRESHOLD
- LIQUIDATION_BONUS
- LIQUIDATION_PROTOCOL_FEE
- RESERVE_PAUSE_FREEZE_ACTIVE
- SUPPLY_BORROW_CAPS
- ISOLATION_DEBT_CEILING
- EMODE_CONFIGURATION
- ORACLE_CONFIGURATION
- GOVERNANCE_EXECUTION_EFFECTS

### ORACLE_PRICE_TRANSITIONS

Must bind exact historical oracle observations, decimals/scaling, freshness
semantics and source identity. A price transition cannot be reconstructed from a
future value.

### RATE_INDEX_SEGMENTS

Must bind every segment needed to reconstruct variable/stable debt and reserve
index evolution across the window. Missing blocks/segments are blockers.

### INTEREST_ONLY_CROSSING_CANDIDATES

This is a derived surface. It must be produced by deterministic replay from
authenticated rate/index, position, configuration and oracle inputs. It MUST NOT
pretend to have two independent RPC observations. The derived record binds:

- authenticated input commitments;
- deterministic algorithm commitment;
- equivalence/replay commitment;
- no-look-ahead assertion.

### LIQUIDATION_OUTCOMES

Actual liquidation calls and other terminal liquidation outcomes are trigger
authority. Their inclusion order must be exact.

### CANONICAL_CHAIN_REORG_AUTHORITY

Historical canonicality is a first-class surface. Reorg invalidation/replay must
be explicit. A trigger record from a noncanonical block cannot survive merely
because its transaction/log once existed.

## Source-independence rule

Every acquired chain surface must have evidence from at least two distinct
provider IDs operated by at least two distinct operators. Two URLs controlled
by one operator do not constitute independent authority.

Derived surfaces use authenticated input commitments plus deterministic
replay/equivalence. They are not allowed to manufacture provider independence.

## Window and ordering

Every trigger authority binds one declared window:

- chain_id;
- start_block + start_hash;
- end_block + end_hash;
- canonical lineage/reorg authority commitment.

RMC-015B later binds PRE_TX / LOG / POST_TX / END_BLOCK ordering for concrete
episodes. RMC-015A must retain enough transaction/log/block identity to make
that reconstruction possible.

## Fail-closed terminal conditions

RMC015_TEMPORAL_TRIGGER_AUTHORITY_PASS is legal only when:

- the exact seven trigger classes are present once each;
- every class covers the declared window;
- all mandatory sub-surfaces are conserved;
- acquired surfaces satisfy dual-provider + dual-operator independence;
- derived interest-only crossing authority binds authenticated inputs and
  deterministic replay/equivalence;
- unresolved mismatch count = 0;
- material UNKNOWN count = 0;
- look-ahead used = false;
- coverage_complete = true;
- canonical reorg authority is present and admitted;
- output commitment is independent of input ordering.

Until production historical acquisition has been executed and reconciled,
RMC-015A remains BLOCKED. Passing foundation tests is not terminal authority.
