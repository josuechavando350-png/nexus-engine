# WALLE architecture

## Mission

WALLE is a sovereign software-assurance subsystem inside Nexus. It coordinates controlled execution, validation, adversarial testing, evidence capture, and certification without becoming a deployment authority.

The design goal is not to maximize the number of tools. The goal is to make every verdict explainable, reproducible where applicable, tamper-evident, and bounded by explicit policy.

## Planes

WALLE is divided into six logical planes.

### 1. Control plane

Owns run identity, workload contract, state transitions, cancellation, kill paths, resource budgets, scheduling policy, and certification profile. The control plane must never trust a workload to report its own isolation or policy compliance.

### 2. Isolation plane

Creates the environment in which the workload executes. Future backends are expected to include a strong microVM backend and a faster sandbox backend. The backend contract must expose resource, network, filesystem, process, secret, and device capabilities explicitly.

### 3. Execution plane

Runs the workload adapter inside the selected isolation backend. Adapters translate a generic WALLE contract into workload-specific commands and evidence. Adapters cannot weaken global WALLE policy.

### 4. Verification plane

Consumes execution evidence and runs static analysis, unit/integration/browser tests, property tests, fuzzing, mutation tests, performance checks, supply-chain analysis, policy checks, and integrity verification as configured by the certification contract.

### 5. Evidence plane

Stores content-addressed run evidence, manifests, receipts, hashes, provenance, SBOMs, attestations, and redacted summaries. Publication must become atomic and durable before WALLE is considered production-grade.

### 6. Certification plane

Combines validated evidence with immutable policy to produce one terminal verdict. Certification policy must distinguish execution success from evidence sufficiency and from release/deployment authorization.

## Run model

```text
PLANNED
   |
PREPARING
   |
ISOLATED
   |
EXECUTING
   |
VERIFYING
   |
CERTIFYING
   |
CERTIFIED
```

Fail-closed terminal exits are `BLOCKED`, `INSUFFICIENT_DATA`, and `CANCELLED`.

A terminal state never transitions back into the graph. A retry is a new run with a new run identity.

## Capability model

WALLE must treat ambient access as a bug. Capabilities are granted per run and should eventually include:

- filesystem: none / read-only inputs / bounded scratch / declared output;
- network: deny-all / loopback / explicit allowlist;
- process: bounded PID count and child policy;
- CPU: quota and affinity policy;
- memory: hard ceiling;
- time: wall-clock deadline and phase deadlines;
- secrets: deny-by-default, explicit named grants only;
- devices: deny-by-default;
- production credentials: forbidden in ordinary certification workloads.

## Certification profile semantics

### FAST

Optimized for developer feedback. It may omit expensive adversarial stages. A FAST run can pass its configured checks but may not emit the maximum `CERTIFIED` assurance claim.

### HARDENED

Adds stronger security, isolation, integrity, fault-handling, and adversarial checks. It is suitable for pre-release qualification.

### CERTIFICATION

Requires exact source identity, a controlled environment, all mandatory policy gates, complete evidence publication, and terminal integrity validation. Only this profile may become eligible for the final certification claim once later phases implement the required controls.

## Planned implementation phases

### W0 — foundation

Typed Rust state machine, contract validation, resource-plan primitives, zero-dependency CLI, tests, threat model, CI. No production side effects.

### W1 — execution capsule contract

Stable adapter ABI, run IDs, canonical manifests, phase receipts, structured exit taxonomy, timeout/cancellation ownership, and explicit capability requests.

### W2 — isolation backends

Linux/KVM host requirements, microVM backend, faster sandbox backend, deny-all networking by default, cgroup/resource enforcement, read-only base filesystem, bounded scratch, seccomp/device restrictions, escape tests.

### W3 — evidence and provenance

Canonical JSON, SHA-256 content-addressed storage, atomic/durable publication, replay protection, run manifest, source/toolchain/environment binding, SBOM, provenance and signed attestations.

### W4 — verification engines

Static analysis, dependency/security scanning, browser/API testing, performance budgets, policy-as-code, secret scanning, supply-chain checks and deterministic-result comparisons.

### W5 — adversarial assurance

Coverage-guided fuzzing, property-based testing, mutation testing, fault injection, crash consistency, malformed inputs, resource exhaustion, symlink/TOCTOU, network exfiltration attempts, stale/replayed evidence and red-team suites.

### W6 — Avengers adapter

A controlled adapter that reports separately:

- modules actually executed in this run;
- modules composition-verified/delegated;
- missing/insufficient evidence;
- runtime errors;
- policy/integrity violations;
- M2500 terminal state.

WALLE must never describe a delegated verification chain as 2,500 freshly executed modules.

### W7 — scheduler and multi-node operation

Resource-aware scheduling, NUMA/CPU topology awareness where useful, worker attestation, queue fairness, admission control, cancellation, artifact locality and node quarantine.

### W8 — observability and operator console

OpenTelemetry-compatible traces/metrics/logs, run explorer, evidence drill-down, policy explanations, hot-disable, node health, trend analysis and immutable certification history.

## Hardware posture

WALLE should scale up on a powerful single Linux host first, then scale out without changing the workload contract. Large RAM capacity is used for safe concurrency, caches and ephemeral sandboxes, not as a substitute for durable evidence storage.

The scheduler must consider CPU, memory, storage I/O, network policy, isolation backend availability, and workload class. It must not oversubscribe merely because memory is available.

## Non-goals

WALLE does not promise that software is bug-free, legally compliant, secure against every future exploit, or commercially successful. It certifies only the explicit contracts and evidence represented by a particular run.
