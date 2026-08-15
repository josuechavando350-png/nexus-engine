# NEXUS V7 Benchmark Baseline

Status: **baseline only**.

The repository contains `runtime/bench`, a Rust benchmark harness wired into the runtime Cargo workspace. The V7 benchmark baseline is currently limited to build-and-test validation of that harness through the full runtime workspace checks.

## Baseline scope

| Item | Status | Evidence |
| --- | --- | --- |
| Benchmark harness exists | IMPLEMENTED | `runtime/bench/Cargo.toml`, `runtime/bench/src/main.rs`. |
| Harness compiles in release workspace build | TESTED | `pnpm rust:build`. |
| Harness participates in workspace tests | TESTED | `pnpm rust:test` reports `nexus-bench` with 0 tests. |
| Performance measurements with thresholds | PLANNED | No thresholded benchmark report is committed yet. |
| Production SLO | PLANNED | No production SLO or live telemetry exists. |

## V7 interpretation

This baseline satisfies a minimal benchmark inventory requirement, not a production performance claim. Later performance-maturity work must add repeatable benchmark commands, representative datasets, declared thresholds and stored measurement results before raising any capability to `BENCHMARKED`. Their absence does not block the separately scoped V7 foundation/architecture closure, but it strictly blocks a benchmark maturity claim.
