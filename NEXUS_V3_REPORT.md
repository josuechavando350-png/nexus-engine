# NEXUS V3 — Industrial Agentic Runtime — Delivery Report

Branch: `nexus-v3`
Baseline: `NEXUS_V2_FULL_REPO.zip` (unmodified V2 tree, worked on in place)
Date: 2026-08-13

> Read `NEXUS_V3_VALIDATION.txt` before quoting any status in this document.
> The build environment had **no Rust toolchain and no network access**, so
> every cargo gate is `NOT TESTED`. Nothing here is reported as passing that
> was not actually executed.

---

## 1. File tree added

83 new files. V2 was not restructured; six existing files were extended.

```text
runtime/                                    # new Rust workspace, outside pnpm
├── Cargo.toml                              # 19 members, dependency policy
├── rust-toolchain.toml                     # pinned 1.83.0
├── deny.toml                               # licences, bans, sources
├── .env.example                            # every setting, no credentials
├── README.md
├── docker/docker-compose.yml               # Redpanda + Neo4j + topic creation
│
├── crates/
│   ├── nexus-event/                        # envelope, JSON, SHA-256, dedup, detection
│   │   └── src/{lib,envelope,json,hash,ids,time,classification,dedup,detection,error}.rs
│   ├── nexus-observability/                # logs, metrics, health, hash-chained audit
│   │   └── src/{lib,log,metrics,audit,health}.rs
│   ├── nexus-policy/                       # hard invariants + configurable rules
│   │   └── src/{lib,invariants,rules}.rs
│   ├── nexus-ontology/                     # model, ports, entity resolution
│   │   └── src/{lib,model,store,resolution}.rs
│   ├── nexus-graph/                        # backends behind the ports
│   │   └── src/{lib,memory,cypher,backend,neo4j}.rs
│   ├── nexus-ingest/                       # bus ports, pipeline, resilience, config
│   │   └── src/{lib,bus,pipeline,resilience,config,kafka}.rs
│   ├── nexus-edge-protocol/                # typed signed commands
│   │   └── src/{lib,task,command,signing}.rs
│   ├── nexus-edge-wasm/                    # sandbox, manifest, host allowlist
│   │   └── src/{lib,runtime,manifest,host,wasmtime_host}.rs
│   ├── nexus-agent/                        # behaviour model, proposals, approval
│   │   └── src/{lib,behavior,proposal,orchestrator,approval}.rs
│   ├── nexus-sim/                          # world model, dry runs, fault injection
│   │   └── src/{lib,world}.rs
│   └── nexus-oneway/                       # OBSERVATION_DIODE / CONTROLLED_EDGE
│       └── src/lib.rs
│
├── services/{ingestd,graphd,orchestratord,gatewayd}/src/main.rs
├── examples/{factory-line,warehouse-robot,inspection-drone-sim}/src/main.rs
└── bench/src/main.rs                       # load generator + harness

docs/architecture/V3_{ARCHITECTURE,DATA_PLANE,ONTOLOGY,ORCHESTRATION,
                      EDGE_RUNTIME,ONEWAY_SECURITY,PHYSICAL_AGENTS}.md
docs/security/V3_{THREAT_MODEL,TRUST_BOUNDARIES}.md
docs/research/V3_{PERFORMANCE_TARGETS,FAILURE_MODES}.md

scripts/v3-architecture-gates.mjs           # 12 gates, no toolchain required
tests/v3-boundaries.test.ts                 # plane separation in Vitest
.github/workflows/rust.yml                  # 4 CI jobs
```

Modified V2 files (additive only, no V2 behaviour changed):

| File | Change |
|---|---|
| `package.json` | version 3.0.0; added `v3-gates`, `rust:*`, `demo:e2e` scripts |
| `AGENTS.md` | V3 plane contract and its non-negotiable rules |
| `README.md` | two-plane overview |
| `eslint.config.mjs` | ignore `runtime/**` |
| `.gitignore` | `runtime/target/`, `runtime/.env`, SBOM output |
| `scripts/quality-gates.mjs` | two new gates: Industrial plane, Rust toolchain |

**18,716 lines of Rust across 58 files, 287 test functions in 41 test modules.**

---

## 2. Architecture summary

Two planes, one repository, no coupling.

```text
NEXUS
├── Core / Experience Plane      @nexus/core, @nexus/experience   (V2, TypeScript)
└── Industrial Agentic Plane     runtime/                         (V3, Rust)
    ├── Data Plane               nexus-event, nexus-ingest
    ├── Ontology                 nexus-ontology, nexus-graph
    ├── Agent Runtime            nexus-agent
    ├── Policy / Safety          nexus-policy
    ├── Edge                     nexus-edge-protocol, nexus-edge-wasm
    ├── One-way Gateway          nexus-oneway
    ├── Simulation               nexus-sim
    └── Observability            nexus-observability
```

