# NEXUS V4 — Autonomous Intelligence Engine — Build Candidate Report

Date: 2026-08-13  
Baseline: `NEXUS_V3_FULL_REPO.zip` supplied by the user  
Status: **BUILD CANDIDATE / NOT CLOSED**

## What was built

V4 adds eleven Rust crates and one cognitive demo:

- `nexus-memory`: five memory classes, provenance, temporal validity, confidence, vendor-neutral `MemoryStore`.
- `nexus-goal`: persistent closed goal state machine, history, cancellation/blocking and bounded retry budget.
- `nexus-planner`: versioned typed plan DAG, evidence binding, cycle/missing-dependency rejection and candidate scoring.
- `nexus-reasoning`: explicit step/model/tool budgets and structured reasoning artifacts rather than hidden chain-of-thought storage.
- `nexus-model`: provider-independent `ModelProvider`, capability profiles and model router plus deterministic replay fixture.
- `nexus-world-model`: Observed/Inferred/Predicted/Simulated/Committed fact classes and speculative branch rules.
- `nexus-durable`: NEXUS-owned checkpoint/effect-id/replay semantics behind a replaceable store; replay cannot physically dispatch.
- `nexus-evaluator`: independent structured evaluation contracts.
- `nexus-recovery`: typed failure taxonomy and bounded recovery decisions; policy denial fails closed.
- `nexus-agents-v4`: typed agent roles and capability-subset delegation that cannot elevate authority.
- `nexus-intelligence`: integrates evidence-grounded memory + persistent goals + planning into a `CognitiveDecision` that MUST return to V3 gates.

`nexus-intelligence` deliberately does not depend on `nexus-edge-protocol`, `Signer`, or a WASM/edge adapter. It cannot dispatch hardware. The only intended physical path remains V3 policy -> simulation -> approval when required -> signed typed EdgeTask -> sandbox.

## Technology Freshness

Primary-source research was recorded in `docs/research/V4_TECHNOLOGY_FRESHNESS.md`. The candidate deliberately avoids selecting a durable-execution vendor, vector backend or production model provider without a NEXUS workload benchmark. Temporal and Restate remain candidates for durable execution; Qdrant and pgvector remain semantic-retrieval candidates; Tokio remains an I/O runtime candidate without async-coloring cognitive domain code; MCP is treated as interoperability, not authority or cognitive architecture.

## Replacement difficulty / IP

The IP claim is not "we installed agent frameworks." V4 owns semantics that commodity components do not define together: provenance-aware memory classes, closed persistent goals, evidence-bound typed plan DAGs, world-state class separation, side-effect-free replay, committed-effect identity, capability-subset delegation, bounded recovery and the hard cognitive-to-V3 execution boundary.

See `docs/research/V4_REPLACEMENT_DIFFICULTY.md`.

## Executed evidence

See `NEXUS_V4_VALIDATION.txt`.

Static V4 architecture gates PASS. Existing V3 executable static architecture gates continue to PASS after the V4 additions. Rust compilation/tests are NOT TESTED because this environment has no cargo/rustc. No benchmark number is claimed.

## Open risks before closure

1. Every new Rust crate still requires first compilation and clippy.
2. V3 itself still has Rust gates pending in the supplied baseline; V4 cannot be canonically closed over an unclosed V3.
3. Production memory, durable-execution and model adapters intentionally remain unselected until comparative NEXUS workload benchmarks can run.
4. Failure injection, crash recovery and deterministic replay require executable integration tests, not only contract-level tests.
5. No V4 performance number is measured yet.

## Required closure sequence

1. Close V3 Rust + adapter + E2E + benchmark gates.
2. Run V4 `cargo fmt`, clippy, tests and release build.
3. Fix compiler/API defects as ordinary commits.
4. Run V4 cognitive demo and full V3 physical execution chain.
5. Implement/benchmark at least two serious candidates for critical replaceable adapters where applicable.
6. Execute crash/failure-injection and replay safety tests.
7. Execute supply-chain gates and produce SBOM.
8. Record p50/p95/p99, CPU/RAM and benchmark environment.
9. Only then rename/promote the candidate to canonical `NEXUS_V4_FULL_REPO.zip` and mark V4 closed.
