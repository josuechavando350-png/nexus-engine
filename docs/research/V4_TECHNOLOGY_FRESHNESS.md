# V4 Technology Freshness Gate — 2026-08-13

This file records research, not a claim that external adapters were benchmarked in this environment.

## Primary-source findings

| Area | Candidates / evidence | Decision in this snapshot |
|---|---|---|
| Rust async | Tokio official docs describe async I/O, scheduling, timers, bounded-channel backpressure and sync/async bridging. | Keep V4 domain logic synchronous/deterministic by default. Tokio remains an adapter/runtime candidate for I/O services; do not async-color cognition. |
| Durable execution | Temporal official docs and Restate official docs both provide durable execution/recovery semantics. | Do not choose a vendor without NEXUS workload benchmark. NEXUS owns checkpoint/replay/effect-id semantics behind `DurableStore`. |
| Semantic retrieval | Qdrant documents filtered HNSW/payload indexing and hybrid retrieval. pgvector documents HNSW/IVFFlat tradeoffs. | No winner claimed. `MemoryStore` is vendor-neutral; benchmark recall + filtered latency + update/delete + restart/recovery before adapter selection. |
| Tool interoperability | MCP is an open protocol for model/tool/context interoperability. | Treat MCP as an adapter boundary, never as NEXUS authority or cognitive core. |

## Primary sources consulted
- Rust/Tokio: https://tokio.rs/ and official Rust release blog.
- Temporal: https://docs.temporal.io/
- Restate: https://docs.restate.dev/foundations/key-concepts
- Qdrant: https://qdrant.tech/documentation/
- pgvector: https://github.com/pgvector/pgvector
- MCP specification: https://modelcontextprotocol.io/specification/2025-06-18

## Benchmark requirement before choosing adapters
Measure our workload: planning success, schema adherence, retrieval recall@k, filtered p50/p95/p99, ingest/update/delete, crash recovery, replay correctness, CPU/RAM and cost where observable. Third-party numbers are context only.
