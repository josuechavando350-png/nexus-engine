# Physical QPU First Runbook V1

This runbook defines the first controlled IBM physical-QPU crossing for NEXUS Quantum One. It is an engineering control document, not evidence that a physical QPU has already been used.

Physical hardware remains `NOT_TESTED` until an authorized IBM account produces a real provider job, a verifiable receipt, measurement evidence, and the required immutable bundle.

## Runtime contract

The executable preparation contract is `physical-first-run-plan.mjs` with engine ID `WALLE_PHYSICAL_QPU_FIRST_RUN_PLAN_V1`.

A valid plan is bound to the exact Git source revision and source tree. It requires every operational input explicitly: physical backend name, non-null transpiler seed, evidence root, smoke shots, repeated-series shots, repeated-run count, and local bridge timeout. Unknown extra fields fail closed. API keys and instance CRNs are not valid plan fields.

The plan fixes two distinct interlocks:

- preparation: `PREPARE_ONLY`
- live provider submission: `EXECUTE_PHYSICAL_QPU`

A preparation record always has `hardwareInvocationCount=0`, `verdict=NOT_TESTED`, and `quantumAdvantageClaimAllowed=false`. It cannot be used as physical-hardware evidence.

## IBM SDK status validated before the physical boundary

The repository pins:

- `qiskit==2.5.2`
- `qiskit-ibm-runtime==0.49.0`
- `qiskit-qasm3-import==0.6.0`

As checked against IBM Quantum documentation on 2026-09-15, the current IBM Quantum Compute client supports `IBMQuantumComputeService` / `QiskitRuntimeService`, backend lookup through the service, and `SamplerV2(mode=backend).run(..., shots=...)`. The current bridge already uses `IBMQuantumComputeService`, `SamplerV2`, OpenQASM 3 parsing, backend-targeted preset transpilation, and the explicit `seed_transpiler` path.

Do not rename or relax this integration merely because older documentation calls the service Qiskit Runtime. The pinned 0.49.0 client renamed the service to IBM Quantum Compute while preserving the established API surface.

## Backend selection rule

Do not guess a production backend name from public documentation. The backend in a live plan must be returned by the authenticated IBM service for the authorized account/instance and must resolve to a physical, non-simulator device.

Before submission, operator review must confirm the backend is accessible in the selected account/instance. IBM exposes `backend.status()` with an operational flag and pending-job count; an unavailable or non-physical backend is a stop condition.

The repository must not contain a real API key or instance CRN. Runtime credentials remain outside Git and outside evidence bundles in the approved secure environment.

## First crossing sequence

The sequence is deliberately split so one bad job cannot automatically become a repeated series.

1. Build and hash the first-run plan against the exact certified source revision/tree.
2. Produce a preparation record with the IBM physical adapter descriptor. No provider call is authorized in this step.
3. Verify exact-head CI and WALLE evidence remain green. If the exact head moved, rebuild the plan against the new certified revision.
4. In the authorized runtime only, resolve the configured backend and confirm physical identity, accessibility, provider cost/entitlement, evidence storage, and the non-null transpiler seed.
5. Submit exactly one smoke job. Preserve the real `job_id` immediately after provider submission.
6. Validate the smoke receipt completely before any second job. Missing or contradictory evidence stops the run.
7. Only after smoke validation, execute the repeated series. V1 requires at least five completed comparable runs with the same problem, backend, shots policy, seed, compiler identity/version, ISA circuit digest, topology, and capabilities.
8. Compare the physical series against the deterministic classical baseline on the same optimization problem and constraints.

## Evidence that must survive the smoke job

The physical bundle must preserve provider/backend identity, unique provider job ID, provider timestamps when exposed, requested and completed shots, problem/optimization bindings, logical and ISA-transpiled circuit hashes, logical/transpiled QASM artifacts when available, measurement counts, topology and capabilities hashes, calibration evidence when IBM exposes it, raw-result and provider-receipt hashes, adapter/SDK/compiler identity, transpiler seed, and immutable content-addressed evidence.

If IBM does not expose calibration metadata for the job, record the provider-not-exposed state. Do not invent calibration data.

## Time and provider-cost controls

`bridgeTimeoutMillis` is a **local bridge wait bound**, not a remote IBM job cancellation guarantee. Killing the local bridge after a timeout does not prove that the provider job stopped. Therefore a local timeout is a hard stop: reconcile the provider job by its real provider state before retrying or submitting another job.

The current adapter does not integrate an IBM billing API. The plan therefore records `billingApiIntegrated=false` and requires explicit external provider cost/entitlement confirmation before live authorization. This is intentional: NEXUS does not claim to enforce a monetary cap it cannot actually observe.

The code does enforce deterministic job-count and shot-count maxima derived from the plan. A V1 plan includes one smoke job plus the repeated-series run count; total planned shots are hash-bound into the plan.

## Abort conditions

Stop before the next provider submission if any of the following occurs: incomplete credentials/configuration, inaccessible or non-physical backend, missing/duplicate provider job ID, provider failure or blocked execution, shot/count mismatch, problem/circuit/artifact digest mismatch, missing ISA circuit evidence, missing or drifting transpiler seed, compiler drift, topology/capability drift, missing provider/raw-result hash, unresolved local timeout, secret exposure, non-green exact-head CI, or unconfirmed provider cost/entitlement.

Do not fall back to a simulator and label it physical. Do not transform an empty or blocked run into PASS. Do not continue a repeated series after a smoke receipt fails validation.

## Claim boundary

A valid preparation record certifies only that the run has been prepared under a hash-bound fail-closed plan. A valid physical operator PASS later certifies controlled repeated physical-QPU evidence. Neither result, by itself, establishes quantum advantage, speedup, business advantage, or SEO superiority.

`quantumAdvantageClaimAllowed` remains `false` unless a separate fair-comparison protocol produces evidence sufficient for that claim.
