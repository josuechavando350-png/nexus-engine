# NEXUS V3 — Industrial Agentic Runtime

The second execution plane of NEXUS. It shares a repository with the V2
Experience Engine and shares nothing else: no code, no dependencies, no build
step, no runtime coupling.

```text
NEXUS
├── Core / Experience Plane        (V2, TypeScript)
│   ├── @nexus/core
│   └── @nexus/experience
│
└── Industrial Agentic Plane       (V3, Rust — this tree)
    ├── Data Plane                 nexus-event, nexus-ingest
    ├── Ontology                   nexus-ontology, nexus-graph
    ├── Agent Runtime              nexus-agent
    ├── Policy / Safety            nexus-policy
    ├── Edge                       nexus-edge-protocol, nexus-edge-wasm
    ├── One-way Gateway            nexus-oneway
    ├── Simulation                 nexus-sim
    └── Observability              nexus-observability
```

`pnpm` never builds this tree and `cargo` never builds the TypeScript one.
`runtime/` is outside the pnpm workspace globs, and no crate here depends on
anything in `packages/`.

## What it is for

Industrial infrastructure, civil robotics, inspection, maintenance, logistics,
defensive monitoring, simulation and research.

## What it will not do

There is no targeting, no fire control, no weapon interface and no lethal
autonomy, and these are not conventions. `nexus-policy::invariants` refuses
weapon and human-targeting capabilities before any configurable rule is
consulted, `DetectionClass` is a closed set with no person-identification
class, and `scripts/v3-architecture-gates.mjs` fails the build if either is
weakened. See [`docs/architecture/V3_ARCHITECTURE.md`](../docs/architecture/V3_ARCHITECTURE.md).

## Quick start

No infrastructure and no network are required for the default build.

```bash
cd runtime

cargo test --workspace              # every crate, in-memory backends
cargo run -p factory-line           # the full end-to-end demo, offline
cargo run -p warehouse-robot        # approval gate and safe-stop behaviour
cargo run -p inspection-drone-sim   # simulation-first planning
cargo run -p nexus-bench -- --help  # load generator
```

With infrastructure:

```bash
cp .env.example .env                # fill in credentials
docker compose -f docker/docker-compose.yml up -d
cargo run -p ingestd --features kafka
cargo run -p graphd  --features neo4j
```

## Dependency policy

The default feature set of every crate has **zero external dependencies**. The
whole pipeline — envelope, JSON codec, SHA-256, ontology, entity resolution,
policy, orchestration, simulation, the edge sandbox in `SIMULATION` mode, the
one-way gateway and the audit trail — is standard library only.

Third-party code enters only through opt-in features:

| Feature | Crate | Brings in | Purpose |
|---|---|---|---|
| `kafka` | `nexus-ingest` | `rdkafka`, `tokio` | Kafka / Redpanda data highway |
| `neo4j` | `nexus-graph` | `neo4rs`, `tokio` | Neo4j / Memgraph backend |
| `wasmtime` | `nexus-edge-wasm` | `wasmtime` | Production WASM sandbox |
| `ed25519` | `nexus-edge-protocol` | `ed25519-dalek` | Production signatures |

This is a deliberate trade. It costs a hand-written JSON codec and hash. It
buys a hermetic, offline, reproducible default build, an audited surface that
is the workspace itself, and ports that are provably swappable because the
default implementation already sits behind them.

## Crates

| Crate | Responsibility |
|---|---|
| `nexus-event` | Canonical envelope, JSON, SHA-256, dedup, sequence tracking, detection contract |
| `nexus-ingest` | Consumer/producer ports, backpressure, retry, DLQ, idempotency, pipeline |
| `nexus-ontology` | Entities, relations, temporal facts, provenance, storage ports, entity resolution |
| `nexus-graph` | Backends behind those ports: in-memory (default), Cypher, Neo4j (feature) |
| `nexus-policy` | Hard invariants and configurable rules. Nothing physical happens without it |
| `nexus-agent` | `BehaviorModel`, task proposals, orchestration, `HumanApprovalGate` |
| `nexus-edge-protocol` | Typed signed commands, nonce, expiry, capability allowlist |
| `nexus-edge-wasm` | Sandboxed execution: fuel, memory cap, timeout, host allowlist, module hash |
| `nexus-oneway` | `OBSERVATION_DIODE` and `CONTROLLED_EDGE` profiles |
| `nexus-sim` | Minimal world model, deterministic replay, dry runs, failure injection |
| `nexus-observability` | Structured logs, metrics, health, hash-chained audit trail |

## Services

| Service | Role |
|---|---|
| `ingestd` | Validates, deduplicates and normalizes inbound telemetry and detections |
| `graphd` | The only writer to the ontology |
| `orchestratord` | Proposals, policy evaluation, simulation, approval, signing |
| `gatewayd` | Zone-crossing egress under a one-way profile |

## Honest limitations

- **Not exactly-once.** At-least-once delivery, effectively-once graph effect
  via idempotency keys. The broker and the graph are not in one transaction
  and nothing claims otherwise.
- **Software is not a data diode.** `nexus-oneway` reduces a bidirectional
  substrate to a one-directional protocol. Physical unidirectionality requires
  hardware this repository does not contain.
- **The dedup window is bounded and therefore lossy.** Evictions are counted
  and exported so the window can be sized from measurement.
- **`DevSigner` is not cryptography.** It exists for tests and `SIMULATION`
  mode and refuses to operate in `PHYSICAL_NON_WEAPONIZED` mode.
- **No performance claim is made without a benchmark.** See
  [`docs/research/V3_PERFORMANCE_TARGETS.md`](../docs/research/V3_PERFORMANCE_TARGETS.md).
- **The feature-gated adapters have not been compiled.** See
  `NEXUS_V3_VALIDATION.txt` for exactly what was and was not executed.

## Gates

```bash
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --workspace
cargo build --workspace --release
cargo audit
cargo deny check
node ../scripts/v3-architecture-gates.mjs     # runs without cargo
```
