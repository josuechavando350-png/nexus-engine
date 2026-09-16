# IBM Physical Session CLI V1

## Purpose

`seo-avengers-2500/scripts/ibm-physical-session-cli.mjs` is the operator entry point for the first NEXUS Quantum One IBM physical-QPU session.

It does not introduce a new execution path. It drives the already-certified first-run plan, IBM smoke gate, repeated physical-series gate, and physical session coordinator while preserving their exact-source, evidence, cost/entitlement, reconciliation, and no-auto-chaining boundaries.

The CLI does not prove quantum advantage. `quantumAdvantageClaimAllowed=false` remains mandatory throughout this workflow.

## Commands and required order

The operator workflow is deliberately split into six commands:

1. `plan`
2. `prepare`
3. `authorize-smoke`
4. `smoke`
5. `authorize-series`
6. `series`

A later command does not retroactively authorize an earlier one, and the successful smoke command never starts the repeated series automatically.

## `plan`

`plan` builds `WALLE_PHYSICAL_QPU_FIRST_RUN_PLAN_V1` from the repository's current `HEAD` and `HEAD^{tree}` plus explicitly supplied backend, evidence root, transpiler seed, smoke shots, repeated shots, repeated-run count, and bridge timeout.

The command therefore binds the physical plan to the exact checked-out source identity. A plan from another revision cannot be silently reused by the smoke or repeated-series gates.

## `prepare`

`prepare` invokes only the coordinator's `PREPARE_ONLY` phase.

It supplies no IBM credentials, creates no live authorization, submits no hardware job, and cannot certify physical execution. Its result remains a preparation result rather than QPU evidence.

## `authorize-smoke`

`authorize-smoke` creates the existing exact-binding smoke authorization record. It requires:

- the exact physical plan;
- the exact physical request;
- a WALLE proof summary bound to the same source revision and tree;
- `EXECUTED=2500`, `FAILED=0`, `BLOCKED=0`, and zero untested modules in that summary;
- `full_execution_claim=true` and no WALLE validation errors;
- the independently obtained SHA-256 of the WALLE artifact;
- `--ci-status SUCCESS`;
- an externally obtained provider cost/entitlement reference;
- the explicit `--confirm-provider-cost-or-entitlement` operator flag.

The CLI does not query or invent provider billing. The confirmation flag means the operator has already verified the referenced entitlement/cost state outside this command.

## `smoke`

`smoke` is the first command that can reach IBM hardware.

It requires the exact plan, request, and smoke authorization. IBM credentials are accepted only through the runtime environment:

- `IBM_QUANTUM_API_KEY`
- `IBM_QUANTUM_INSTANCE_CRN`

There are no CLI flags for these secrets. Credential-shaped JSON keys are rejected from input and output artifacts, and the command checks that runtime credential values do not appear in the serialized result.

The coordinator executes only `EXECUTE_SINGLE_PHYSICAL_SMOKE`. A successful smoke stops after one verified provider job and still does not complete the physical session.

## `authorize-series`

Only after the real smoke result exists may the operator create `authorize-series`.

It requires:

- the exact plan and physical request;
- the exact prior verified smoke result;
- the authorization-bound classical baseline profile;
- a fresh exact-head WALLE summary and independently obtained WALLE artifact SHA-256;
- exact-head CI status `SUCCESS`;
- a fresh externally confirmed provider cost/entitlement reference and explicit confirmation flag.

The resulting authorization is cryptographically bound to the prior smoke evidence, repeated request, baseline, source identity, CI/WALLE evidence, and provider confirmation reference.

## `series`

`series` is the only CLI command that asks the coordinator to enter `EXECUTE_REPEATED_PHYSICAL_SERIES`.

It requires the exact plan, request, baseline, prior smoke result, and post-smoke repeated-series authorization. Runtime IBM credentials are again environment-only.

The existing repeated-series gate remains responsible for a fresh read-only preflight before every submission, drift detection, unique provider job IDs, receipt validation, timeout/provider-reconciliation handling, and the final classical comparison.

There is no automatic retry after an ambiguous provider state.

## Artifact handling

All production JSON inputs must be regular non-symlink files and are size bounded. Output is created with exclusive create semantics, so an existing evidence file is not overwritten. The default output file mode is `0600`.

The CLI refuses obvious credential-bearing flags and recursively rejects credential-shaped persisted JSON keys. These controls supplement, rather than replace, the existing adapter/gate evidence boundaries.

## Example shape

A preparation sequence has the following form:

```text
node seo-avengers-2500/scripts/ibm-physical-session-cli.mjs plan ... --out plan.json
node seo-avengers-2500/scripts/ibm-physical-session-cli.mjs prepare --plan plan.json --out prepare.json
```

The smoke authorization is intentionally a separate operator step after exact-head CI/WALLE evidence and provider entitlement/cost have been reviewed. The repeated-series authorization is intentionally another separate step after the real smoke evidence has been reviewed.

## Contract-test and physical boundary

The CLI test suite injects contract coordinators and contract backend names. Those tests do not call IBM hardware.

Repository CI can certify the CLI's fail-closed sequencing and evidence contracts, but it cannot turn a contract test into physical-QPU evidence. Physical execution remains unperformed until a live authorized run returns authentic IBM provider job evidence.

A final coordinator `PASS` certifies only the planned IBM physical-session evidence and classical comparability under the existing protocol. It does not certify quantum speedup, quantum advantage, SEO superiority, traffic gains, lead gains, revenue gains, or business outcomes.
