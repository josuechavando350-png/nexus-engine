# IBM Repeated Physical Series Gate V1

## Purpose

This gate is the control boundary between one independently verified IBM physical-QPU smoke job and the repeated physical series required by the NEXUS Quantum One first-run plan.

It does not create a quantum-advantage claim. A `PASS` from this gate certifies only that the planned repeated physical executions were controlled, evidence-complete, stable against the smoke reference, and comparable to the deterministic classical baseline.

## Preconditions

The gate requires all of the following before a repeated physical submission is allowed:

- the exact `WALLE_PHYSICAL_QPU_FIRST_RUN_PLAN_V1`;
- the exact source revision and Git tree named by that plan;
- a `WALLE_IBM_PHYSICAL_QPU_SMOKE_GATE_V1` result with:
  - `verdict=PASS`;
  - exactly one confirmed physical smoke job;
  - `repeatedSeriesAuthorized=true`;
  - no provider-reconciliation requirement;
- a separate `WALLE_PHYSICAL_QPU_REPEATED_SERIES_AUTHORIZATION_V1` record;
- exact-head CI state `SUCCESS`;
- WALLE evidence for all 2,500 modules with 2,500 executed and zero failed, blocked, or untested modules;
- explicit external confirmation of provider cost or entitlement;
- an exact hash binding for the repeated request and the classical baseline profile.

The repeated-series authorization contains no provider credential. IBM API keys and instance configuration remain runtime-only secrets.

## Immutable smoke reference

The verified smoke receipt becomes the immutable reference for the series. Every repeated preflight and every repeated receipt must remain consistent with:

- provider and backend identity;
- problem binding and optimization hashes;
- logical circuit identity;
- seeded ISA-transpiled circuit hash;
- transpiler seed;
- provider SDK and version;
- compiler and version;
- hardware topology hash;
- hardware capability hash.

The smoke provider job ID is also inserted into the uniqueness set so a repeated run cannot reuse the smoke identity.

## Per-run fail-closed sequence

For each planned repeated run, in order:

1. execute the read-only IBM preflight;
2. compare the preflight against the immutable smoke reference;
3. if any readiness, backend, seed, compiler, ISA, topology, or capability check differs, stop before submission;
4. submit exactly one repeated physical job;
5. validate the returned execution receipt immediately;
6. require the planned repeated shot count and matching measurement total;
7. require a unique provider job ID;
8. require the same problem/circuit and reproducibility controls;
9. require raw-result and provider-receipt hashes;
10. only after that receipt passes may the next run begin.

A failure in run `N` prevents run `N+1`.

## Timeout and retry boundary

The local bridge timeout is not proof that the provider did not create or execute a job.

If the live bridge times out or returns without a verifiable receipt:

- `providerReconciliationRequired=true`;
- the repeated series stops immediately;
- `automaticRetryAllowed=false`;
- no later repeated job is submitted by this gate.

An operator must reconcile the provider-side job state before any separately authorized retry.

## Completion and classical comparison

The planned repeated run count comes directly from `plan.repeatedSeries.runCount`; V1 requires at least five runs.

After the series stops or completes, the collected executions are passed to `WALLE_PHYSICAL_QPU_EXPERIMENT_PROTOCOL_V1` using the authorization-bound classical baseline profile.

A gate `PASS` requires:

- every planned repeated run completed;
- every repeated receipt passed immediate validation;
- all repeated provider job IDs are unique;
- no reconciliation state is outstanding;
- the physical experiment protocol also returns `PASS`.

Partial or unstable evidence cannot be promoted to success.

## Claim boundary

Even when the gate returns `PASS`:

- `quantumAdvantageClaimAllowed=false`;
- no speedup claim is enabled;
- no SEO or business superiority claim is enabled;
- no production outcome is guaranteed.

The correct interpretation is:

`PASS_CERTIFIES_CONTROLLED_REPEATED_PHYSICAL_SERIES_AND_CLASSICAL_COMPARABILITY_NOT_QUANTUM_ADVANTAGE`

A separate fair-comparison protocol would be required before any quantum-advantage statement could be considered.

## Hardware boundary

Contract tests use only an explicitly named contract backend and injected bridge runners.

They do not call IBM hardware.

Physical execution remains unperformed until an authorized runtime supplies real IBM credentials, a real accessible backend selected through the authenticated account, explicit cost or entitlement confirmation, and receives authentic provider job evidence.
