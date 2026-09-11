# JSON-RPC 2.0 control-plane contract

The Commander exposes `POST /rpc`. Every write-oriented method includes Nexus provenance (`source_revision`, `input_hash`, `idempotency_key`). Nexus enqueues only after its deterministic artifact bytes are committed. SEO AVENGERS returns result hashes and evidence; it never rewrites Nexus source files inside the render/capture request path.

Implemented methods:
- `seo.health`
- `seo.modules.list`
- `seo.client.activation` — expands the per-client `CONFIG_SEO_AVENGERS_200` switch into the 200-module activation plan while preserving eligibility/consent/advisory gates
- `seo.pagerank.submit` — queues module 16 and returns immediately
- `seo.job.get` — fetches background Go job state/result
- `seo.semantic.submit` — proxies to the FastAPI durable queue endpoint
- `seo.semantic.get` — fetches semantic job state/result

The Nexus outbox is consumed directly by the Commander goroutine and posted to FastAPI `POST /v1/semantic/sections`; this is intentionally not a synchronous render RPC.

The protobuf file in this directory mirrors the asynchronous job envelope for deployments that prefer gRPC/ConnectRPC.
