# WALLE Quantum/Hybrid Experiment V1

## Purpose

Quantum/Hybrid Experiment V1 is the first controlled solver-tournament layer after the certified classical baseline.

It executes a **QAOA quantum algorithm in a classical statevector simulator** against the exact same solver-neutral optimization problem used by Classical Baseline V1. It then compares the resulting feasible candidate with the deterministic classical reference.

V1 deliberately does **not** represent simulator execution as QPU hardware execution and does **not** allow a quantum-advantage claim.

## Why this exists

The experiment boundary prevents a future quantum integration from receiving special treatment. Before a hardware QPU can be credited with an advantage, NEXUS must already know:

- the exact optimization problem identity;
- the exact classical result on that problem;
- whether the classical result is proven optimal;
- the quantum/hybrid backend identity;
- the parameter-selection and readout policies declared before comparison;
- the candidate objective and feasibility under the original constraints;
- which metrics are genuinely comparable and which are not.

## V1 backend

The only accepted backend identity is:

`STATEVECTOR_QAOA_SIMULATOR`

This means the QAOA circuit mathematics are simulated using classical floating-point statevector evolution. `hardwareExecution` is always `false`.

A profile that attempts to label the backend `QPU` fails closed. Real hardware requires a separate provider-neutral adapter and hardware evidence contract rather than changing a label.

## Problem binding

The experiment consumes the same hash-valid `WALLE_OPTIMIZATION_PROBLEM_BUILDER_V1` report used by `WALLE_CLASSICAL_BASELINE_V1`.

Classical baseline generation occurs inside the experiment boundary. The experiment refuses comparison if the classical reference and QAOA candidate are not bound to the same optimization report and model hashes.

The original portfolio constraints remain authoritative:

- budget;
- editorial capacity;
- engineering capacity;
- risk-policy capacity;
- maximum selected actions;
- dependency implications;
- mutual exclusions.

The QAOA readout is re-evaluated against those original constraints. An infeasible state cannot be presented as a valid candidate.

## QAOA simulation

V1 starts from the uniform superposition and applies explicit QAOA cost and mixer layers for every predeclared parameter schedule.

The diagonal cost function uses bounded upstream objective values for feasible states and an infeasible-state penalty. The simulator reports only quantized integer evidence such as parts-per-million probability mass; floating-point amplitudes are not serialized into the evidence contract.

The simulator is intentionally bounded to a small explicit number of qubits. If the problem exceeds `maximum_qubits`, V1 fails closed. It never truncates the candidate set silently.

## Parameter policy

Every parameter schedule is explicit and hash-bound. All schedules in one experiment use the same QAOA depth.

The only V1 parameter-selection policy is:

`MAX_EXPECTED_HAMILTONIAN_THEN_FEASIBLE_MASS_THEN_ID`

The only V1 candidate-readout policy is:

`MOST_PROBABLE_FEASIBLE_STATE_THEN_LOWEST_BASIS_INDEX`

This matters because the experiment must not inspect all simulated states and secretly choose the highest objective state as its readout. Equal-probability states are resolved by basis identity, not by objective value.

## Classical reference

Classical Baseline V1 remains the reference competitor. When its branch-and-bound search proves optimality, a QAOA candidate cannot legitimately exceed that objective on the same model. If such a contradiction appears, the experiment fails closed because at least one evidence contract is inconsistent.

If the classical node budget is exhausted before optimality is proven, the experiment status is `INCONCLUSIVE_CLASSICAL_BASELINE_NOT_PROVEN`. A QAOA candidate that happens to beat the current classical incumbent is not called a quantum advantage.

## Comparison semantics

V1 reports objective comparison and candidate/classical objective ratio, but `quantumAdvantageClaimAllowed` is always `false` and the verdict is always:

`NOT_DEMONSTRATED_SIMULATOR_ONLY`

The simulator also reports deterministic statevector work units while the classical solver reports branch-and-bound explored nodes. These are architecture-specific accounting units and **must not** be interpreted as equal units of runtime or energy.

V1 makes no wall-clock speedup claim.

## Tenant boundary

`tenant-experiment.mjs` calls the real tenant Optimization Problem Builder boundary and then runs both the classical reference and simulator against that exact formulation.

After the experiment it re-reads tenant control and authorized evidence. Control-generation or evidence-manifest drift yields `STALE`.

The layer adds no provider-network client, no Google scraper, no remote QPU call, no browser/process execution, no publishing path, no CMS/site mutation, no external-link creation, and no tenant-control mutation authority.

## What V1 proves

V1 can prove that the solver-tournament plumbing is real: one bound optimization problem enters, a classical reference and a simulated quantum algorithm both operate on it, feasibility is checked under the same constraints, and the comparison is evidence-bound.

It cannot prove quantum hardware speedup, quantum economic advantage, or production superiority.

## Path to real QPU execution

A later hardware adapter should preserve the experiment contract while adding provider-neutral execution receipts, circuit/problem binding, hardware/backend identity, queue/execution evidence, shot counts, calibration metadata, and an independently verifiable result digest.

Only then can a hardware result be compared against the same certified classical baseline under predeclared metrics. If classical wins, classical remains the production choice. If a QPU wins, NEXUS must show exactly which metric improved and under what conditions.
