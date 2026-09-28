# RMC-005 Deployment Registry and Admission Contract

Status: implementation contract for D05 / CENSUS-2 admission primitives.

Stacked parent candidate: RMC-004 PR #513 exact head
`be257a473cffd8c4f16fd6a2513411ce2d6153be`.

Protocol/Fork Truth remains closed at certified commit
`5b4a0cb778cb4370cd54eb6fcba765dc8d7cecdf` and tree
`ef3498da528f85cdb9fdd82222d64773a557f853`.

RMC-001, RMC-002 and RMC-003 remain authoritative and unchanged.

## Purpose

RMC-005 introduces the provider-free deployment-universe and admission state
machine required before D06/D07 may perform reconciled Aave/V2 discovery.

It addresses the implementation surface of:

- RMC-GAP-003 — declared finite universe and authoritative discovery roots.
- RMC-GAP-027 — code/config/version admission and upgrade invalidation.

This PR does not query a chain and therefore does not claim that a deployment
exists, that discovery is complete, or that any deployment is economically
usable. Real population and reconciliation of this registry belong to D06/D07.

## Declared-universe rules

A `DeclaredUniverse` is finite and contains explicit `UniverseScope` records.
Each scope binds:

- one RMC-001 `ChainDomain`;
- one `ProtocolFamily`;
- one or more explicit typed discovery roots;
- a finite deployment-creation block window;
- a finite observation block window.

No wildcard chain, protocol, deployment source or unbounded time range exists in
the core contract. Duplicate chain/protocol scopes fail closed.

Discovery roots are protocol-compatible and deliberately narrow:

- Aave V2/V3/V4 use an explicit Aave AddressesProvider root.
- Uniswap V2 uses an explicit V2 factory root.
- generic "registry" authority is not accepted by this core; new protocol families
  must add a typed root with its own reconciliation contract.
- a mismatched root kind is rejected before discovery data can enter the registry.

The universe ID is deterministic and independent of input ordering.

## Admission rules

Every admission identity is domain-separated and includes the exact
`DeclaredUniverse::id`; the same deployment observation admitted under a
different universe contract therefore cannot silently reuse the same admission
identity.

A deployment may be admitted only when all of the following are explicit:

- RMC-001 `DeploymentKey`;
- declared discovery root;
- exact creation anchor;
- exact observation anchor;
- explicit proxy/direct kind;
- implementation address;
- implementation code hash;
- deployment runtime code hash;
- configuration hash;
- oracle-configuration hash;
- positive semantics version;
- lifecycle state;
- exhaustive capability state;
- one or more content-addressed RMC-003 evidence references.

Creation and observation anchors must use the same RMC-001 chain domain as the
deployment and must fall inside the declared scope windows.

No field is inferred from a protocol brand, ticker, proxy shape, source order or
dashboard name.

## Supported semantics

`SupportedSemanticsProfile` is the admission allowlist for one exact:

`chain domain + protocol family + semantics version`.

It binds:

- proxy kind;
- deployment runtime code hash;
- implementation code hash;
- configuration hash;
- oracle-configuration hash;
- exhaustive capability support state.

A binding whose observed fingerprint differs from the declared profile is
`UNSUPPORTED_DEPLOYMENT_SEMANTICS` in downstream Census terms and is rejected
here. Unknown versions never inherit support from a nearby version.

## Capabilities

Every D03 `AdapterCapability` receives an explicit boolean state. Partial maps
are invalid. Absence is never interpreted as support.

Lifecycle is orthogonal to adapter support. A removed deployment may retain
historical discovery/reconstruction capabilities so old evidence remains
interpretable, but the `Removed` lifecycle state is terminal for that
`DeploymentKey` and downstream actionability must reject it.

## Lifecycle and upgrades

Admission records are immutable historical epochs. The registry keeps the
current active record as a derived index only.

For an existing deployment identity:

- the original creation anchor is immutable across every later epoch;
- every later observation must advance block height;
- every transition explicitly names the admission it supersedes;
- semantic fingerprint changes require a strictly larger semantics version;
- lifecycle-only changes may preserve the semantics version but still create a
  new immutable admission epoch;
- a `Removed` deployment is terminal for that `DeploymentKey`; address reuse
  must use a different RMC-001 deployment-instance binding.

A changed code/config/proxy fingerprint without an explicit predecessor is a hard
failure. A first admission with a predecessor is also invalid.

## Proxy rules

Proxy handling is explicit:

- `Direct`: implementation address equals deployment address and the runtime
  code hash equals the implementation code hash.
- proxy kinds: implementation address must differ from deployment address.
- no proxy implementation is guessed from bytecode shape.

Actual on-chain proxy-slot resolution is D06/D07/D08 adapter work and must emit
evidence consumed by this admission contract.

## Evidence boundary

This implementation is provider-free and signer-free. It accepts only already
content-addressed RMC-003 evidence references. It does not create authority from
RPC endpoints, GitHub, explorers, SaaS APIs or mutable indexes.

No synthetic fixture in this PR is real-market evidence.

## Required adversarial behavior

The test suite must prove at least:

1. deterministic finite-universe identity;
2. duplicate scope rejection;
3. empty or protocol-incompatible roots rejected;
4. exact supported binding admitted;
5. exact retry idempotent;
6. undeclared root rejected;
7. unknown semantics version rejected;
8. code/config fingerprint drift rejected;
9. exhaustive capability state required;
10. creation/observation windows enforced;
11. semantic upgrade requires explicit predecessor;
12. semantic upgrade requires version increase;
13. lifecycle history retains prior epochs;
14. removed state is terminal while historical adapter support remains explicit;
15. direct/proxy address and direct-code-identity invariants;
16. wrong-chain anchors rejected;
17. missing admission evidence rejected;
18. identical deployment evidence under a different universe produces a distinct
    admission identity;
19. no later epoch may rewrite the deployment creation anchor.

## Deliberate non-claims

RMC-005 core does not yet prove:

- Ethereum deployment completeness;
- Aave registry reconciliation;
- V2 factory reconciliation;
- creation block discovery;
- proxy implementation slot truth;
- real code/config hashes;
- upgrade history completeness;
- borrower/position completeness;
- liquidity, capital, route, MEV or P&L.

Those facts must be supplied by later authoritative discovery and state adapters.

No D06/D07 result may be called complete merely because it can be represented by
these types.
