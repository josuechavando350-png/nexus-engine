# RMC-006 — Authoritative Aave Reconciled Discovery

Status: certified only by an all-green exact-head run of
`nqc-census-aave-discovery.yml`. This document is the contract, not evidence.

Authorities:

- Census parent `8ebf6860e0a16964f5293df0ef40695b303b286d`.
- RMC-003.2 `519e5f6f7a4d42ff1cab67fef8306cfef9aab120`: log topics are ABI
  words that may be zero.

## Declared scope

Ethereum mainnet / Aave V3 / one D05-admitted deployment:

- Pool `0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2`;
- AddressesProvider `0x2f39d218133afab8f2b819b1066c7e434ad94e9e`;
- observation anchor 25,437,474
  (`0x0712ee92e6c2e2359c792e7aadc5bc35b9db392a2a5dc02f4575096437e8bfc8`).

This scope does not claim all Aave, all Aave V3, all Ethereum lending, or a
global market census.

## Surface A — exact-anchor getters (3 providers, byte-identical)

**Runtime code.** AddressesProvider, Pool proxy, Pool implementation (the
EIP-1967 slot) and price oracle runtime sha256 values must equal the
Protocol/Fork certified baseline. The PoolConfigurator proxy and its EIP-1967
implementation are recorded.

**Pool enumeration.**
- `getReserveAddressById(i)` is read for `i` in `0..getReservesCount()`.
- A zero slot is a dropped reserve, recorded in `dropped_reserve_ids`.
- `getReservesList()` must equal the non-empty slots in id order.
- `getReserveData` must return 15 words whose `id` equals the slot.

## Lineage — AddressesProvider history (2 providers, logs agreed exactly)

Scanned events: `ProxyCreated`, `AddressSet`, `AddressSetAsProxy`,
`PoolUpdated` and `PoolConfiguratorUpdated`. The scan runs from the
AddressesProvider's earliest-code block to the anchor.

**Pool lineage**
- Exactly one `ProxyCreated(POOL)`, at the Pool's earliest-code block.
- Any `AddressSet(POOL)` fails closed: it would be another deployment.
- The implementation chain (`PoolUpdated`, `AddressSetAsProxy(POOL)`) must be
  continuous. The first update may have a zero `old` only in the creating
  transaction. The chain must end at the exact-anchor EIP-1967
  implementation.

**PoolConfigurator lineage**
- Exactly one `ProxyCreated(POOL_CONFIGURATOR)`, at its earliest-code block.
- Every `AddressSet(POOL_CONFIGURATOR)` opens a new configurator window and
  must replace the current configurator.
- The last window must be the exact-anchor configurator.
- The implementation chain must be continuous and end at the exact-anchor
  EIP-1967 implementation.

Events for other ids are counted, not used. Indexed zero addresses (for
example the `old` of an initial update) are ordinary topics.

## Surface B — reserve lifecycle (2 providers, logs agreed exactly)

- `ReserveInitialized` and `ReserveDropped` are scanned from every historical
  configurator.
- An event is accepted only from the configurator whose window contains its
  coordinate `(block, transaction index, log index)`. An event from a
  replaced configurator fails closed.
- The lifecycle is replayed in canonical order with Aave V3
  `_addReserveToList` semantics:
  - an initialisation takes the first empty slot below the count, otherwise
    the next id;
  - a drop empties its slot;
  - an initialisation while active, or a drop while inactive, fails closed.

## Reconciliation

These are UNEXPLAINED deltas, and any one fails the node:

- `CURRENT_ONLY`
- `EVENT_ACTIVE_ONLY`
- `RESERVE_COUNT_MISMATCH` (simulated slots vs `getReservesCount`)
- `RESERVE_ID_SLOT_MISMATCH` (any slot)
- `TOKEN_IDENTITY_MISMATCH` (aToken, variable debt token)

Historical and dropped reserves are preserved in the reserve manifest. A
removal is EXPLAINED only by a canonical `ReserveDropped`; no reason is
inferred from absence.

## Evidence

- Every read is an RMC-003 typed observation in the RMC-004 store.
- Log scans are window checkpoints certified by `certify_range`.
- The history report lists every job manifest (`replay_manifests`).
- D05 admission is materialised from the observed code, configuration and
  oracle fingerprints, with every manifest as an evidence reference.

## Crash/resume equivalence (offline, no network)

`nqc-rmc006-aave-resume-check` runs inside a network namespace with no
interfaces. It rebuilds a replay transport from the listed manifests only,
then:

1. Replays the whole reconstruction into a fresh store. The report must be
   byte-identical to the live report.
2. Repeats into fresh stores crashed after 1, ⅓, ½, ⅔ and all-but-one of the
   recorded requests. Each is resumed; the report and the RMC-004 evidence
   root must be identical to the clean replay.

A tampered report, or a report missing a manifest, is rejected.

## Closeout

- Artifacts carry:
  - `schema_version`;
  - `generated_at`, set to the anchor block timestamp (RFC 3339, never the
    wall clock);
  - code commit and tree, declared universe id and D05 admission id;
  - chain domain, anchor, history range, lineage and source provenance.
- Each artifact's sha256 and RMC-004 artifact id are listed in
  `evidence-manifest.json`.
- The closeout is generated twice and must be byte-identical (`diff -r`).

PASS requires all of this on the exact head:

- zero provider mismatches;
- zero unexplained deltas;
- crash/resume equivalence;
- D05 admission;
- deterministic closeout;
- RMC-004 offline verification.
