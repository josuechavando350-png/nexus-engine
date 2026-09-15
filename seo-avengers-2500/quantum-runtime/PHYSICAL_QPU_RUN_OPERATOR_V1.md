# Physical QPU Run Operator V1

`WALLE_PHYSICAL_QPU_RUN_OPERATOR_V1` is the controlled orchestration layer for repeated physical-QPU experiments.

It does not turn provider configuration into proof. It coordinates a provider-neutral `PHYSICAL_QPU` backend, preserves every backend execution, delegates per-run validation to the existing receipt/judge stack, and then applies stricter repeated-run reproducibility controls before the experiment can be called `PASS`.

## Default boundary

The operator defaults to `PREPARE_ONLY`.

In that mode it does not call the physical backend, does not submit a provider job, and returns `NOT_TESTED`. `NOT_TESTED` is never promoted to success.

Physical execution requires the exact authorization value `EXECUTE_PHYSICAL_QPU`. This is an execution interlock, not a credential substitute. The provider adapter must still be fully configured and must still produce valid physical evidence.

## Repeated-run policy

A physical run series is sequential and bounded to 2-256 requested runs. The operator stops immediately on `NOT_TESTED` or `FAIL` so missing configuration or failed provider evidence cannot be multiplied into fake repetitions.

The underlying `WALLE_PHYSICAL_QPU_EXPERIMENT_PROTOCOL_V1` still verifies:

- same exact optimization problem and classical baseline;
- real physical backend family only;
- unique provider job IDs;
- stable provider/backend/device/adapter identity;
- stable logical circuit and shot policy;
- sufficient successful receipts;
- WALLE judge comparability and proven classical baseline requirements.

The operator adds a stricter reproducibility layer across successful receipts:

- identical non-null ISA-transpiled circuit SHA-256;
- identical compiler identity and compiler version;
- identical explicit non-null transpiler seed;
- identical captured backend topology digest;
- identical captured backend capability digest.

Any missing or drifting control keeps the operator `INCONCLUSIVE` even if the lower-level physical experiment report is otherwise `PASS`.

## IBM boundary after adapter V1

The merged IBM adapter captures the transpiled circuit, compiler identity/version, topology and capabilities, but its current bridge records the transpiler seed as `null`.

Therefore a future IBM hardware run through the current adapter can produce valid provider receipts, but this operator will not certify the repeated series as `PASS` until the IBM path captures an explicit transpiler seed. That is intentional fail-closed behavior and prevents stochastic transpilation from being hidden behind an otherwise green receipt chain.

No IBM credentials, service-instance CRN, named accessible QPU backend, or physical provider job receipt are present in this repository. Physical IBM execution remains `NOT_TESTED` until those external prerequisites exist.

## Claim boundary

A `PASS` from this operator means only that repeated physical executions were controlled and comparable under the captured evidence policy. It does not demonstrate quantum advantage, speedup, commercial superiority, or better SEO outcomes. `quantumAdvantageClaimAllowed` remains `false`.
