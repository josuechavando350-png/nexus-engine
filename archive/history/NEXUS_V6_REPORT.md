# NEXUS V6 — Distributed Runtime — BUILD CANDIDATE REPORT

Date: 2026-08-13  
Baseline: `NEXUS_V5_BUILD_CANDIDATE.zip`  
Target branch: `nexus-v6`  
Status: **BUILD CANDIDATE — NOT CLOSED**

## 1. Scope implemented in source

V6 adds 11 provider-neutral Rust crates plus `clusterd` and a `distributed-factory` demo skeleton:

- `nexus-cluster` — node membership, roles, health, capacity, epochs and stale-node tombstones.
- `nexus-consensus` — NEXUS-owned consensus contract, consistency intent and commit proof semantics.
- `nexus-replication` — immutable replicated operations, idempotency, watermarks and gap detection.
- `nexus-placement` — deterministic hard-constraint filtering and ranking.
- `nexus-discovery` — leased/health-filtered service endpoint contract.
- `nexus-federation` — explicit scoped expiring trust-domain grants.
- `nexus-offline` — ordered offline journal and reconciliation contract.
- `nexus-mesh` — workload identity and peer-authorization contracts independent of transport.
- `nexus-fleet` — device lifecycle and staged rollout policy.
- `nexus-update` — signed-update verification boundary, SBOM/provenance identities and rollback rejection.
- `nexus-distributed` — composition root requiring prior policy evidence and artifact digest before placement.

Workspace now contains 56 members, 95 Rust files and approximately 19,100 lines of Rust source.

## 2. Cross-version safety invariant

V6 decides where approved work may run and how distributed state is coordinated. It does **not** decide whether a physical action is safe or authorized.

No V6 core crate imports or constructs V3 `EdgeTask`. The V6 composition root requires `policy_evidence_id` before placement. Physical actions still must traverse the inherited V3/V4/V5 authority and safety path.

## 3. Technology Freshness Gate — source research

Research was performed against current primary/official documentation on 2026-08-13.

### Rust
The official Rust release channel reports Rust 1.97.1, released 2026-07-16. The inherited repository remains on Rust 2021 with `rust-version = 1.75`. The migration is intentionally deferred until the final repair pass so toolchain/edition migration does not obscure inherited compile defects.

### Consensus / coordination
- OpenRaft 0.9.24 is a current Rust Raft engine candidate with replicated-log, storage, membership and snapshot APIs.
- etcd 3.7 documentation is current in July 2026 and exposes mature v3 coordination APIs and leases.

NEXUS does not select a winner without its own benchmarks. `ConsensusEngine` remains NEXUS-owned.

### Scheduling
Kubernetes' scheduling framework remains a mature pluggable reference using filtering/scoring/binding. NEXUS needs placement across containers, VMs, bare metal and constrained edge, so Kubernetes is treated as an adapter/deployment target rather than the V6 domain model.

### Identity / mesh
SPIFFE Workload API/SPIRE are candidates for short-lived attested workload identity. WireGuard is a candidate L3 secure tunnel. Quinn is a current pure-Rust QUIC implementation candidate for selected application paths. Identity, authorization and transport stay separate.

### Discovery
etcd, Consul, Kubernetes-native discovery and DNS are candidates behind `Discovery`.

### Secure updates
TUF is a candidate repository-update security framework. Sigstore/cosign is a candidate artifact signature/provenance/transparency mechanism. NEXUS owns rollout state, health gates and rollback semantics.

No benchmark winner is claimed in this build candidate.

## 4. Proprietary / replacement-difficulty focus

Commodity candidates remain replaceable. V6-specific value is intended to reside in cross-layer semantics:

- membership epochs and stale-node non-resurrection;
- explicit consistency intent rather than universal strong consistency;
- replication operation identity and surfaced gaps;
- constraint-first placement tied to policy evidence;
- explicit non-transitive federation grants;
- offline reconciliation that cannot manufacture authority;
- secure transport separated from permission;
- rollout rings, quarantine/drain state and health thresholds;
- release manifests binding artifact, SBOM and provenance identities;
- anti-rollback semantics;
- composition with V3 safety, V4 cognition and V5 authorization.

See `docs/research/V6_REPLACEMENT_DIFFICULTY.md`.

## 5. Executed validation

Executed successfully in this environment:

- `node --check` for V3/V4/V5/V6 architecture-gate scripts.
- V3 architecture gates: 11 PASS, 0 FAIL, 1 NOT TESTED (Rust toolchain gate).
- V4 architecture gates: all executable gates PASS.
- V5 architecture gates: all executable gates PASS.
- V6 architecture gates: all executable gates PASS.
- Existing quality gates: Architecture PASS, Security PASS, Originality PASS, Industrial plane PASS; Accessibility WARNING; TypeScript/test/build/performance/dependency gates NOT TESTED because installed package tooling/build artifacts are unavailable.

## 6. Not tested / not implemented

The environment still has no `cargo` or `rustc`.

Therefore the following are **NOT TESTED**:

- `cargo fmt --all --check`;
- `cargo check --workspace`;
- `cargo clippy --workspace --all-targets --all-features -- -D warnings`;
- `cargo test --workspace --all-features`;
- `cargo build --workspace --release --all-features`;
- `cargo audit`;
- `cargo deny check`;
- `distributed-factory` execution;
- real multi-node consensus;
- real replication/anti-entropy;
- region/zone/node failure injection;
- offline reconnect/reconciliation against durable infrastructure;
- SPIFFE/SPIRE integration;
- WireGuard/QUIC transport integration;
- etcd/Consul/Kubernetes discovery adapters;
- TUF/Sigstore integration;
- real fleet rollout;
- p50/p95/p99/CPU/RAM/network benchmarks.

No item above is represented as PASS.

## 7. Repair-friendly design

`docs/research/V6_REPAIR_MAP.md` specifies a dependency-local compile order and expected mechanical hotspots. V6 core crates are intentionally small and provider-neutral so compiler/API fixes can remain isolated.

The V6 architecture gates also prohibit `TODO`, `FIXME`, `todo!`, `unimplemented!` and unsafe code in V6 critical core.

## 8. CI changes

`.github/workflows/rust.yml` now:

- runs V3-V6 static architecture gates;
- accepts `nexus-v6` branch;
- compiles/tests the expanded workspace when a Rust runner is available;
- runs the V6 `distributed-factory` demo;
- preserves optional adapter checks and supply-chain jobs;
- emits V6-named SBOM artifacts.

## 9. Due-diligence value gate

`docs/research/V6_VALUE_GATE.md` makes the US$1M+ objective explicitly evidence-dependent. This build candidate does not claim that value and is not allowed to do so until performance, failure recovery, deployability, supply-chain, operational and replacement-difficulty evidence exists.

## 10. Visual console

No generic distributed-systems dashboard was generated. Any human-facing V6 experience still requires the NEXUS visual process: reference -> visual dissection -> Art Direction DNA -> one screen -> human approval -> implementation -> screenshot comparison -> correction -> responsive -> performance/a11y.

## 11. Final closure path

1. Repair/compile V3, then V4, then V5, then V6 according to repair maps.
2. Upgrade Rust/MSRV/edition in isolated commits only after baseline is green.
3. Implement and compare real adapters.
4. Run distributed fault injection and benchmarks.
5. Run supply-chain gates and generate SBOM.
6. Run clean-deploy external reproduction.
7. Execute the V6 Value Gate.
8. Only then rename the artifact to `NEXUS_V6_FULL_REPO.zip`, produce final validation/SHA and close/tag `nexus-v6`.
