# NEXUS Quantum One — Provider-Neutral QPU Runtime V1

## Purpose

This layer extends the certified `WALLE_QUANTUM_HYBRID_EXPERIMENT_V1` boundary into a provider-neutral execution contract that can carry either the existing statevector simulator or a future external physical QPU without changing the optimization problem, hiding missing evidence, or granting quantum hardware special scoring treatment.

The base for this work is the certified Quantum/Hybrid Experiment V1 exact commit:

`fed97ae29df506abb5a6f82e1daea0c0790d121d`

This branch does not alter that certified commit. It adds the next stacked layer.

## Architectural surfaces

The V1 runtime exposes the following named boundaries:

- `QuantumProblemContract` — canonical, hash-bound projection of the existing `WALLE_OPTIMIZATION_PROBLEM_BUILDER_V1` model identity, objective, ordered variables and constraint counts.
- `ProblemBinding` — immutable binding to the exact optimization report and model hashes.
- `QaoaExecutableCircuitIr` — provider-neutral executable QAOA payload. It carries the ordered qubit/decision mapping, the exact bounded diagonal cost table reconstructed from the original constraints, predeclared gamma/beta parameters, cost-phase and X-mixer semantics, measurement bit order, and canonical hashes. A physical provider adapter receives this payload, not merely a circuit hash.
- `CircuitBinding` — immutable binding to the exact executable circuit payload, parameter binding, logical qubit count and measurement bit order.
- `QuantumBackendAdapter` — common adapter boundary. Every backend result, including its executable circuit payload, is validated before it can leave the adapter.
- `SimulatorBackend` — wraps the already-certified `STATEVECTOR_QAOA_SIMULATOR` implementation behind the common adapter and emits the same executable QAOA IR that a physical adapter must consume. It does not fabricate timestamps, shots, provider receipts, calibration, or hardware identity.
- `PhysicalQPUBackend` — provider-neutral physical execution boundary. It validates and semantically reconstructs the QAOA IR against the exact Optimization Problem Builder output before an executor can run. Without a real provider executor it returns `NOT_TESTED` and no execution receipt.
- `ExecutionReceipt` — validated execution evidence. Physical receipts require provider, backend/device identity, job ID, submitted/start/completion timestamps, requested/completed shots, problem/report and model hashes, circuit hash, transpiled circuit hash, calibration evidence, raw-result digest, measurement counts, hardware identity, backend-capability snapshot hash when available, provider receipt digest, reproducibility metadata, and result digest.
- `CalibrationEvidence` — versioned provider calibration snapshot or explicit provider-nonavailability state. Missing physical calibration evidence cannot silently become PASS.
- `ResultDigest` — canonical digest binding raw result identity, normalized measurement counts, completed shots, and job identity.
- `QuantumJudgeComparison` — WALLE comparison against the same Classical Baseline V1 and the original optimization constraints. WALLE independently reconstructs and verifies the executable QAOA IR before comparing results.

## Executable QAOA IR

`NEXUS_QAOA_EXECUTABLE_IR_V1` is deliberately provider-neutral and bounded to the same 14-qubit / depth-3 envelope as the certified statevector experiment. For every exact optimization problem it deterministically encodes:

1. one binary decision variable per logical qubit in the exact model order;
2. the computational-basis state index convention and measurement bit order;
3. the complete basis-state cost score table used by V1, including the same hard feasibility checks for budget, editorial capacity, engineering capacity, risk capacity, maximum selected actions, dependencies and mutual exclusions;
4. the exact integer-quantized score convention used by the statevector implementation;
5. a predeclared parameter set with gamma/beta angles;
6. the executable sequence `HADAMARD_ALL -> (DIAGONAL_COST_PHASE -> X_MIXER_ALL)^p -> MEASURE_ALL`;
7. a canonical circuit hash and parameter-binding hash.

The physical executor receives this IR after NEXUS has rebuilt it from the hash-valid optimization report and verified byte-stable semantic equivalence. A provider-specific adapter may translate the IR into the provider's current SDK/circuit primitives, but it may not silently replace the problem, scores, parameters or measurement convention.

This removes an important false-wrapper failure mode: a physical adapter cannot be credited merely for accepting a hash while lacking the actual program it must submit to hardware.

## Verdict semantics

The runtime uses exactly these WALLE-level verdict classes:

