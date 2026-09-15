# IBM Physical Session Coordinator V1

## Purpose

This coordinator is the top-level live-control boundary for the first NEXUS Quantum One IBM physical-QPU session.

It connects the previously separate first-run plan, physical smoke gate, and repeated physical-series gate without weakening any of them and without allowing the successful smoke job to auto-chain into additional hardware jobs.

The coordinator itself does not prove quantum advantage. It only sequences already-defined gates and preserves their evidence and authorization boundaries.

## Three explicit phases

The coordinator accepts exactly one of three phases:

1. `PREPARE_ONLY`
2. `EXECUTE_SINGLE_PHYSICAL_SMOKE`
3. `EXECUTE_REPEATED_PHYSICAL_SERIES`

The generic authorization string `EXECUTE_PHYSICAL_QPU` is intentionally not a coordinator phase. The coordinator translates a phase-specific action into a gate call only after the phase contract is satisfied.

## Prepare-only phase

`PREPARE_ONLY`:

- carries no live authorization record;
- carries no prior smoke result;
- invokes only the smoke gate's prepare-only path;
- performs no physical submission;
- returns `NOT_TESTED`;
- cannot certify hardware execution.

## Smoke phase

`EXECUTE_SINGLE_PHYSICAL_SMOKE` requires the separate smoke authorization created for the exact plan, exact source revision/tree, exact request, exact-head CI/WALLE evidence, and externally confirmed provider cost or entitlement.

This phase:

- executes only the single physical smoke gate;
- never calls the repeated-series gate;
- refuses a repeated-series authorization supplied in advance;
- validates the returned smoke report digest and smoke execution digest;
- requires exactly one confirmed physical job before the smoke can be treated as verified;
- returns the overall session as `INCONCLUSIVE` even after a valid smoke `PASS`, because the planned repeated series has not happened yet;
- sets `automaticPhaseChainingAllowed=false`.

A successful smoke therefore ends at:

`SINGLE_PHYSICAL_SMOKE_VERIFIED_REPEATED_SERIES_AWAITING_SEPARATE_AUTHORIZATION`

The caller must inspect the actual smoke evidence and then create a new repeated-series authorization. The coordinator cannot pre-authorize that future phase.

## Repeated-series phase

`EXECUTE_REPEATED_PHYSICAL_SERIES` requires:

- the exact previously verified smoke-gate result;
- the separate post-smoke repeated-series authorization;
- the exact physical request;
- the authorization-bound classical baseline profile.

Before the repeated-series gate can be called, the coordinator independently verifies that the prior smoke:

- is a `WALLE_IBM_PHYSICAL_QPU_SMOKE_GATE_V1` report;
- is bound to the same source revision, tree, plan, provider, and backend;
- has an intact report digest;
- has exactly one confirmed smoke job;
- has no unresolved provider reconciliation state;
- explicitly authorized progression to the repeated series;
- has an intact smoke-execution digest and consistent provider job identity.

The repeated-series gate then retains responsibility for its own per-run IBM preflight, drift checks, unique job IDs, receipt validation, timeout/reconciliation behavior, and deterministic classical comparison.

## No automatic hardware chaining

The coordinator never runs the smoke and repeated series in one call.

This is deliberate. A real smoke result can change operational judgment, provider state, cost, or entitlement context. The repeated physical series therefore requires a fresh authorization created only after the smoke evidence exists.

`automaticPhaseChainingAllowed` is always `false`.

## Legacy generic operator bypass guard

The generic `WALLE_PHYSICAL_QPU_RUN_OPERATOR_V1` remains available for provider-neutral contract work, but direct live execution through the IBM adapter ID is blocked.

IBM live hardware execution must pass through the IBM smoke/repeated gated path and this coordinator. This prevents the older generic repeated-run loop from bypassing the exact-head, provider-cost, preflight, smoke, and reconciliation controls introduced for NEXUS Quantum One.

## Session report

Every coordinator result includes a hash-bound session report with:

- source revision and tree;
- plan digest;
- provider and backend;
- explicit phase;
- smoke/repeated gate report digests when present;
- confirmed physical-job count;
- smoke verification state;
- repeated-series completion state;
- provider reconciliation state;
- `automaticPhaseChainingAllowed=false`;
- `quantumAdvantageClaimAllowed=false`.

A coordinator `PASS` is possible only in the repeated-series phase after the repeated gate itself returns `PASS`.

Its interpretation is limited to:

`PASS_CERTIFIES_PLANNED_IBM_PHYSICAL_SESSION_EVIDENCE_AND_CLASSICAL_COMPARABILITY_NOT_QUANTUM_ADVANTAGE`

## Credential and hardware boundary

Real IBM credentials remain runtime-only inputs. They are not written into source control or session reports.

Contract tests use a backend name containing `contract` and injected gate doubles. They do not call IBM hardware.

Until a real authorized runtime receives authentic IBM provider job evidence, physical execution remains unperformed by repository CI and `quantumAdvantageClaimAllowed=false` remains mandatory.
