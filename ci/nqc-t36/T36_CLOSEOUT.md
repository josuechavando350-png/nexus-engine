# NQC Tranche 36 — Formal Closeout

Status: **CLOSED**

T36 closes the Flash Funding Executor Integration tranche at the scope actually demonstrated: deterministic protocol-callback invariants plus pinned historical Ethereum mainnet fork parity.

## Closure evidence

- Evidence commit: `62764b7a1eecd3a320ac68e4027332edc513a989`
- Formal closeout workflow run: `36277058300`
- Formal closeout artifact ID: `10917518552`
- Formal closeout artifact SHA-256: `e26edaf2181bd622f64c5fd4478f8f9c27702de08f04d1bf565b31f8e87886b6`
- Closeout attestation SHA-256: `926dc79aedf908c29ed5f4307b492fb6e82d7b5da5e18881d040b90d0eb2f3b6`
- Exact formatted executor source SHA-256: `bbb5962171f2c1da5067e21ac705a627a35028fdafe5c9403f601bb813d39320`

## Verified gates

- Foundry 1.7.1 and Solidity 0.8.24.
- 8/8 deterministic callback/invariant tests PASS.
- 3/3 historical Ethereum mainnet fork tests PASS.
- Aave V3 `flashLoanSimple` callback parity against the real pool at the pinned state.
- Balancer V2 Vault flash-loan callback parity against the real vault at the pinned state.
- Nested Aave -> Balancer funding path verified with reverse repayment.
- Bounded nesting contract remains max depth 4; depth 2 was exercised physically on the historical fork.
- Exact observed fee matching is enforced.
- Pre-existing executor balance cannot subsidize missing repayment/profit.
- Execution identity replay is blocked.
- Authority issuance remained zero.
- No secret dependency.
- Public RPC was used only as historical evidence transport; it is not a production runtime dependency.

## Historical canonical anchor

Ethereum mainnet block `20,000,000`:

- block hash: `0xd24fd73f794058a3807db926d8898c6481e902b7edb91ce0d479d6760f276183`
- state root: `0x68421c2c599dc31396a09772a073fb421c4bd25ef1462914ef13e5dfa2d31c23`

The archive endpoint was accepted only after matching the pinned canonical identity before protocol code and fork execution were used.

## Scope boundary

T36 does **not** claim live-market P&L, production latency, live capital safety, or production certification. Those remain downstream evidence obligations.

NQC global status remains:

`NOT_CERTIFIED / ACCELERATION_EVIDENCE_NOT_TARGET_ADMISSION`

The 20,000–25,000+ live-market requirement is a T37+ scale/evidence target and is not represented as proven by T36.
