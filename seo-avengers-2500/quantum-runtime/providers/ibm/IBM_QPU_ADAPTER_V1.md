# IBM Quantum Compute physical adapter V1

This directory is the first provider-specific implementation behind the provider-neutral `PhysicalQPUBackend` contract. It does not replace the neutral contract and it does not make IBM a mandatory dependency of Quantum One.

## What is real

When all required configuration is supplied, `createIbmQuantumComputeBackend()` invokes `ibm-qpu-bridge.py`. The bridge uses the pinned IBM/Qiskit stack to:

- authenticate with an IBM Quantum Compute service instance;
- resolve one explicitly named backend;
- reject a backend identified as simulator/fake/emulator/statevector;
- parse the logical OpenQASM 3 produced by the NEXUS QAOA compiler;
- transpile that circuit against the selected backend with Qiskit's backend-aware preset pass manager;
- submit the resulting ISA circuit with `SamplerV2` and the requested shot count;
- wait for the provider job result;
- collect provider job ID, provider timestamps/metrics, counts, backend topology/capabilities, job-time backend properties when exposed, the exact transpiled OpenQASM 3, and reproducibility versions;
- return those bytes and digests to the JS adapter, which revalidates them before `PhysicalQPUBackend` can build an `ExecutionReceipt`.

The dependency versions are deliberately pinned in `requirements.txt`:

- Qiskit 2.5.2
- qiskit-ibm-runtime 0.49.0
- qiskit-qasm3-import 0.6.0

## Evidence preservation

A configured hardware backend requires an `evidenceSink`. The included filesystem sink writes a job-scoped evidence bundle containing:

- logical OpenQASM 3;
- backend-transpiled OpenQASM 3;
- decoded provider result evidence;
- provider receipt metadata;
- provider metrics;
- backend topology;
- backend capability snapshot;
- calibration/backend-properties bytes when the provider exposes them;
- a manifest containing the hashes bound into the execution receipt.

Secrets are not included in the bridge request or evidence bundle. IBM credentials are passed only to the bridge process environment.

## Fail-closed behavior

With no IBM credentials/backend/evidence sink configured, the returned physical backend has no executor and therefore remains `NOT_TESTED` through the existing neutral contract. Partial configuration is rejected rather than silently downgrading to a different mode.

A configured run fails closed if the bridge cannot start, authentication fails, the backend is not physical, logical-circuit binding changes, Qiskit transpilation/execution fails, provider timestamps are incomplete, measurement counts do not match shots, or any preserved artifact digest disagrees with the provider evidence object.

Synthetic provider-shaped values in tests are contract fixtures only. They are not hardware evidence and are never presented as a physical execution.

## Hardware status in this repository

No IBM API key, IBM service-instance CRN, named accessible physical backend, or real provider job receipt is committed or configured here. Therefore the repository's physical-hardware status remains `NOT_TESTED` until an authorized operator supplies those values and a real job completes.

A successful future IBM run will prove only that the physical execution/evidence path worked and that WALLE could compare it fairly. It does not by itself demonstrate quantum advantage or speedup.
