# NEXUS V7 Architecture Plan

Status: **V7 CLOSED — foundation/architecture scope**. This closure records the implemented and tested V7 Kernel foundation and SPEC_ONLY Enterprise Fabric descriptors. It is not a production-readiness, benchmark, operational-evidence or audit claim, and it does not begin V8 work.

## 1. Inspection baseline

Inspection was performed against the repository contents, not historical claims. Evidence sources:

- Root JavaScript workspace: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`.
- Rust workspace: `runtime/Cargo.toml`, `runtime/Cargo.lock`, all crate/service/example manifests under `runtime/`.
- Active source trees: `apps/`, `packages/`, `runtime/`, `services` under `runtime/services/`, `runtime/examples/`, `scripts/`, `.github/workflows/`, `docs/`, `tests/`.
- Historical source tree: `archive/` and version closeout artifacts at repository root.

The repository continues to expose V6-versioned pre-existing planes while the additive `@nexus/kernel` contract package is versioned for V7. V7 closure is an architecture/foundation milestone governed by the scoped Definition of Done below; it does not re-label V3–V6 implementations or imply a production release of those planes.

## 2. Repository inventory and classification

| Area | Contents observed | Classification | V7 interpretation |
| --- | --- | --- | --- |
| `apps/_experience-seed` | Neutral Next.js starter consuming Core | Experience | Implemented starter; not art direction; should remain minimal. |
| `apps/reference-alfil` | Reference Experience app consuming Core | Experience | Implemented reference probe. |
| `apps/reference-meson` | Reference Experience app consuming Core | Experience | Implemented reference probe. |
| `apps/reference-nexus-bot` | Reference Experience app consuming Core | Experience | Implemented reference probe. |
| `apps/v2-probe-asymmetric` | V2 probe app consuming Core and Experience | Experience / Experimental | Implemented probe; evidence for V2 expressiveness, not a template. |
| `apps/v2-probe-cinematic` | V2 probe app consuming Core and Experience | Experience / Experimental | Implemented probe; keep separate from stable Core. |
| `apps/v2-probe-editorial` | V2 probe app consuming Core and Experience | Experience / Experimental | Implemented probe; keep separate from stable Core. |
| `apps/v2-probe-industrial` | V2 probe app consuming Core and Experience | Experience / Experimental | Implemented probe; no Industrial runtime coupling implied. |
| `packages/core` | Stable TypeScript Core foundation, tokens, typography, theme bridge, components, motion, data, a11y | Kernel/Shared | Current small shared kernel for Experience plane only; must stay brand-agnostic. |
| `packages/experience` | Framework-agnostic V2 Experience Engine contracts | Experience | Orchestration IP; no React/Next/Core dependency. |
| `packages/experimental` | Candidate style fingerprint and capability budget APIs | Experimental | Explicit sandbox; no promotion without deliberate evidence. |
| `packages/config` | Shared TypeScript config package | Kernel/Shared | Tooling/shared config, not product domain. |
| `packages/control-sdk` | TypeScript control SDK package with standalone exports | Kernel/Shared / Industrial interface candidate | Implemented package but currently no internal `@nexus/*` deps; should not become a dumping ground. |
| `runtime/crates/nexus-event` | Rust event model | Industrial / Kernel | Implemented base runtime event contract. |
| `runtime/crates/nexus-observability` | Runtime observability helpers | Industrial / Kernel | Implemented shared runtime telemetry helpers. |
| `runtime/crates/nexus-policy` | Hard safety invariants | Industrial | Implemented policy boundary; must remain non-configurable for hard invariants. |
| `runtime/crates/nexus-ontology` | Ontology model/resolution/store abstractions | Industrial | Implemented ontology layer; must remain backend-agnostic. |
| `runtime/crates/nexus-graph` | Graph backend boundary | Industrial | Implemented backend boundary for ontology persistence/querying. |
| `runtime/crates/nexus-ingest` | Ingest contracts/pipeline | Industrial | Implemented. |
| `runtime/crates/nexus-edge-protocol` | Typed edge command protocol | Industrial | Implemented; no arbitrary payloads. |
| `runtime/crates/nexus-edge-wasm` | Edge WASM sandbox/host | Industrial | Implemented; real adapters feature-gated. |
| `runtime/crates/nexus-agent` | Physical/industrial agent orchestration | Industrial | Implemented V3 agent plane. |
| `runtime/crates/nexus-sim` | Simulation gate | Industrial | Implemented safety simulation contract. |
| `runtime/crates/nexus-oneway` | One-way gateway semantics | Industrial | Implemented logical one-way boundary; no hardware diode claim. |
| `runtime/crates/nexus-memory`, `nexus-goal`, `nexus-planner`, `nexus-reasoning`, `nexus-model`, `nexus-world-model`, `nexus-durable`, `nexus-evaluator`, `nexus-recovery`, `nexus-agents-v4`, `nexus-intelligence` | V4 cognitive/runtime contracts | Industrial / Experimental | Implemented/tested contracts in runtime; untrusted cognitive inputs must not bypass policy/sim/approval. |
| `runtime/crates/nexus-control-model`, `nexus-identity`, `nexus-authz`, `nexus-registry`, `nexus-secrets-v5`, `nexus-cost`, `nexus-alerts`, `nexus-audit-v5`, `nexus-api-contracts`, `nexus-control-plane`, `nexus-sdk` | V5 control, identity, API, SDK and operability contracts | Industrial | Implemented control-plane contracts; not production-proven. |
| `runtime/crates/nexus-cluster`, `nexus-consensus`, `nexus-replication`, `nexus-placement`, `nexus-discovery`, `nexus-federation`, `nexus-offline`, `nexus-mesh`, `nexus-fleet`, `nexus-update`, `nexus-distributed` | V6 distributed runtime contracts | Industrial | Implemented distributed contracts; preserve as V7 foundation, do not destructively reorganize. |
| `runtime/services/*` | `controld`, `ingestd`, `graphd`, `orchestratord`, `gatewayd`, `clusterd` binaries | Industrial | Implemented service entrypoints; operational evidence still limited to local builds/tests. |
| `runtime/examples/*` | Factory, robot, drone, autonomous and distributed demos | Industrial / Examples | Demonstrations, not production evidence. |
| `runtime/bench` | Rust benchmark harness | Industrial / Benchmarks | Benchmark harness exists; benchmarked status requires recorded results. |
| `runtime/docker/docker-compose.yml` | Local runtime composition | Industrial / Examples | Local integration harness; not production deployment evidence. |
| `scripts/*.mjs` | Quality, security, V3–V6 architecture gates | Kernel/Shared validation | Implemented validation; V7 should add gates only after contracts exist. |
| `.github/workflows/closeout-stages.yml` | CI workflow | Kernel/Shared validation | Implemented workflow; validate actual job result externally. |
| `tests/*.test.ts` | Repository boundary and V2–V5 tests | Kernel/Shared validation | Implemented TS architecture tests. |
| `docs/architecture` | Experience V2 and Industrial V3–V6 architecture docs | Historical / Architecture | Preserve as historical/evidence docs; reconcile without deletion. |
| `docs/security` | V3–V6 threat/trust docs | Historical / Security | Preserve; use to identify claims needing evidence. |
| `docs/research` | Human diversity tests, performance targets, repair maps, technology freshness | Historical / Research | Evidence inputs; not production proof. |
| root `NEXUS_V*_*.md/txt`, `THIS_BUILD.md`, `UPLOAD_FIRST.md` | Closeout, validation, checksum and handoff artifacts | Historical | Keep history; do not treat as automatic V7 closure. |
| `archive/_template-client-v1` | Retired V1 client seed | Historical / Obsolete candidate | Archived; not active workspace; no migration source without explicit task. |
| `node_modules`, app/package node_modules | Installed dependencies | Obsolete candidate for source review | Not source of truth; exclude from architecture inventory except dependency presence. |

## 3. Toolchains, lockfiles and workflows

| Item | Observed file | Status | Notes |
| --- | --- | --- | --- |
| Node.js | `package.json` engines | IMPLEMENTED | Requires Node `>=24.0.0`. |
| pnpm | `packageManager`, `pnpm-lock.yaml` | IMPLEMENTED | `pnpm@10.15.0`; workspace globs active packages/apps only. |
| TypeScript | root/app/package `tsconfig.json` files | IMPLEMENTED | Project-wide typecheck is package-recursive. |
| ESLint | `eslint.config.mjs` | IMPLEMENTED | Root `pnpm lint`. |
| Vitest | `vitest.config.ts`, `tests`, package tests | TESTED when passing locally/CI | Root `pnpm test`. |
| Rust | `runtime/Cargo.toml`, `runtime/Cargo.lock` | IMPLEMENTED | Workspace rust-version `1.75`; current environment may use newer rustc. |
| Cargo clippy/test/build | root scripts | TESTED when passing locally/CI | Required for runtime confidence. |
| Architecture gates | `scripts/v3-architecture-gates.mjs` through `v7-architecture-gates.mjs` | TESTED when passing | Enforce non-negotiable Industrial and V7 Kernel boundaries. |
| CI | `.github/workflows/closeout-stages.yml` | INTEGRATED when workflow succeeds | Local green is not the same as GitHub green or production proof. |

## 4. Real dependency map

### TypeScript workspace internal edges

| Package/app | Internal dependencies |
| --- | --- |
| root `nexus-web-engine` | none |
| `@nexus/experience-seed` | `@nexus/core` |
| `@nexus/reference-alfil` | `@nexus/core` |
| `@nexus/reference-meson` | `@nexus/core` |
| `@nexus/reference-nexus-bot` | `@nexus/core` |
| `@nexus/v2-probe-asymmetric` | `@nexus/core`, `@nexus/experience` |
| `@nexus/v2-probe-cinematic` | `@nexus/core`, `@nexus/experience` |
| `@nexus/v2-probe-editorial` | `@nexus/core`, `@nexus/experience` |
| `@nexus/v2-probe-industrial` | `@nexus/core`, `@nexus/experience` |
| `@nexus/config` | none |
| `@nexus/control-sdk` | none |
| `@nexus/core` | none |
| `@nexus/experience` | none |
| `@nexus/experimental` | none |
| `@nexus/kernel` | none |

### Rust workspace internal edges

| Crate/service/example | Internal dependencies |
| --- | --- |
| `nexus-event`, `nexus-policy`, `nexus-control-model`, `nexus-cluster`, `nexus-consensus`, `nexus-discovery`, `nexus-federation`, `nexus-mesh`, `nexus-offline`, `nexus-replication`, `nexus-update`, `nexus-fleet`, `nexus-kernel` | none |
| `nexus-observability` | `nexus-event` |
| `nexus-ontology` | `nexus-event` |
| `nexus-graph` | `nexus-event`, `nexus-ontology` |
| `nexus-ingest` | `nexus-event`, `nexus-observability` |
| `nexus-edge-protocol` | `nexus-event`, `nexus-policy` |
| `nexus-edge-wasm` | `nexus-edge-protocol`, `nexus-event`, `nexus-observability` |
| `nexus-agent` | `nexus-edge-protocol`, `nexus-event`, `nexus-observability`, `nexus-ontology`, `nexus-policy`, `nexus-sim` |
| `nexus-sim` | `nexus-edge-protocol`, `nexus-event` |
| `nexus-oneway` | `nexus-event`, `nexus-observability` |
| `nexus-memory`, `nexus-model`, `nexus-reasoning`, `nexus-recovery`, `nexus-world-model`, `nexus-agents-v4` | `nexus-event` |
| `nexus-goal` | `nexus-event` |
| `nexus-planner` | `nexus-event`, `nexus-goal` |
| `nexus-evaluator` | `nexus-event`, `nexus-goal`, `nexus-planner` |
| `nexus-durable` | `nexus-event` |
| `nexus-intelligence` | `nexus-agents-v4`, `nexus-durable`, `nexus-evaluator`, `nexus-event`, `nexus-goal`, `nexus-memory`, `nexus-model`, `nexus-planner`, `nexus-reasoning`, `nexus-recovery`, `nexus-world-model` |
| `nexus-identity`, `nexus-registry`, `nexus-secrets-v5`, `nexus-cost`, `nexus-alerts`, `nexus-audit-v5` | `nexus-control-model` |
| `nexus-authz` | `nexus-control-model`, `nexus-identity` |
| `nexus-api-contracts` | `nexus-authz`, `nexus-control-model` |
| `nexus-control-plane` | `nexus-api-contracts`, `nexus-audit-v5`, `nexus-authz`, `nexus-control-model`, `nexus-identity`, `nexus-registry` |
| `nexus-sdk` | `nexus-api-contracts` |
| `nexus-placement` | `nexus-cluster` |
| `nexus-distributed` | `nexus-cluster`, `nexus-consensus`, `nexus-placement` |
| `nexus-bench` | `nexus-event`, `nexus-graph`, `nexus-observability`, `nexus-ontology` |
| `controld` | `nexus-control-plane` |
| `ingestd`, `graphd` | `nexus-event`, `nexus-graph`, `nexus-ingest`, `nexus-observability`, `nexus-ontology` |
| `gatewayd` | `nexus-edge-protocol`, `nexus-edge-wasm`, `nexus-event`, `nexus-ingest`, `nexus-observability`, `nexus-oneway` |
| `orchestratord` | `nexus-agent`, `nexus-edge-protocol`, `nexus-event`, `nexus-graph`, `nexus-ingest`, `nexus-observability`, `nexus-ontology`, `nexus-policy`, `nexus-sim` |
| `clusterd`, `distributed-factory` | `nexus-cluster`, `nexus-consensus`, `nexus-distributed`, `nexus-placement` |
| `factory-line` | `nexus-agent`, `nexus-edge-protocol`, `nexus-edge-wasm`, `nexus-event`, `nexus-graph`, `nexus-observability`, `nexus-oneway`, `nexus-ontology`, `nexus-policy`, `nexus-sim` |
| `warehouse-robot`, `inspection-drone-sim` | `nexus-agent`, `nexus-edge-protocol`, `nexus-event`, `nexus-observability`, `nexus-policy`, `nexus-sim` |
| `autonomous-factory` | `nexus-event`, `nexus-goal`, `nexus-intelligence`, `nexus-memory`, `nexus-planner` |

## 5. V7 maturity matrix

Allowed states: PLANNED, EXPERIMENTAL, IMPLEMENTED, TESTED, BENCHMARKED, INTEGRATED, OPERATIONALLY_EVIDENCED, PRODUCTION_PROVEN.

| Capability / area | Current maturity | Evidence threshold used |
| --- | --- | --- |
| Experience Core (`packages/core`) | TESTED | Source, package tests and repository tests exist; production evidence absent. |
| V2 Experience Engine (`packages/experience`) | TESTED | Contract tests and V2 boundary/originality tests exist. |
| V2 probe apps | INTEGRATED | Apps build in workspace and consume Core/Experience; probes are not product deployments. |
| Experimental TS APIs | EXPERIMENTAL | Located in `packages/experimental`; not promoted. |
| TypeScript control SDK | IMPLEMENTED | Package exists; no demonstrated external adoption or runtime integration evidence in repo. |
| V3 Industrial runtime base | TESTED | Cargo workspace tests plus V3 gates are available; examples provide local demos. |
| V4 cognitive contracts | TESTED | Crates and V4 gates/tests exist; untrusted-input boundary preserved. |
| V5 control/identity/API/operability | TESTED | Crates and V5 gates/tests exist; operational evidence limited. |
| V6 distributed runtime | TESTED | Crates and V6 gates/tests exist; no production proof. |
| Runtime examples | INTEGRATED | Compile/run as workspace examples where invoked; examples are demos. |
| Runtime benchmark harness | IMPLEMENTED | Harness exists; benchmarked requires recorded benchmark output and acceptance criteria. |
| Docker/local service composition | IMPLEMENTED | Compose file exists; operational evidence requires reproducible run logs. |
| Security/trust-boundary documentation | IMPLEMENTED | Docs exist; claims require ongoing validation gates and review. |
| GitHub workflow | IMPLEMENTED | Workflow exists; INTEGRATED only when remote CI run is green. |
| NEXUS Enterprise Fabric descriptors | TESTED | All 11 domains have dependency-free SPEC_ONLY descriptors and boundary tests; no domain implementation is claimed. |
| V7 foundation/architecture milestone | TESTED | Scoped DoD is satisfied by the additive Kernel contracts, SPEC_ONLY Fabric descriptors, tests, gates and reconciled evidence documents. |
| Production operation of any plane | PLANNED | No incident history, SLO evidence, customer deployment, certification, or operational audit in repo. |

## 6. Historical V6 reconciliation

V6 documents and closeout artifacts remain valuable historical evidence. V7 will not delete or rewrite them as if they were wrong. Instead:

1. Treat V6 architecture, trust-boundary, freshness, replacement-difficulty and repair-map documents as historical inputs.
2. Preserve all V3–V6 runtime contracts and gates.
3. Avoid the phrase production-proven for V6 distributed runtime until there is operational evidence such as signed releases, deployment topology, incident/rollback records, SLO dashboards, load/chaos reports, and security review artifacts.
4. Distinguish local demo success, local tests, architecture gates, and CI green from operational proof.
5. Add V7 documentation as forward-looking reconciliation, not destructive replacement.

## 7. V7 Kernel design

V7 introduces a small Kernel only where cross-plane contracts are truly shared. It must not become a generic `shared` dumping ground.

### Kernel purpose

- Stable identifiers, versioned contract metadata, evidence descriptors, policy decision envelopes, tenant/identity references and error taxonomy that can be consumed without importing Experience UI or Industrial runtime internals.
- Language-neutral first: specifications and schemas before package/crate implementation.
- Adapter-friendly: no database, message broker, cloud, graph vendor, LLM provider, workflow engine, or UI framework dependency in Kernel.

### Kernel non-goals

- No React/Next/CSS, no app themes, no client copy.
- No direct edge execution, no `EdgeTask` construction, no policy bypass.
- No industrial device adapters.
- No arbitrary utility collection.
- No historical code relocation without dependency and compatibility proof.

### Implemented Kernel foundation contracts

| Contract | V7 status | Boundary |
| --- | --- | --- |
| Contract identity and semantic version envelope | TESTED | Equivalent TypeScript/Rust references with deterministic IDs. |
| Evidence descriptor | TESTED | Equivalent deterministic evidence IDs and evidence-level vocabulary; does not assert production. |
| Tenant and principal references | IMPLEMENTED | References only; authorization remains in Industrial control/authz contracts. |
| Policy decision envelope | TESTED | Carries allow/deny/reason/evidence; hard invariants stay in `nexus-policy`. |
| Outcome and metric reference | PLANNED / OUT OF SCOPE | No contract was required for the scoped V7 foundation closure and none is claimed. |

## 8. NEXUS Enterprise Fabric descriptor architecture

Enterprise Fabric is formally represented in V7 by 11 tested, dependency-free `SPEC_ONLY` contract descriptors. These descriptors name domains and boundaries only: every concrete Fabric capability remains unimplemented unless separately evidenced.

| Fabric domain | Required contract | Current mapped assets | V7 next step |
| --- | --- | --- | --- |
| Enterprise Ontology | Versioned enterprise entity/relation schema, provenance and tenant scoping | `nexus-ontology`, `nexus-graph` | Define schema compatibility and migration policy without binding ontology to graph backend. |
| Connector Fabric | Replaceable connectors with capability, auth, rate-limit and evidence metadata | `nexus-ingest`, runtime services | Specify adapter contract; keep Kafka/cloud/SaaS connectors optional. |
| Decision Memory | Durable decision record, rationale, inputs, policy result and expiry | `nexus-memory`, `nexus-durable`, `nexus-audit-v5` | Define decision log envelope and retention boundaries. |
| Policy Graph | Policy relationships, obligations and invariant evidence | `nexus-policy`, `nexus-authz`, `nexus-control-model` | Keep hard invariants non-configurable; model graph as explanatory/evidence layer, not bypass. |
| Durable Workflows | Idempotency keys, compensation, timeout, retry and audit semantics | `nexus-durable`, `nexus-recovery`, `nexus-control-plane` | Define workflow state contract; no exactly-once claim. |
| Agent Governance | Agent registration, allowed tools/capabilities, review and revocation | `nexus-agents-v4`, `nexus-agent`, `nexus-registry`, `nexus-authz` | Define governance policy around untrusted models/tools. |
| Execution Fabric | Placement, scheduling, leases, health and rollout boundaries | V6 cluster/consensus/placement/distributed/update crates | Preserve replaceable providers; add evidence requirements for operational status. |
| Evidence Plane | Evidence collection, provenance, signatures, audit trails and quality levels | `nexus-audit-v5`, `nexus-observability`, root validation artifacts | Define evidence levels aligned to maturity states. |
| Outcome Intelligence | Outcome definitions, evaluations, feedback and cost/risk signals | `nexus-intelligence`, `nexus-evaluator`, `nexus-cost`, `nexus-alerts` | Connect outcomes to evidence, not autonomous authorization. |
| Identity | Principals, service identities, federation subject mapping | `nexus-identity`, `nexus-authz`, `nexus-federation` | Define multi-domain subject mapping and revocation evidence. |
| Multi-Tenancy | Tenant isolation, scoped grants, data boundaries and audit partitioning | `nexus-control-model`, `nexus-authz`, `nexus-federation` | Define tenant boundary tests before implementation. |

## 9. Boundaries

- Experience and Industrial remain separate execution planes. `pnpm` does not build Rust; `cargo` does not build TypeScript.
- Experience apps may consume Core and Experience Engine. Core and Experience Engine must not import apps.
- Runtime crates must not depend on TypeScript packages.
- Cognitive/agentic inputs remain untrusted and cannot directly emit edge tasks or bypass policy/simulation/approval.
- Distributed runtime decides placement/replication only, never authorization.
- Enterprise Fabric contracts must be adapters and specs before concrete vendor integrations.

## 10. Risks and blockers

| Risk/blocker | Impact on V7 closure | Mitigation |
| --- | --- | --- |
| Concrete Enterprise Fabric capabilities are outside the implemented foundation | Does not block the scoped foundation/architecture closure; descriptors must remain SPEC_ONLY | Implement capabilities only in separately scoped work with tests and evidence. |
| No recorded operational evidence | Prevents OPERATIONALLY_EVIDENCED/PRODUCTION_PROVEN claims; does not retroactively block architecture closure | Create a separately scoped deployment/evidence plan before making either claim. |
| Benchmark harness lacks measurements, thresholds and stored results | Prevents BENCHMARKED maturity claims; does not block architecture closure | Add a repeatable procedure, thresholds and captured outputs before changing maturity. |
| Kernel could become a dumping ground | Architecture erosion | Require admission checklist and ownership per contract. |
| Historical docs may overstate maturity if read casually | Misleading release claims | Keep this V7 reconciliation visible and link future release notes to evidence. |

## 11. Reconciliation and evolution strategy

1. Keep V3–V6 runtime intact and additive-only unless a focused defect requires change.
2. Keep Kernel contracts specification-oriented and tested before adding consumers.
3. Introduce compatibility shims only when moving an existing public contract is proven safe.
4. Preserve the implemented V7 architecture gates as the Kernel evolves.
5. Implement concrete Enterprise Fabric capabilities only in separately scoped work; the V7 descriptors remain SPEC_ONLY until then.
6. Record benchmark and operational evidence as artifacts, never as unsupported prose.

## 12. Test and validation strategy

Required local validation for any V7-impacting PR:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm security-hygiene`
- `pnpm v3-gates`
- `pnpm v4-gates`
- `pnpm v5-gates`
- `pnpm v6-gates`
- `pnpm v7-gates`
- `pnpm rust:test`
- `pnpm rust:lint`
- `pnpm rust:build`

Additional validation for later maturity or release claims (not foundation/architecture closure criteria):

- Run runtime examples and document outputs.
- Run benchmarks with defined thresholds and store measurement results before any `BENCHMARKED` claim.
- Validate Docker/local service composition with reproducible logs.
- Extend the existing V7-specific boundary tests when Kernel or Enterprise Fabric descriptor contracts change.
- Confirm GitHub Actions workflow result on the PR branch.

## 13. Release strategy

Any distributable or production-oriented V7 release remains separately evidence-gated:

1. Do not reinterpret the foundation/architecture closure as a release of the V6-versioned planes.
2. Require green local validation and green remote CI for any release candidate.
3. Require signed or checksummed release artifacts where applicable.
4. Explicitly label maturity per component; do not globally claim production readiness.
5. Benchmark, operations and production claims require their own evidence thresholds.
6. V8 is outside this reconciliation and is not started here.

## 14. V7 Definition of Done and current status

### Mandatory foundation/architecture closure criteria

These criteria define V7 closure for this repository increment. They establish the shared contract foundation and its architectural boundaries; they do not certify runtime performance or production operation.

| Criterion | Final status | Evidence |
| --- | --- | --- |
| Repository inventory and classification are reconciled | TESTED | Sections 1–3 reflect active workspaces, toolchains and historical areas. |
| TypeScript and Rust dependency maps include the V7 Kernel | TESTED | Section 4 records both dependency-free Kernel implementations. |
| V3–V6 contracts and safety boundaries are preserved | TESTED | V3–V6 gates pass; no V3–V6 functional behavior is changed by this reconciliation. |
| Small, dependency-free V7 Kernel contracts exist in TypeScript and Rust | TESTED | `packages/kernel` and `runtime/crates/nexus-kernel` implement equivalent contract, evidence, tenant/principal and policy-envelope semantics. |
| Cross-language contract and evidence IDs are deterministic and equivalent | TESTED | TypeScript, Rust and repository tests validate the canonical domain mapping. |
| Enterprise Fabric is represented without inventing implementations | TESTED | All 11 domains are present as `SPEC_ONLY` descriptors; no concrete Fabric capability or adapter is claimed. |
| Experience, Kernel and Industrial boundaries remain explicit | TESTED | V7 boundary tests and architecture gates enforce forbidden dependencies and edge/policy separation. |
| V7-specific tests and gates exist and pass | TESTED | Package tests, Rust unit tests, repository boundary tests and `pnpm v7-gates` cover the V7 contracts. |
| Maturity and evidence documents are internally consistent | TESTED | Current state, evidence register and benchmark baseline distinguish tested foundation from later maturity evidence. |

All mandatory foundation/architecture criteria are satisfied. **V7 is CLOSED for foundation/architecture scope.**

### Later maturity states — explicitly not closure criteria

| Maturity state | Current status | Evidence required before promotion |
| --- | --- | --- |
| BENCHMARKED | NOT ACHIEVED | Real measurements, declared thresholds and stored results. The existing harness is only IMPLEMENTED/TESTED. |
| INTEGRATED for concrete Enterprise Fabric capabilities | NOT ACHIEVED | Implemented non-SPEC_ONLY capabilities plus integration tests and intentional consumers. |
| OPERATIONALLY_EVIDENCED | NOT ACHIEVED | Reproducible deployment and operations records; none are present. |
| PRODUCTION_PROVEN | NOT ACHIEVED | Production history and an applicable production audit; neither is present. |

These states remain valid future maturity levels. Their absence prohibits those claims but does not undo the completed architecture/foundation milestone.

## 15. Current V7 conclusion

NEXUS V7 is **CLOSED for foundation/architecture scope**. This means the minimal cross-language Kernel contracts, deterministic evidence semantics, SPEC_ONLY Enterprise Fabric descriptors, boundaries, tests, gates and documentation are complete for the defined scope. It does **not** mean V7 is BENCHMARKED, OPERATIONALLY_EVIDENCED, PRODUCTION_PROVEN, certified, or released to production. No such evidence is invented, and no V8 work is included.
