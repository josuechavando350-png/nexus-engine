# RMC-003 Observation, Stage/Rejection, and Capability Core

Status: implementation contract for D03 from the Real Market Census CENSUS-0 dependency DAG.

Parent authority:

- Protocol/Fork Truth certified commit: `5b4a0cb778cb4370cd54eb6fcba765dc8d7cecdf`
- Protocol/Fork Truth certified tree: `ef3498da528f85cdb9fdd82222d64773a557f853`
- RMC-001 canonical identity merge: `cea25577edfcaf89dc8fc8bf60ee04bc01d01a3d`
- RMC-002 effective-source merge: `0d90ee7a7d439d2c658209c8fe176a8dda6bcbcb`

RMC-003 addresses RMC-GAP-005, RMC-GAP-021, and the core interface portion of RMC-GAP-025. It does not perform discovery, state reconstruction, capital census, routing, economic classification, Shadow, Canary, or live execution.

## 1. Observation envelope

Every economic observation must carry a complete state anchor:

- ChainDomain;
- block number;
- block hash;
- parent hash;
- timestamp;
- state root.

It also carries:

- implementation/code hash;
- configuration hash;
- provenance authority;
- provenance source namespace;
- source locator hash;
- request digest;
- response digest;
- digest of the raw payload before decoding;
- domain-separated digest of the complete observation envelope.

A downstream decoder may transform the typed payload, but the original observation envelope and raw-payload digest are preserved unchanged.

## 2. Raw log preservation

`RawLogEnvelope` preserves the economically relevant EVM log keys before protocol decoding:

- emitter;
- transaction hash;
- transaction index;
- log index;
- zero to four topics;
- raw data;
- removed flag.

The raw-log digest is deterministic. Decoders are consumers of that envelope; they are not allowed to replace its provenance.

## 3. State join rule

Observations may be joined as one atomic state only when all anchor fields agree.

A mismatch in chain domain, block number, block hash, parent hash, timestamp, or state root is a typed hard error. Code/config hashes remain attached to each observation because two contracts observed at the same block may legitimately have different implementations/configurations.

This prevents mixed-block and mixed-fork snapshots from becoming one apparent market state.

## 4. Thirteen-stage Census pipeline

The core defines exactly these ordered stages:

1. MARKETS_DISCOVERED
2. MARKETS_CANONICALIZED
3. MARKETS_STATE_RECONSTRUCTABLE
4. MARKETS_ECONOMICALLY_ACTIVE
5. MARKETS_BORROWABLE
6. MARKETS_LIQUIDATABLE_OR_ACTIONABLE
7. MARKETS_CAPITAL_FEASIBLE
8. MARKETS_EXECUTION_SIMULATABLE
9. MARKETS_POSITIVE_GROSS_EV
10. MARKETS_POSITIVE_NET_EV
11. MARKETS_POSITIVE_TAIL_ADJUSTED_EV
12. MARKETS_CAPACITY_MATERIAL
13. MARKETS_SHADOW_ELIGIBLE

Each unit at each stage receives exactly one typed decision.

## 5. Evidence states

Evidence is classified as exactly one of:

- PROVEN
- DERIVED
- ASSUMED
- NOT_TESTED

Rules:

- NOT_TESTED can never silently advance.
- NOT_TESTED can never masquerade as an ordinary rejection.
- UNKNOWN is represented only as a NOT_TESTED decision carrying a syntactically valid `RMC-GAP-NNN` blocker.
- PROVEN, DERIVED, and ASSUMED pass/reject decisions require one or more evidence references.
- Evidence references are canonicalized and deduplicated before record identity is computed.

This is intentionally stronger than returning `Vec`, `Option`, `Err`, or silently `continue`-ing a candidate.

## 6. Rejection taxonomy

The stable base taxonomy contains:

- NO_ACTIVE_STATE
- NO_BORROWERS
- NO_LIQUIDITY
- INSUFFICIENT_FLASH_CAPITAL
- UNPROFITABLE_AFTER_GAS
- UNPROFITABLE_AFTER_SWAP
- ORACLE_STALE
- MARKET_PAUSED
- CAP_REACHED
- UNSUPPORTED_TOKEN_BEHAVIOR
- ROUTE_UNAVAILABLE
- NON_ATOMIC_CAPITAL_REQUIREMENT
- MEV_NEGATIVE
- STATE_UNRECONSTRUCTABLE
- UNSUPPORTED_CAPABILITY
- UNSUPPORTED_PROTOCOL_VERSION
- UNKNOWN

Negative results are first-class records. They are never dropped merely because they are not profitable or not executable.

## 7. Explicit denominators

`StageLedger` permits one decision per:

`StageDomain + CensusUnitId + CensusStage`.

`StageDomain` binds chain, protocol family, and unit kind. Metrics expose explicit input, advanced, rejected, unknown, proven, derived, assumed, and not-tested counts.

Two conservation equalities must hold:

`input = advanced + rejected + unknown`

and

`input = proven + derived + assumed + not_tested`.

This prevents attractive numerator-only metrics.

## 8. Capability declarations

Protocol/chain support is not inferred from enum names or from the existence of code.

A capability declaration is bound to:

- exact ChainDomain;
- ProtocolFamily;
- non-zero protocol semantics version;
- adapter identity;
- explicit set of supported operations.

The initial operation vocabulary is:

- MARKET_DISCOVERY
- STATE_RECONSTRUCTION
- POSITION_DISCOVERY
- ORACLE_OBSERVATION
- TOKEN_ADMISSION
- CAPITAL_CENSUS
- ROUTE_QUOTATION
- EXECUTION_SIMULATION
- COMPETITION_OBSERVATION
- ECONOMIC_CLASSIFICATION

An absent scope and a declared scope missing a capability both return explicit `UNSUPPORTED_CAPABILITY`; neither is interpreted as support.

## 9. Non-goals

RMC-003 does not claim:

- any market exists;
- any market universe is complete;
- any account universe is complete;
- any oracle is fresh;
- any token is safe;
- any capital source is available;
- any route is executable;
- any opportunity is profitable;
- any chain/protocol beyond a declared adapter scope is supported;
- any production authority.

Durable CAS/checkpoint storage belongs to D04.

## 10. RMC-001 regression-gate stabilization

The RMC-001 identity workflow originally enforced the historical ten-file PR diff forever. That rule is valid for the RMC-001 PR but incompatible with all later `nqc-census/**` development.

RMC-003 changes that workflow into a permanent regression gate:

- the RMC-001 merge must be an ancestor;
- identity contract, golden vectors, identity implementation, identity tests, crate manifest, and toolchain remain byte-identical unless a future identity-specific PR intentionally changes them;
- independent golden-vector verification continues;
- no-I/O boundary continues;
- full locked Census workspace fmt/clippy/test/build continues.

RMC-003 does not change any protected RMC-001 identity bytes.

## Exit condition

RMC-003 closes D03 only when exact-head CI proves:

- exact PR file scope;
- RMC-001 protected identity bytes unchanged;
- complete observation anchors and deterministic envelope/raw-log digests;
- mixed-state joins fail closed;
- exactly 13 stages;
- UNKNOWN cannot exist without NOT_TESTED + blocker;
- negative decisions remain in rejection records;
- stage denominators conserve exactly;
- unsupported capabilities are explicit;
- duplicate stage decisions and conflicting capability declarations fail closed;
- core remains provider/signer/network free;
- locked fmt/clippy/test/build are green;
- Protocol/Fork Truth remains untouched.