`pnpm` never builds `runtime/` (it is outside the workspace globs) and `cargo`
never builds the TypeScript tree. No crate depends on `packages/`; no package
depends on Rust.

Execution chain: sensor → bus → ingest (validate, verify integrity,
deduplicate, normalize) → ontology (resolve, provenance) → graph → correlation
→ proposal → policy → simulation → approval where required → signed typed
`EdgeTask` → WASM sandbox → result as telemetry → audit → graph update.

---

## 3. Technical decisions

### 3.1 Zero external dependencies in the default build

The default feature set of every crate is standard library only. Adapters that
need third-party code are opt-in features: `kafka` (rdkafka), `neo4j`
(neo4rs), `wasmtime`, `ed25519` (ed25519-dalek).

**Why.** Reproducible offline builds; an audited attack surface that is the
workspace itself; and ports that are provably swappable, because a second
implementation already sits behind each one.

**Cost, stated plainly.** A hand-written JSON codec and SHA-256. Both were
de-risked before being written: the algorithms were implemented in JavaScript
first and validated against the published FIPS 180-4 vectors and against
`node:crypto` over 3,000 differential inputs, and the JSON codec was fuzzed
against `JSON.parse`/`JSON.stringify` over 6,000 documents plus 19 malformed
inputs. The Rust is a line-by-line transliteration of the validated logic and
carries the same vectors as regression tests. This validates the *algorithm*;
it does not validate that the Rust compiles.

### 3.2 The ontology names no database

`nexus-ontology` defines entities, relationships, temporal facts, provenance
and storage ports. It contains no driver, connection string, query language or
vendor row type. Backends live only in `nexus-graph`. Enforced by CI gate, not
by convention.

### 3.3 Prohibitions are compiled, not configured

`nexus-policy::invariants` runs before any configurable rule and can only
deny. 36 prohibited terms are matched across the action name, zone, every
requested capability and every free-text annotation, in any casing. A test
asserts that a rule set consisting of nothing but "allow everything" still
cannot get a weapons request or an unapproved high-impact action through.

`DetectionClass`, `EntityKind`, `RelationKind` and `ActionKind` are closed
enums whose parsers reject unknown values. There is no person-identification,
re-identification or tracking class. `PersonnelPresenceInRestrictedZone` exists
only as a stop condition: it carries no identity and forces a safe stop.

### 3.4 Synchronous ports, async confined to adapters

Making the ontology, policy engine, orchestrator and simulator async would
colour the whole codebase for the benefit of two optional adapters and would
complicate deterministic replay. Each async adapter owns its runtime
internally. The safety-critical path is ordinary synchronous code.

### 3.5 `nexus-policy` depends on nothing

Not even on `nexus-event`. It is the layer everything trusts, so it has the
smallest possible reviewable surface.

### 3.6 Merges are recorded, never destructive

Entity merges write a `SAME_AS` edge and a `merged_into` marker; reads follow
it. A destructive merge would destroy the evidence that a merge happened,
making an incorrect resolution impossible to unwind. No generated Cypher
statement contains `DELETE` or `DROP` — asserted by test.

### 3.7 Honest delivery semantics

At-least-once broker delivery; effectively-once graph effect via content-derived
idempotency keys plus a bounded dedup window; ordering per
`(source_id, stream)` only. Exactly-once end to end is **not** provided,
because the broker offset commit and the graph write are not in one
transaction, and it is not claimed anywhere.

### 3.8 `DevSigner` is not cryptography

It exists for tests and `SIMULATION` mode, is documented as such at every point
of use, and refuses to operate in `PHYSICAL_NON_WEAPONIZED` mode.

### 3.9 Static architecture gates as a first-class tool

`scripts/v3-architecture-gates.mjs` runs with plain `node`, no npm install, no
cargo, no network. It checks the rules a compiler cannot: plane separation,
ontology decoupling, edge execution safety, invariant integrity, secret
hygiene, honest security claims, workspace integrity, module wiring,
delimiter balance, unused imports, and cross-crate symbol resolution.

---

## 4. Commands executed

