# V9 Baseline Audit

## Starting point

V9 starts from the merged V8 closure on `main`. V8 provides Creative Vault, Art Direction Memory, Art Direction Engine, Creative Gallery, deterministic Motion Runtime, GPU/Shader planning, and Visual QA/benchmark regression evaluation infrastructure.

## What V8 already demonstrates

- repository-level lint, typecheck, tests, build, security hygiene, architecture gates and Rust validation;
- deterministic creative/runtime contracts and scope-isolation tests;
- evaluation contracts for visual/performance metrics and regression policy.

## What V8 explicitly does not demonstrate

- real browser/device visual capture;
- measured WebGPU/WebGL2/CPU benchmark runs on defined hardware;
- production soak/load/chaos evidence;
- SLO history from real operation;
- independent security certification;
- production-proven or operationally-evidenced maturity.

## V9 gap analysis

| Capability | V8 baseline | V9 target |
|---|---|---|
| Measurement Harness | absent | deterministic run/workload/environment contracts |
| Browser / Device Capture Port | absent | replaceable capture adapter boundary |
| Benchmark Executor | evaluation only | execute policy + raw sample evidence |
| Visual Evidence Pipeline | metric contracts | artifact/baseline/comparison lineage |
| Runtime Telemetry Evidence | metric contracts | run-linked captured measurements |
| Regression Governor | local evaluator | evidence-completeness-aware decisions |
| Operational Evidence Port | absent | replaceable evidence ingestion boundary |
| Evidence Gates | claim safety partial | measured-artifact-backed maturity gates |

## Non-goals

V9 does not reopen V8 architecture, does not move Experience logic into Industrial/Rust by default, and does not adopt a browser/vendor library as a core dependency. Adapters may use leading tools after explicit evaluation.

## Required V9 evidence qualities

Evidence must be attributable, scope-safe, unit-explicit, environment-explicit, reproducible enough to audit, immutable by identity, and distinguish measured values from fixtures/examples.
