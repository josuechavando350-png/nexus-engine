# NEXUS — REPAIR LOG

Date: 2026-08-13
Baseline: `NEXUS_V6_BUILD_CANDIDATE.zip`
Pass: 1 — static/compiler-preparation repair

## Rule

This pass does not claim Rust compile/test success. The execution environment has no `cargo`/`rustc` and no network egress. Only executed checks are reported as PASS.

## Repairs applied

### R001 — V6 distributed demo borrowed temporaries
File: `runtime/examples/distributed-factory/src/main.rs`

The `DistributedRuntime` previously borrowed `DeterministicConsensus::default()` and `DeterministicPlacement` directly from temporaries in the struct literal. The demo now binds both values to local variables before borrowing them. This removes a likely temporary-lifetime compile failure and makes ownership explicit.

### R002 — Replication gap poisoned idempotency state
File: `runtime/crates/nexus-replication/src/lib.rs`

Before this pass, `idempotency_key` was inserted into `seen` before sequence-gap validation. A sequence-2 operation arriving before sequence-1 returned `GapDetected` but was already marked seen; retrying sequence-2 after repairing the gap then returned `Duplicate`, permanently dropping the operation.

The operation is now inserted into `seen` only after gap/stale validation succeeds. Added regression test `gap_is_not_poisoned_as_seen`.

### R003 — Placement score integer overflow/wrap risk
File: `runtime/crates/nexus-placement/src/lib.rs`

Capacity-derived `u64` values were cast directly to `i64` and then added. Very large capacities could wrap during cast/addition. Scores are now clamped to `i64::MAX` and combined with `saturating_add`.

### R004 — Resource create could overwrite existing state
File: `runtime/crates/nexus-registry/src/lib.rs`

`put(record, None)` previously behaved as an unconditional upsert. V5 `Create` could overwrite an existing resource without optimistic-concurrency evidence. Create now fails when the resource already exists and requires version 1. Added regression test `create_cannot_overwrite`.

### R005 — Resource update did not enforce exact version advancement
Files:
- `runtime/crates/nexus-registry/src/lib.rs`
- `runtime/crates/nexus-control-plane/src/lib.rs`

Updates now require the submitted record version to equal `expected_version`, then the control plane advances it exactly once before registry persistence. Registry persistence rejects any update that does not equal `expected_version + 1`. Added regression test `update_must_advance_one_version`.

### R006 — Consensus proof accepted impossible quorum sizes
File: `runtime/crates/nexus-consensus/src/lib.rs`

`CommitProof::valid()` previously checked only `quorum > voters / 2`. A proof where `quorum > voters` could therefore be accepted. Validation now requires `0 < quorum <= voters` and strict majority.

### R007 — Version overflow no longer saturates silently
Files: `nexus-control-model`, `nexus-registry`, `nexus-control-plane`

Added checked version advancement. An update/archive at `u64::MAX` now fails instead of preserving the same version through saturation. Registry computes `expected + 1` with `checked_add`.

### R008 — Cluster rejects globally stale epochs and supports explicit re-enrollment
File: `runtime/crates/nexus-cluster/src/lib.rs`

Member upserts older than the cluster epoch are rejected. Tombstoned nodes remain blocked from ordinary upsert, but can now return only through explicit `reenroll` with an epoch strictly newer than the current cluster epoch. Regression coverage extended.

### R009 — Fleet rollout cannot target zero rings
File: `runtime/crates/nexus-fleet/src/lib.rs`

`RolloutPlan::validate` now rejects an empty `target_rings` set.

### R010 — Mesh identity requires attested-node identity
File: `runtime/crates/nexus-mesh/src/lib.rs`

A workload identity is no longer considered valid when its `attested_node` is empty.

### R011 — Placement refuses to silently ignore anti-affinity
File: `runtime/crates/nexus-placement/src/lib.rs`

The deterministic baseline previously exposed `anti_affinity_key` but ignored it. It now fails explicitly when anti-affinity is requested until a placement-state adapter capable of enforcing the constraint is supplied. Silent policy weakening is forbidden.

### R012 — Memory query ordering fixed
File: `runtime/crates/nexus-memory/src/lib.rs`

Queries previously depended on reverse lexical record ID order. Results are now ordered by `created_at` descending with ID as deterministic tie-breaker, then truncated to the query limit. Added regression coverage.

### R013 — Goal and reasoning monotonicity strengthened
Files: `runtime/crates/nexus-goal/src/lib.rs`, `runtime/crates/nexus-reasoning/src/lib.rs`, `runtime/crates/nexus-planner/src/lib.rs`

Goal transitions reject timestamps older than the current goal state. Reasoning steps must have sequential indices. Empty plans are rejected rather than entering evaluation/execution as structurally valid plans.

## Executed after repairs

- `node --check scripts/*.mjs` — PASS
- `node scripts/v3-architecture-gates.mjs` — PASS for all executable gates; Rust gate NOT TESTED
- `node scripts/v4-architecture-gates.mjs` — PASS
- `node scripts/v5-architecture-gates.mjs` — PASS
- `node scripts/v6-architecture-gates.mjs` — PASS
- `node scripts/quality-gates.mjs` — static architecture/security/originality/industrial portions PASS; package-manager/Rust-dependent portions remain NOT TESTED

## Remaining blocker

The next authoritative repair pass must start with a real Rust compiler and run, in dependency order:

1. `cargo fmt --all --check`
2. `cargo check --workspace`
3. `cargo clippy --workspace --all-targets -- -D warnings`
4. `cargo test --workspace`
5. default release build
6. feature-adapter builds (`kafka`, `neo4j`, `wasmtime`, `ed25519`)
7. E2E demos V3/V4/V6
8. benchmarks/failure injection
9. audit/deny/SBOM

Repair the first compiler error, rerun the narrow crate, then rerun the workspace. Do not batch speculative fixes.