- `PASS`: required evidence is present and the predeclared comparison/evidence criteria for this stage are met.
- `FAIL`: evidence is complete enough to show a hard failure or contract inconsistency.
- `INCONCLUSIVE`: execution evidence exists, but uncertainty or missing provider-exposed metadata prevents certification of the comparison.
- `NOT_TESTED`: the required physical execution did not occur. It is blocking and can never be certified as success.

A `PASS` from this layer means the run/evidence contract passed. It does **not** mean quantum advantage, quantum speedup, or production superiority.

## Simulator path

`SimulatorBackend` calls the real existing `buildQuantumHybridExperimentReport` implementation. It keeps the current QAOA statevector implementation and classical reference intact, identifies the parameter set selected by that validated experiment, reconstructs the equivalent executable QAOA IR from the same optimization problem, and presents both through the provider-neutral backend contract.

Simulator receipts have:

- `hardwareExecution=false`;
- no physical provider receipt;
- no hardware identity;
- no provider calibration claim;
- no physical execution timestamps;
- no shot-count claim.

The simulator continues to be useful for deterministic contract and formulation verification, but it cannot satisfy the physical-QPU milestone.

## Physical QPU path

`PhysicalQPUBackend` accepts a provider-specific executor only through dependency injection. The neutral core never fabricates a remote call and never converts a missing executor into success.

Before the executor is called, NEXUS requires the hash-valid source optimization report, rebuilds the expected Problem/Quantum contracts, validates the executable QAOA IR against those exact constraints, and verifies that `CircuitBinding` names that exact payload. The provider executor then receives the validated IR plus immutable bindings and the shot request. Raw business/problem fields do not need to be sent to the provider merely to execute the circuit.

If no executor is configured, the result is:

`NOT_TESTED / PHYSICAL_QPU_PROVIDER_EXECUTOR_NOT_CONFIGURED`

When a real executor is supplied, the provider response is checked against the request before a receipt can be built. At minimum the response must bind to the exact:

- provider;
- adapter ID/version;
- problem/model hash;
- executable logical circuit hash;
- transpiled circuit hash when transpilation applies;
- shot request;
- physical backend/device;
- job/execution ID;
- hardware identity and backend-capability snapshot;
- provider receipt digest;
- raw result digest;
- measurement counts and completed-shot total;
- reproducibility metadata.

Provider, backend, and hardware identities containing simulator/mock/fake/test-only semantics are rejected by the physical contract.

Provider-reported job failure/cancellation is preserved as `FAIL`; it is never rewritten as a successful synthetic result. Malformed provider timestamps, calibration metadata, shot evidence or other receipt fields are converted into a structured fail-closed provider-evidence failure rather than escaping as an unclassified exception. A provider success that lacks captured calibration evidence or separate queue/execution timing remains `INCONCLUSIVE` rather than being promoted to PASS.

## Fair comparison

`QuantumJudgeComparison` rebuilds the same deterministic Classical Baseline V1 from the same optimization problem, independently reconstructs the executable QAOA IR, and then independently re-evaluates the backend candidate against the original constraints:

- budget;
- editorial capacity;
- engineering capacity;
- risk capacity;
- maximum selected actions;
- dependency implications;
- mutual exclusion groups.

Physical measurement counts are decoded using the declared bit order and the most frequent feasible measured state is selected; ties are deterministic. An infeasible physical candidate fails the comparison. A candidate that exceeds a classical optimum already proven exact is treated as evidence inconsistency and fails closed.

If the classical node budget does not prove optimality, the comparison is `INCONCLUSIVE`. A single physical run can never enable a quantum-advantage claim. Repeated physical runs, predeclared statistics, complete resource/cost/timing accounting, and a strong classical comparator are still required before such language can even be considered.

## Current physical status

At this revision there is no configured provider-specific network executor and no authenticated access to a physical QPU in the repository. Therefore physical-QPU execution is deliberately and verifiably `NOT_TESTED`.

Crossing that boundary requires exactly one real provider integration first: a current provider SDK/API executor, authorized credentials/account access, access to a named physical backend/device, and preservation of the provider's real job/result/calibration receipts. The provider-neutral core is designed so that this executor is replaceable rather than becoming the architecture itself.

## Scope and safety

This layer adds no authority to modify tenants, websites, CMS content, backlinks, Ads, Vercel deployments, or Google Search. Cano Penal, SOMA, Nexus Bot Studio, and external client tenants are not activated or touched by this work.

The physical-provider network integration is intentionally absent until real provider access exists. Unit tests may use explicit synthetic contract fixtures to prove fail-closed validation; those fixtures are test data only and are never emitted as physical execution evidence or certification.
