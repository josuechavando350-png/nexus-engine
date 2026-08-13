# V5 Technology Freshness — 2026-08 candidate record

This document records candidates, not unmeasured winners.

| Area | Candidates | Candidate stance | Why | Benchmark/proof still required |
|---|---|---|---|---|
| Fine-grained authorization | OpenFGA, Cedar, OPA | Keep behind `AuthorizationEngine` | Different strengths: relationship graph vs application authorization language vs general policy engine | authorization latency, model expressiveness, consistency, operational failure behavior |
| Workload identity | SPIFFE/SPIRE, cloud-native workload identities | SPIFFE adapter is strong portable candidate | attested cryptographic workload identity, infrastructure portability | issuance/rotation load, failure/recovery, deployment complexity |
| Secrets | Vault, cloud KMS/secret managers | `SecretBroker` first | dynamic/rotatable identity-based secret delivery is valuable; avoid provider lock-in | lease latency, HA behavior, rotation, incident recovery |
| Observability | OpenTelemetry + selectable backend | preferred interoperability boundary | vendor-neutral traces/metrics/logs | overhead under NEXUS workload, sampling behavior, exporter failure |
| External API | axum HTTP/JSON, tonic gRPC | benchmark both | axum/Tower composability vs tonic typed RPC/interoperability | p50/p95/p99, CPU/RAM, payload sizes, SDK ergonomics |

No row is a production selection until measured in NEXUS's workload.

## Rust baseline note
Official Rust stable is 1.97.0 as of 2026-07-09, while the inherited workspace still declares edition 2021 / rust-version 1.75. Do **not** mix a workspace-wide edition/toolchain migration into V5 before the uncompiled V3/V4 baseline first builds. Repair pass order: compile inherited baseline, then evaluate a dedicated migration to Rust 2024 / current stable with `cargo fix --edition`, tests and benchmarks. This isolates migration failures from existing compile failures.
