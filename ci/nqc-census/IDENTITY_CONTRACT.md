# RMC-001 Canonical Market Identity Contract

Status: implementation contract for Real Market Census CENSUS-1 identity only.

Certified base: `5b4a0cb778cb4370cd54eb6fcba765dc8d7cecdf`, tree
`ef3498da528f85cdb9fdd82222d64773a557f853`. Protocol/Fork Truth remains
`PROTOCOL_FORK_TRUTH_CLOSED`. This contract does not reopen or extend that
certification.

## Purpose and hard boundary

RMC-001 defines stable identifiers before discovery, state reconstruction, capital,
routing, competition, or economics are allowed to count anything. The identity core
has no RPC provider, signer, secret, mempool, price, balance, P&L, or execution I/O.
It proves serialization and semantic separation only; it does not prove that any
market exists on-chain.

The unit hierarchy is explicit:

- a base market has exactly one `MarketId`;
- state/configuration at a block has a `MarketStateId`, never a new `MarketId`;
- a market may expose zero or many action surfaces, each with an
  `ActionSurfaceId`;
- aliases bind an external locator to an existing `MarketId` only with evidence;
- migrations link two distinct market identities and never collapse them.

## Chain and deployment identity

`ChainDomain` is `chain_id + genesis_hash + fork_lineage`. The fork-lineage
anchor is a stable, adapter-proven lineage identifier. An ordinary canonical reorg
does not change it. Two chains that reuse chain ID and genesis but belong to
different declared lineages must not collide.

`DeploymentKey` adds protocol family, stable deployment address, and a
`deployment_instance` evidence digest. A proxy upgrade does not create a new
deployment instance. Destruction/redeployment or a distinct deployment must use a
different instance binding even when an address is reused.

Implementation code hash, configuration hash, oracle configuration, and compatible
semantic version belong to `DeploymentSemanticsVersion`; they affect
`MarketStateId`, not persistent market identity.

## Initial market units

The first tagged market union is intentionally narrow:

- `AavePool`: one Aave V2/V3/V4 pool deployment;
- `AaveReserve`: one reserve-asset contract inside one Aave deployment;
- `V2Pair`: one Uniswap-V2-semantics pair bound to its factory deployment,
  pair address, and canonical token0/token1 ordering.

Ticker, symbol, display name, registry index, source order, and dashboard labels are
not identity. Wrapped and underlying assets remain different contract identities.
A reserve rename therefore preserves identity, while replacing the reserve asset
contract does not.

For V2, token0 must be strictly lower than token1 by address bytes and all pair,
token, and factory addresses must be distinct. This core checks consistency of
provided identity data; a later adapter must prove those values from chain state.

## Action surfaces

`ActionSurfaceKey` is separate from the base-market counter. It binds:

`MarketId + collateral_asset + debt_asset + StrategySemanticsKey`.

Reversing collateral/debt is a different surface. Strategy semantics is versioned
and content-addressed. Action surfaces must never inflate counts of base markets.

## Canonical bytes and IDs

Canonical objects use:

`MAGIC("NQC-CENSUS-ID") || schema_version:u16-be || object_tag:u8 || TLV fields`.

Each field is `tag:u8 || length:u32-be || value`. Field tags are strictly
increasing and unknown/missing/duplicated/reordered fields are rejected by the
decoder. Integers are unsigned big-endian. Addresses are exactly 20 bytes; hashes
are exactly 32 bytes. Text casing and source ordering cannot affect canonical bytes.

IDs use SHA-256 with explicit domain separation and a zero delimiter:

- `SHA256("NQC-CENSUS-MARKET-ID-V1" || 0x00 || canonical_market_bytes)`;
- `SHA256("NQC-CENSUS-MARKET-STATE-ID-V1" || 0x00 || canonical_state_bytes)`;
- `SHA256("NQC-CENSUS-ACTION-SURFACE-ID-V1" || 0x00 || canonical_action_bytes)`.

An evidence artifact SHA-256 is a different namespace and must never be substituted
for a semantic identity.

## Alias, migration, and dedup rules

An `AliasEvidence` requires a non-zero source namespace, source locator digest,
target MarketId, and evidence digest. The same source locator may repeat only when
it resolves to the same target. Conflicting targets fail closed.

A `MigrationEvidence` requires distinct source and destination MarketIds. Migration
does not mutate or replace the old identity. Historical balances remain attributable
to their original market and later conflict analysis may link the two.

Deduplication is by canonical ID plus canonical bytes. Equal bytes may repeat across
discovery sources. The impossible-but-safety-critical case of one ID mapping to
different canonical bytes is a hard hash-collision error. An action surface that
references a market absent from the supplied base-market inventory is rejected.

## Required invariants

RMC-001 must prove:

1. independently computed golden bytes and IDs match Rust exactly;
2. case-only hexadecimal representation aliases normalize identically;
3. chain, deployment instance, protocol family, and fork-lineage separation;
4. ordinary reorg keeps MarketId while observation changes MarketStateId;
5. proxy/config/oracle changes keep MarketId and change MarketStateId;
6. migration to another deployment remains a distinct MarketId;
7. reserve rename/source duplication cannot duplicate a market;
8. wrapped versus underlying contracts remain distinct;
9. collateral/debt orientation changes the action-surface ID;
10. zero/invalid/overflow/unknown/ambiguous/contradictory inputs fail closed;
11. counts distinguish pool, reserve, pair, and action-surface denominators;
12. input ordering does not change the result;
13. no network, secrets, signer, price, or economic I/O exists in this crate.

The JSON vectors under `ci/nqc-census/identity-vectors.json` are synthetic
serialization vectors only. They are explicitly forbidden as market, liquidity,
profitability, or production evidence.

## Deliberately not solved

RMC-001 does not establish deployment discovery completeness, archive/RPC authority,
bytecode admission, borrower enumeration, current state, capital or gas funding,
routes, simulation, gas/net EV, MEV, conflict graphs, temporal distributions,
Shadow, Canary, live P&L, or Census certification. Those remain downstream gaps.

A later consumer of certified Protocol/Fork code must resolve the effective-source
overlay problem separately; this PR does not copy or alter recovered protocol source.
