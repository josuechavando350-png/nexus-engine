# IBM Physical QPU Smoke Gate V1

`WALLE_IBM_PHYSICAL_QPU_SMOKE_GATE_V1` is the controlled transition from read-only IBM provider readiness into at most one physical QPU smoke submission.

It is deliberately fail-closed. It does not start the repeated physical series automatically, and a successful smoke result does not enable any claim of quantum advantage, speedup, SEO superiority, or business superiority.

## Required bindings before live execution

The live authorization record is hash-bound to:

- the exact Git source revision and source tree;
- the exact physical first-run plan digest;
- the exact smoke request after the plan's smoke-shot policy is applied;
- exact-head CI status;
- the WALLE artifact and proof digests;
- 2,500 executed modules with zero failed, blocked, or not-tested modules and `fullExecutionClaim=true`;
- an explicit external provider cost or entitlement confirmation reference.

Changing the circuit, optimization problem, bindings, or any other smoke-request content after authorization invalidates the authorization before preflight or provider submission.

## Execution sequence

`PREPARE_ONLY` produces a preparation record and performs zero provider bridge calls.

`EXECUTE_PHYSICAL_QPU` requires a valid live authorization record. The gate then runs the read-only IBM preflight. The physical bridge is not called unless preflight is `PASS` / `READY`, still reports `physicalExecutionVerdict=NOT_TESTED`, and confirms the configured physical backend, seed, capacity, native target operations, and active operational status.

After a ready preflight, the gate submits only the single smoke request with the plan-bound smoke shot count. It never executes the repeated series in the same gate invocation.

## Preflight-to-smoke continuity

A smoke receipt must preserve the configured provider/backend identity, exact shot count, transpiler seed, SDK/compiler identity, transpiled circuit digest, topology digest, and capability digest captured at preflight. The preflight and live bridge use byte-identical capability snapshot schemas, including `physicalQubits`, so an equality check is meaningful instead of failing because of schema drift.

The receipt must also contain a provider job ID, raw-result hash, provider-receipt hash, and a verified physical execution receipt. Any mismatch blocks repeated-series authorization.

## Ambiguous submission safety

A local bridge timeout is not evidence that an already-submitted IBM job was cancelled. If a live attempt returns without a verifiable execution receipt, the gate sets provider reconciliation as required and blocks retries and repeated-series authorization.

The operator must reconcile the real IBM provider state before any later submission.

## Result boundary

A gate `PASS` means exactly one physical smoke job was validated under the hash-bound authorization and that the separate repeated-series phase may be considered for execution. The gate reports `repeatedSeriesExecutionCount=0` even on PASS.

Physical hardware remains untested until a real authorized provider job is actually run. Repository tests exercise only contract fixtures and must never be represented as physical IBM execution evidence.
