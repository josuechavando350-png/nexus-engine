# RMC-006 Aave Discovery Reconciliation Contract

Status: implementation contract for D06 / CENSUS-2 Aave discovery.

Authoritative parent:
- RMC-005 merge: `5e856c3dc78902b055ed9878c117d3c1469a8fda`

Protocol/Fork Truth remains closed at:
- certified commit: `5b4a0cb778cb4370cd54eb6fcba765dc8d7cecdf`
- certified tree: `ef3498da528f85cdb9fdd82222d64773a557f853`

This stage addresses RMC-GAP-004 for the certified Ethereum-mainnet Aave V3
deployment scope. It does not claim global Aave completeness.

## 1. Scope

The first operational D06 target is the Protocol/Fork-certified Ethereum Aave V3
deployment:

- chain_id = 1
- AddressesProvider = `0x2f39d218133afab8f2b819b1066c7e434ad94e9e`
- Pool = `0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2`

The observation anchor is one exact finalized Ethereum block agreed by at least
two independently named RPC transports. Every current-state read is pinned to
that block hash with EIP-1898 `requireCanonical=true`.

This does not make either RPC provider an authority. Provider transport is
replaceable. Authority is the canonical chain state/log history that must agree
across providers.

## 2. Independent discovery surfaces

D06 reconciles three distinct surfaces:

A. **Pool reserve-ID enumeration**
- `getReservesCount()`
- `getReserveAddressById(uint16)` for the complete declared ID range
- zero entries are retained in the raw enumeration but excluded from the active set.

B. **Pool list enumeration**
- `getReservesList()`
- duplicates and zero addresses fail closed.

C. **Configurator event history**
- the current PoolConfigurator is read from the AddressesProvider at the exact anchor;
- the AddressesProvider creation block is located by historical code binary search;
- every `PoolConfiguratorUpdated` event from provider creation through the anchor
  is scanned to obtain the configurator-address lineage;
- every distinct configurator address is scanned for:
  - `ReserveInitialized(indexed address,indexed address,address,address,address)`
  - `ReserveDropped(indexed address)`
- events are replayed in canonical block/transaction/log order;
- the latest lifecycle state per reserve is preserved;
- dropped historical reserves remain evidence and are never silently deleted.

A PASS requires:

`active_by_id == getReservesList == event_derived_active_set`.

Any source-only delta is an unexplained mismatch and fails the gate.

## 3. Deployment identity checks

At the exact anchor, every provider must agree that:

- `AddressesProvider.getPool()` equals the certified Pool;
- `Pool.ADDRESSES_PROVIDER()` equals the declared AddressesProvider;
- the AddressesProvider, Pool and current PoolConfigurator all have non-empty
  runtime code;
- the complete normalized discovery result is byte-identical across providers.

Code bytes are preserved by SHA-256 digest and byte length in D06 evidence.
Semantic code/config admission remains governed by RMC-005 and later D08 state
admission; D06 does not invent an EVM codehash allowlist.

## 4. Exact provenance

Every retained event records:

- block number
- block hash
- transaction hash
- transaction index
- log index
- emitting configurator
- reserve asset
- lifecycle transition

The exact anchor records:

- chain id
- block number
- block hash
- parent hash
- timestamp
- state root

The evidence bundle records provider IDs, exact normalized provider results,
market records, mismatch ledger and SHA-256 manifests.

## 5. Reconciliation metrics

The summary must expose:

- source_a_count_id
- source_b_reserves_list
- source_c_event_active
- union_count
- intersection_count
- unexplained_delta_count
- current_active_count
- historical_market_count
- historical_dropped_reserves

The terminal PASS condition is `unexplained_delta_count == 0` plus exact
cross-provider normalized equality.

## 6. Fail-closed rules

D06 fails on any of:

- wrong chain
- moving/non-final anchor disagreement
- block hash / parent / state-root disagreement
- certified Pool mismatch
- Pool/AddressesProvider identity mismatch
- missing runtime code
- malformed ABI response
- duplicate current reserve
- zero current reserve
- removed log in the canonical scan
- malformed event topics
- Pool enumeration disagreement
- event/getter disagreement
- provider normalized-result disagreement
- incomplete RPC response
- unresolvable historical code boundary

No UNKNOWN is converted to PASS.

## 7. Selector/topic authority

Function selectors and event topics are not handwritten assumptions. The
dedicated workflow derives them with the pinned Foundry `cast` tool from exact
Solidity signatures and passes them into the adapter.

The signatures are:

- `getPool()`
- `getPoolConfigurator()`
- `ADDRESSES_PROVIDER()`
- `getReservesCount()`
- `getReserveAddressById(uint16)`
- `getReservesList()`
- `PoolConfiguratorUpdated(address,address)`
- `ReserveInitialized(address,address,address,address,address)`
- `ReserveDropped(address)`

## 8. Evidence artifacts

The adapter emits:

- `provider-<id>.json`
- `markets.ndjson`
- `summary.json`
- `mismatch-ledger.json`
- `SHA256SUMS`

The GitHub Actions artifact is transport/retention only, not sole authority.
Every file is content-addressed. D04 remains the durable Census evidence
substrate for later integrated runners and final Census certification.

## 9. Non-claims

A D06 PASS proves reconciliation only for the declared Aave V3 deployment scope
at the admitted observation period.

It does not prove:

- all Aave deployments on Ethereum;
- Aave V2/V4 coverage;
- other chains;
- borrower/position completeness;
- reserve economic activity;
- oracle freshness;
- token-behavior admission;
- flash capital availability;
- routes;
- MEV capture;
- profitability;
- Shadow/Canary/production readiness.

Those remain downstream work.

## 10. Exit condition

D06 may close for this declared scope only when exact-head CI proves:

1. selector/topic derivation from pinned toolchain;
2. at least two independently named RPC transports;
3. exact finalized anchor consensus;
4. certified deployment identity checks;
5. complete reserve-ID enumeration;
6. complete `getReservesList` enumeration;
7. complete configurator lineage scan from AddressesProvider creation;
8. complete ReserveInitialized/ReserveDropped replay over that lineage;
9. A == B == C;
10. zero unexplained deltas;
11. byte-identical normalized result across providers;
12. content-addressed evidence output;
13. all unit/static tests green;
14. no PFT, RMC-001..005 authority weakening.

Only after that may D07 or D08 consume the resulting market universe.
