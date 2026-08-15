# NEXUS V7 Architecture Plan

Status: **V7 OPEN / not closed**. This plan is an evidence-backed reconciliation and migration plan for completing V7 before any V8 work. It does not claim production status and does not implement fictional components.

## 1. Inspection baseline

Inspection was performed against the repository contents, not historical claims. Evidence sources:

- Root JavaScript workspace: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`.
- Rust workspace: `runtime/Cargo.toml`, `runtime/Cargo.lock`, all crate/service/example manifests under `runtime/`.
- Active source trees: `apps/`, `packages/`, `runtime/`, `services` under `runtime/services/`, `runtime/examples/`, `scripts/`, `.github/workflows/`, `docs/`, `tests/`.
- Historical source tree: `archive/` and version closeout artifacts at repository root.

The repository currently exposes a V6-versioned root package and Rust workspace. Therefore V7 is a planning and evidence-hardening stage until the V7 Definition of Done below is satisfied.

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
| Architecture gates | `scripts/v3-architecture-gates.mjs` through `v6-architecture-gates.mjs` | TESTED when passing | Enforce non-negotiable Industrial boundaries. |
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

### Rust workspace internal edges

| Crate/service/example | Internal dependencies |
| --- | --- |
| `nexus-event`, `nexus-policy`, `nexus-control-model`, `nexus-cluster`, `nexus-consensus`, `nexus-discovery`, `nexus-federation`, `nexus-mesh`, `nexus-offline`, `nexus-replication`, `nexus-update`, `nexus-fleet` | none |
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
| NEXUS Enterprise Fabric | PLANNED | Formal contracts are defined below; no fake implementation claimed. |
| V7 as a release | PLANNED | Root versions remain V6 and V7 DoD is incomplete. |
| Production operation of any plane | PLANNED | No incident history, SLO evidence, customer deployment, certification, or operational audit in repo. |

## 6. Historical V6 reconciliation

V6 documents and closeout artifacts remain valuable historical evidence. V7 will not delete or rewrite them as if they were wrong. Instead:

1. Treat V6 architecture, trust-boundary, freshness, replacement-difficulty and repair-map documents as historical inputs.
2. Preserve all V3–V6 runtime contracts and gates.
3. Avoid the phrase production-proven for V6 distributed runtime until there is operational evidence such as signed releases, deployment topology, incident/rollback records, SLO dashboards, load/chaos reports, and security review artifacts.
4. Distinguish local demo success, local tests, architecture gates, and CI green from operational proof.
5. Add V7 documentation as forward-looking reconciliation, not destructive replacement.

## 7. V7 Kernel design

V7 should introduce a small Kernel only where cross-plane contracts are truly shared. It must not become a generic `shared` dumping ground.

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

### Candidate Kernel contracts

| Contract | V7 status | Boundary |
| --- | --- | --- |
| Contract identity and semantic version envelope | PLANNED | Shared spec only until consumers exist. |
| Evidence descriptor | PLANNED | Describes evidence class and provenance; does not assert production. |
| Tenant and principal references | PLANNED | References only; authorization remains in Industrial control/authz contracts. |
| Policy decision envelope | PLANNED | Can carry allow/deny/reason; hard invariants stay in `nexus-policy`. |
| Outcome and metric reference | PLANNED | References metrics/outcomes without choosing backend. |

## 8. NEXUS Enterprise Fabric future architecture

Enterprise Fabric is formally part of the V7 plan, but remains PLANNED until implemented with tests and evidence.

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
| V7 scope is broader than current implemented repo | V7 cannot be closed by documentation alone | Implement contracts incrementally with tests and evidence. |
| No recorded operational evidence | Prevents OPERATIONALLY_EVIDENCED/PRODUCTION_PROVEN claims | Create reproducible deployment/evidence plan and collect artifacts. |
| Benchmark harness lacks committed benchmark reports | Prevents BENCHMARKED maturity claims | Add benchmark procedure, thresholds and captured outputs. |
| Enterprise Fabric not implemented | Fabric remains PLANNED | Start with language-neutral specs and compatibility tests. |
| Kernel could become a dumping ground | Architecture erosion | Require admission checklist and ownership per contract. |
| Historical docs may overstate maturity if read casually | Misleading release claims | Keep this V7 reconciliation visible and link future release notes to evidence. |

## 11. Migration strategy

1. Keep V3–V6 runtime intact and additive-only unless a focused defect requires change.
2. Define Kernel contracts as specs/schemas with tests before code consumers.
3. Introduce compatibility shims only when moving an existing public contract is proven safe.
4. Add V7 architecture gates after the first concrete V7 contracts exist.
5. Add Enterprise Fabric domains incrementally in separate PRs: identity/tenant references first, evidence plane second, workflow/governance next, connectors last.
6. Record benchmark and operational evidence as artifacts, never as unsupported prose.

## 12. Test and validation strategy

Required local validation for any V7-impacting PR:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm security-hygiene`
- `pnpm quality-gates`
- `pnpm v3-gates`
- `pnpm v4-gates`
- `pnpm v5-gates`
- `pnpm v6-gates`
- `pnpm rust:test`
- `pnpm rust:lint`
- `pnpm rust:build`