```bash
# environment probing
cargo --version                         # not found
apt-get install -y rustc cargo          # 403 Forbidden on every .deb
curl https://static.rust-lang.org/...   # 403 host_not_allowed
curl https://crates.io                  # 403 host_not_allowed
curl https://registry.npmjs.org         # 403 host_not_allowed

# algorithm validation before writing the Rust
node verify/sha_test.mjs                # PASS  (4 FIPS vectors + 3000 fuzz)
node verify/json_test.mjs               # PASS  (6000 docs + 19 rejections)

# repository gates
node scripts/v3-architecture-gates.mjs  # 11 PASS, 0 FAIL, 1 NOT TESTED
node scripts/quality-gates.mjs          # see section 5
node --check scripts/*.mjs              # syntax OK
node /tmp/verify_boundaries.mjs         # 14/14 boundary assertions PASS

# not executable in this environment
cargo fmt / clippy / test / build / audit / deny
pnpm install / lint / typecheck / test / build
docker compose up
```

---

## 5. Real results

### Executed

| Check | Result | Evidence |
|---|---|---|
| SHA-256 algorithm | **PASS** | 4 FIPS 180-4 vectors + 3,000 differential inputs vs `node:crypto`, 0 mismatches |
| JSON codec | **PASS** | 4,000 round-trips vs `JSON.parse`, 2,000 serializer outputs re-parsed, 19/19 malformed rejected, canonical form order-independent |
| V3 architecture gates | **11 PASS, 1 NOT TESTED** | `node scripts/v3-architecture-gates.mjs`, exit 0 |
| V3 boundary assertions | **14/14 PASS** | logic of `tests/v3-boundaries.test.ts` executed directly |
| Script syntax | **PASS** | `node --check` on both gate scripts |
| Quality Gates — Architecture | **PASS** | V2 boundaries intact |
| Quality Gates — Security baseline | **PASS** | headers + CSP wired in 8 apps |
| Quality Gates — Originality structure | **PASS** | four V2 probes still distinct |
| Quality Gates — Industrial plane | **PASS** | new gate, exit 0 |
| Quality Gates — Accessibility | **WARNING** | static only, by design |

### Defects found and fixed during verification

| Defect | How found | Fix |
|---|---|---|
| `GraphBackend` used by `graphd` but never implemented | cross-crate symbol gate | implemented `nexus-graph::backend` with strict resolution, 7 tests |
| Unused import `DEFAULT_LATENCY_BUCKETS_MS` in `bench` | source hygiene gate | removed (would fail `clippy -D warnings`) |
| Unused import `EdgeTask` in `factory-line` | source hygiene gate | removed |
| Non-ASCII identifier accidentally introduced in `dedup.rs` | non-ASCII scan | renamed to `high` |
| `exactly-once` assertion in the boundary test looked *after* the phrase while the disclaimer precedes it | manual execution of the test logic | rewritten to inspect the surrounding window |
| Gate false positive: trait imports flagged as unused | manual triage | gate made trait-aware |
| Gate false positive: unbraced `use` treated its item as a module | manual triage | prefix handling corrected |

### NOT TESTED, with exact reason

| Gate | Status | Reason |
|---|---|---|
| `cargo fmt --check` | **NOT TESTED** | no Rust toolchain; `cargo: not found`, `apt-get install rustc` fails with 403 on every package, `static.rust-lang.org` blocked (`x-deny-reason: host_not_allowed`) |
| `cargo clippy -- -D warnings` | **NOT TESTED** | same |
| `cargo test --workspace` | **NOT TESTED** | same — **the 287 tests have never run** |
| `cargo build --release` | **NOT TESTED** | same — **the Rust has never been compiled** |
| `cargo audit` | **NOT TESTED** | no toolchain and no crates.io access |
| `cargo deny check` | **NOT TESTED** | same |
| End-to-end demo | **NOT TESTED** | requires a compiled binary |
| Benchmarks | **NOT TESTED** | requires a compiled binary; every figure in `V3_PERFORMANCE_TARGETS.md` is `NOT MEASURED` |
| `pnpm install/lint/typecheck/test/build` | **NOT TESTED** | `registry.npmjs.org` returns 403 |
| Vitest suite incl. `v3-boundaries.test.ts` | **NOT TESTED** | vitest cannot be installed; assertion logic executed manually instead |
| Feature-gated adapters (kafka, neo4j, wasmtime, ed25519) | **NOT TESTED** | never compiled; treat as reviewed source |
| Docker compose stack | **NOT TESTED** | no Docker, no network |

---

## 6. Benchmarks

**None were executed.** `runtime/bench/` contains the load generator and
harness; `docs/research/V3_PERFORMANCE_TARGETS.md` defines the method, the
required reporting (p50/p95/p99, memory, CPU, hardware, cardinality) and
records every row as `NOT MEASURED`. No throughput or latency figure is
claimed anywhere in this delivery.

