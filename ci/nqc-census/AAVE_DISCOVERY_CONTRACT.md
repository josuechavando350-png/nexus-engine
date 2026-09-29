# RMC-006 — Authoritative Aave Reconciled Discovery

Status: reconciliation core in progress. No completeness claim exists until the
live exact-head acquisition proves the historical start, exact deployed
interfaces/emitters and zero unexplained deltas.

Authoritative parent: `8ebf6860e0a16964f5293df0ef40695b303b286d`.

## Declared initial scope

Ethereum mainnet / Aave V3 / one D05-admitted deployment:

- Pool baseline: `0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2`
- AddressesProvider: `0x2f39d218133afab8f2b819b1066c7e434ad94e9e`
- Observation anchor: block 25,437,474

These values are inherited as candidates from certified Protocol/Fork evidence.
D06 must still observe and admit the deployment at its own exact anchor.

## Surfaces

Surface A uses the certified/effective-source Pool interface:
`ADDRESSES_PROVIDER()`, `getReservesCount()`,
`getReserveAddressById(uint16)`, and reserve-id cross-checks.

Surface B is historical configurator lifecycle. The candidate
`ReserveInitialized(address,address,address,address,address)`,
`ReserveDropped(address)`, and `getPoolConfigurator()` semantics come from
the official Aave V3 interface family but are **not** promoted to Census
authority by this document. D06 live evidence must prove the exact emitter,
runtime/version applicability and log layout before using them.

Provider diversity is transport corroboration, not a discovery surface.

## Reconciliation

Current getter-only entities are UNEXPLAINED.
Historical-only entities are preserved.
A historical-only entity is EXPLAINED as removed only with a later canonical
ReserveDropped proof under verified deployment semantics. No lifecycle reason
is inferred from absence.

PASS requires zero unexplained deltas, exact historical range coverage, D05
admission and RMC-004 evidence verification.