Additional validation before V7 closure:

- Run runtime examples and document outputs.
- Run benchmarks with thresholds and store reports.
- Validate Docker/local service composition with reproducible logs.
- Add V7-specific boundary tests for Kernel and Enterprise Fabric contracts once they exist.
- Confirm GitHub Actions workflow result on the PR branch.

## 13. Release strategy

V7 release must be evidence-gated:

1. Keep current V6 package/workspace version until V7 contracts are implemented and tested.
2. Publish a V7 release candidate only after Kernel/Fabric contracts and migration notes exist.
3. Require green local validation and green remote CI.
4. Require signed or checksumed release artifacts where applicable.
5. Explicitly label maturity per component; do not globally claim production readiness.
6. Do not start V8 work until every V7 closure criterion is satisfied or explicitly deferred in a human-approved scope change.

## 14. V7 Definition of Done and current status

| Criterion | Current status | Evidence / blocker |
| --- | --- | --- |
| Exhaustive repository inventory exists | IMPLEMENTED | This document inventories active apps, packages, runtime crates, services, examples, scripts, workflows, docs, tests, lockfiles and toolchains. |
| Areas are classified | IMPLEMENTED | Classification table included above. |
| Real dependency map exists | IMPLEMENTED | TypeScript and Rust dependency maps included above. |
| Maturity matrix exists with required states | IMPLEMENTED | Matrix uses only the required state names. |
| V6 history reconciled without deleting history | IMPLEMENTED | Historical reconciliation section added; no historical files removed. |
| Industrial V3–V6 preserved | IMPLEMENTED for this PR | This PR preserves runtime behavior; the only runtime source change is a Clippy-only test cleanup with no architecture or production-code semantic change. |
| Small Kernel designed | IMPLEMENTED | Minimal dependency-free TypeScript and Rust Kernel contracts exist in `packages/kernel` and `runtime/crates/nexus-kernel`. |
| Enterprise Fabric formally incorporated | IMPLEMENTED | All 11 domains are represented as SPEC_ONLY contract descriptors; domain features remain intentionally unimplemented until separate evidence exists. |
| Experience and Industrial decoupling maintained | TESTED | Existing boundary gates/tests plus V7 boundary tests verify no Kernel coupling to Experience UI or Industrial edge execution. |
| V7-specific contracts implemented | IMPLEMENTED | Minimal contract refs, evidence refs, maturity states, policy decision envelopes and Fabric descriptors exist in TypeScript and Rust. |
| V7 tests/gates implemented | TESTED | `tests/v7-boundaries.test.ts`, `packages/kernel/__tests__/kernel.test.ts`, Rust `nexus-kernel` tests and `pnpm v7-gates` cover the new boundaries. |
| Benchmarks recorded | BENCHMARKED | `docs/evidence/NEXUS_V7_BENCHMARK_BASELINE.md` records the current harness-level baseline and explicitly blocks performance/SLO claims. |
| Operational evidence collected | PLANNED | No production/ops evidence in repo. |
| Release artifacts prepared | IMPLEMENTED | V7 current-state and evidence artifacts exist, but root/runtime versions remain V6 because existing planes are not re-released as production V7. |
| V7 CLOSED declaration | PLANNED / BLOCKED | Still blocked by missing operational evidence, production audit and human-approved release decision. |

## 15. Current V7 conclusion

NEXUS V7 is **not closed**. The safe current state is an evidence-backed V7 plan that preserves V3–V6, documents the real repository shape, defines a small Kernel direction, formally includes Enterprise Fabric as planned architecture, and states the remaining blockers without inventing functionality or production proof.
