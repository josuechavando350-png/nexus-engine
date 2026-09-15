# IBM Live QPU Preflight V1

`NEXUS_IBM_QUANTUM_QPU_PREFLIGHT_V1` is a read-only provider preflight that sits immediately before controlled physical-QPU submission.

It is intentionally **not** a physical execution. A successful preflight may return `PASS` only for the scoped preflight readiness check while `physicalExecutionVerdict` remains `NOT_TESTED` and `submissionAttempted` remains `false`.

## What the preflight does

With explicit IBM Quantum Compute credentials and one named backend, it:

- authenticates with `IBMQuantumComputeService(channel="ibm_quantum_platform", token=..., instance=...)`;
- resolves the exact named backend and rejects simulator/fake/emulator/statevector identities;
- reads `backend.status()` and records `operational`, `pending_jobs`, and `status_msg`;
- verifies backend qubit capacity against the exact logical circuit;
- parses the exact hash-bound OpenQASM 3 artifact already produced by Quantum One;
- performs seeded `generate_preset_pass_manager(backend=..., optimization_level=1, seed_transpiler=...)` ISA transpilation;
- verifies the transpiled instruction names are contained in the backend target operation set;
- captures topology and capability artifacts with SHA-256 bindings;
- records transpiled gate count, two-qubit gate count, and circuit depth as a physical-resource envelope;
- preserves the exact transpiler seed and SDK/compiler versions.

## What it cannot do

The preflight does not instantiate `SamplerV2`, submit a job, consume shots, return measurement counts, obtain a provider job ID, or produce a physical execution receipt.

Therefore:

- `submissionAttempted` must always be `false`;
- `physicalExecutionVerdict` must always remain `NOT_TESTED`;
- a preflight `PASS` must never be interpreted as physical-QPU `PASS`;
- no quantum advantage, speedup, SEO superiority, commercial superiority, or outcome superiority claim is enabled.

## Readiness policy

Preflight `READY` requires all of the following at capture time:

- the named backend is identified as a physical QPU;
- `backend.status().operational === true`;
- `backend.status().status_msg === "active"`;
- backend qubit count is sufficient for the logical circuit;
- the seeded ISA-transpiled circuit contains only target-native operation names.

Any failure remains `NOT_READY` and the JavaScript layer reports `INCONCLUSIVE`. Missing provider access remains `NOT_TESTED`. Bridge/process/contract failures report `FAIL`.

The backend status is observational and can change after preflight; a later physical run must still capture its own execution receipt, calibration evidence, hardware identity, timestamps, shots, measurement counts, and provider job ID.

## Current IBM API basis

This contract follows IBM Quantum Compute client `qiskit-ibm-runtime==0.49.0` and Qiskit `2.5.2`, already pinned in this provider directory. IBM's current documentation exposes `IBMQuantumComputeService` as the renamed service class, `backend.status()` with `operational` / `pending_jobs` / `status_msg`, and `generate_preset_pass_manager(..., seed_transpiler=...)` for target-aware seeded transpilation.

No provider credential, CRN, accessible backend entitlement, physical job, or hardware result is stored in this repository.