---

## 7. Open risks

1. **The Rust has never been compiled.** This is the dominant risk. Expect
   type and borrow-checker errors on the first `cargo build`. The static gates
   eliminated module-wiring, delimiter, unused-import and cross-crate symbol
   errors, which are the mechanical classes; they cannot catch a lifetime or a
   trait-bound mistake. Budget a fix pass.
2. **Feature-gated adapters are the least verified code.** `rdkafka`,
   `neo4rs` and `wasmtime` APIs were written from knowledge, not from a
   compiler or current documentation, and their versions could not be checked
   against crates.io. Expect API drift, particularly in `neo4rs` row access
   and `wasmtime` store/fuel APIs.
3. **No `Cargo.lock` is committed.** It cannot be generated without network.
   The first CI run resolves and should commit it.
4. **Audit tamper-evidence is incomplete by design.** The hash chain detects
   edits and deletions within the store; it does not survive an attacker who
   rewrites the whole store. External anchoring is a deployment decision.
   Documented as accepted residual risk in the threat model.
5. **The dedup and nonce windows are bounded and therefore lossy.** They must
   be sized from measured broker redelivery behaviour; defaults are guesses.
6. **`InMemoryGraph` is not durable.** `graphd` refuses to start if a durable
   backend is requested without the feature, but a deployment that forgets to
   set `NEXUS_GRAPH_BACKEND` gets a non-durable store. It logs the backend at
   startup; it is not a substitute for deployment review.
7. **V2's own CI gaps are inherited.** `pnpm install`/lint/typecheck/test/build
   still have not run in this environment; they run in GitHub Actions.
8. **Substring matching for prohibited terms will produce false positives.**
   A legitimate capability named e.g. `strike_plate_inspection` would be
   denied. This is the intended trade and is documented; the fix is a rename,
   never a weakening of the list.

---

## 8. Gate checklist

### Existing repository (V2)

| Gate | Status |
|---|---|
| `pnpm install` | NOT TESTED — npm registry blocked (403) |
| Lint | NOT TESTED — same |
| TypeScript typecheck | NOT TESTED — same |
| Tests | NOT TESTED — same |
| Next build | NOT TESTED — same |
| Quality gates (static portions) | PASS — Architecture, Security, Originality |
| Quality gates (Accessibility) | WARNING — static only, by design |
| Audit | NOT TESTED — advisory service unreachable |

### Rust

| Gate | Status |
|---|---|
| `cargo fmt` | NOT TESTED — no toolchain, installation blocked |
| `cargo clippy` | NOT TESTED — same |
| `cargo test` | NOT TESTED — same |
| `cargo build --release` | NOT TESTED — same |
| `cargo audit` | NOT TESTED — same |
| `cargo deny` | NOT TESTED — same |

### Architecture

| Gate | Status |
|---|---|
| No dependency from core into experience/runtime | **PASS** |
| No React/Next inside the Rust runtime | **PASS** |
| No graph DB coupling inside ontology core | **PASS** |
| No arbitrary edge payload execution | **PASS** |
| No hardcoded secrets | **PASS** |
| No fake hardware security claim | **PASS** |
| Safety invariants intact | **PASS** |
| Workspace integrity | **PASS** |
| Cross-crate symbol resolution | **PASS** |
| Rust source hygiene | **PASS** |
| Required artifacts present | **PASS** |

### End-to-end

| Gate | Status |
|---|---|
| sensor → broker → graph → proposal → policy → simulation → signed WASM task → result → audit | **NOT TESTED** — implemented as `examples/factory-line`, wired as a CI gate in `rust.yml`, never executed for lack of a compiler |

---

## 9. What V3 demonstrates

NEXUS is no longer only an Experience Engine. It now has two decoupled planes:
Experience Intelligence, and an Industrial Agentic Runtime with its own data
plane, ontology, agent runtime, safety engine, edge sandbox, isolation
gateway and simulator.

The value is not in resembling any named product. It is in the composition:
an ontology whose ports carry no database, prohibitions compiled into the
binary rather than configured, typed signed commands a sandbox refuses to
exceed, simulation as a dispatch precondition, and provenance on every fact so
an action can be traced back to the reading that caused it.

## 10. Next step

Run `.github/workflows/rust.yml` on `nexus-v3`. The architecture job passes
today. The Rust job will surface the first compile errors; bring them back and
they get fixed as ordinary commits on `nexus-v3` — no `v3.1`.
