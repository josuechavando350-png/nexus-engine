# V6 Technology Freshness Gate — 2026-08-13

Status: RESEARCHED; benchmark winners NOT YET SELECTED.

## Rust
Official Rust release channel reports 1.97.1 current as of 2026-07-16. The inherited repo remains on Rust 2021 with rust-version 1.75 so migration is deferred to the final repair pass to avoid mixing language-edition migration with inherited compile defects.

## Consensus
**OpenRaft 0.9.24** is a current Rust Raft engine candidate with membership-change, snapshot and storage APIs. **etcd 3.7** is also current and exposes mature coordination primitives through its v3 API. Decision: keep `ConsensusEngine` NEXUS-owned; benchmark embedded OpenRaft vs external etcd for control-plane coordination workload.

## Scheduling
Kubernetes' scheduling framework remains a mature pluggable reference for filter/score/bind scheduling, but NEXUS must also place workloads on bare-metal/edge targets. Decision: retain NEXUS `PlacementPolicy`; Kubernetes is an adapter/deployment target rather than the domain model.

## Workload identity
SPIFFE Workload API and SPIRE remain primary candidates for short-lived attested workload identity. NEXUS owns the trust-domain/federation authorization semantics.

## Service discovery
Compare etcd leases/watch, Consul catalog/DNS, Kubernetes native discovery and simple DNS for workloads that do not require a full control store.

## Mesh / transport
WireGuard is a candidate L3 secure tunnel with a deliberately small protocol surface; Quinn is a current pure-Rust QUIC implementation candidate for application-level multiplexed transport. The layers solve different problems and must not be conflated.

## Updates / supply chain
TUF provides repository metadata and client verification semantics designed to resist update-system attacks. Sigstore/cosign provides artifact signing, verification and transparency-log/in-toto integrations. V6 should compose signed provenance with NEXUS rollout/rollback semantics instead of inventing signature infrastructure.

## Benchmark matrix required before closure
| Area | Candidates | NEXUS workload | Required evidence |
|---|---|---|---|
| consensus | OpenRaft, etcd | 3/5/7 node control mutations, failover, snapshot/rejoin | write/read p50/p95/p99, failover time, CPU/RAM, recovery correctness |
| discovery | etcd, Consul, K8s, DNS | register/renew/resolve/churn | convergence, stale endpoint window, p99, failure behavior |
| transport | QUIC/Quinn, gRPC/Tonic over TCP, mesh tunnel path | control RPC + event bursts | latency, throughput, loss recovery, CPU/RAM |
| mesh | SPIFFE+TLS, WireGuard+identity composition | cross-node workload auth | connection setup, rotation, failure/expiry semantics |
| placement | NEXUS deterministic, K8s adapter | mixed cloud/edge capacity constraints | valid placement rate, scheduling latency, churn stability |
| updates | TUF implementation + Sigstore integration | staged 1/10/1000 node rollout | verification latency, rollback rejection, partial failure recovery |

No winner is claimed before these measurements exist.
