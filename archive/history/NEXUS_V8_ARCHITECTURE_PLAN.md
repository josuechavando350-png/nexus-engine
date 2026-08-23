# NEXUS V8 Experience / Creative Architecture

Status: **V8 PLANNED — architecture and baseline only**. V7 remains closed for its foundation/architecture scope. This plan begins V8, not V8.1/V8.2, and claims no implementation, benchmark, integration, operational, or production maturity.

## 1. Objective

V8 adds demonstrable Experience / Creative capabilities: explainable art direction, deterministic creative assets and memory, portable shader and interaction semantics, measured GPU governance, and honest workload benchmarking. NEXUS owns the intent, policy, fallback, determinism, and evidence contracts. Rendering libraries remain optional adapters when they are better at a workload.

## 2. Non-negotiable boundaries

1. V7 Kernel remains small and unchanged by V8 creative APIs.
2. `packages/experience` stays framework-agnostic and imports neither Core nor apps.
3. V8 Experience packages do not import Rust or Industrial services/crates; Industrial imports no V8 package.
4. V7 Enterprise Fabric descriptors remain `SPEC_ONLY`; V8 does not reinterpret them as creative implementations.
5. Core remains stable, brand-agnostic foundation. V8 code may consume exported Core accessibility contracts only at app/adapter boundaries, never make Core depend on V8.
6. No vendor type appears in an owned domain contract. Vendor adapters translate at the edge.
7. Every expensive capability has a deterministic non-GPU/reduced-motion fallback and explicit failure evidence.
8. A capability cannot advance to `BENCHMARKED` without real measurements, declared thresholds, stored raw results, environment metadata, and a reproducible runner.
9. `OPERATIONALLY_EVIDENCED` and `PRODUCTION_PROVEN` require their corresponding real evidence and are not V8 architecture closure shortcuts.

## 3. Proposed package architecture

```text
packages/experience/                  existing V2 intent/compiler contracts; compatibility preserved
packages/creative/                    V8 framework- and vendor-neutral creative domain
  art-direction/                      candidates, constraints, scoring, explanations
  vault/                              content-addressed manifests and deterministic resolution
  memory/                             Experience-owned decision memory ports and records
  choreography/                       timeline/scene IR and synchronization semantics
  shaders/                            safe shader graph/IR, resources, lifecycle and fallbacks
  interaction/                        gesture state machines, arbitration and accessibility equivalence
  governor/                           GPU/resource budgets and deterministic degradation policy
  evidence/                           creative decision and execution evidence events
  telemetry/                          performance samples and aggregation contracts
packages/creative-web/                optional browser execution adapters; no React requirement
  capability-signals/                 reliable browser signal collector
  waapi/                              native 2D choreography adapter
  webgl/                              WebGL shader adapter
  webgpu/                             progressive WebGPU adapter
  input/                              Pointer/keyboard/touch event adapter
  telemetry/                          Performance API observers and context-loss evidence
packages/creative-adapters/           optional third-party adapters, individually importable
  gsap/
  three/
  rive/
  lottie/
packages/creative-bench/              scenario schema, browser runner, comparators and report writer
apps/v8-creative-lab/                 non-production workload and failure-injection laboratory
docs/evidence/v8/                     immutable benchmark manifests/results when measurements exist
```

Dependency direction:

```text
@nexus/experience ───────────────┐
                                v
                         @nexus/creative
                                ^
                                |
@nexus/creative-web -------------+  (implements ports)
@nexus/creative-adapters --------+  (optional implementations)
@nexus/creative-bench -----------+  (consumes public ports/scenarios)
apps/v8-creative-lab ------------+  (composition root)
```

`@nexus/creative` may consume public, UI-agnostic `@nexus/experience` types through a narrow compatibility module. It must not depend on React, Next.js, Core, Experimental, apps, browser globals, or vendors. Web and vendor packages depend inward on `@nexus/creative`. No V8 package is added to Kernel.

## 4. Cross-cutting contracts

### Determinism

- Every compilation receives an explicit seed, contract version, capability snapshot, asset manifest digest, and adapter identity.
- Creative Vault references use `{ assetId, version, digest, variantId }`; “latest” is forbidden in compiled plans.
- State machines and choreography use monotonic logical time supplied by an execution clock port.
- Fallback selection is a pure function of the declared plan, capability snapshot, governor state, and recorded failure.

### Accessibility and graceful degradation

- Meaning, reading order, focus targets, controls, and completion state survive every degradation tier.
- Reduced motion replaces spatial travel/parallax/continuous motion with deterministic cuts, opacity changes, static keyframes, or immediate final state; it never merely slows problematic motion.
- Pointer gestures require keyboard and assistive-technology equivalents where they control meaning or navigation.
- Capability detection uses standardized feature/media-query checks and direct API availability. Viewport width, user-agent labels, `deviceMemory`, and network/hardware guesses cannot grant capability.

### Evidence and telemetry

Owned events record plan/asset/adapter versions, selected fallback, rejected capability, shader compile/context failure, governor transition, long frame, memory-pressure signal when directly observable, and reduced-motion execution. Telemetry is bounded, privacy-minimized, adapter-neutral, and never authorizes behavior.

## 5. Mandatory capabilities

### 5.1 Art Direction Engine

**Problem:** V2 captures intent but relies on a human to translate it into a coherent, testable direction; arbitrary generation can become template selection or novelty theater.

**Why NEXUS:** NEXUS already owns Experience DNA, Recipes, capability placement, originality evidence, and justified decisions. The engine must connect them into explainable candidates without choosing JSX/CSS.

**Complements/replaces:** Complements human direction and generative models; replaces ad-hoc prompt-to-page selection. It does not replace designers or clone visual references.

**Boundary:** `ArtDirectionEngine.compile(input): ArtDirectionDecision`. Inputs are versioned brief/DNA/plan, vault catalog, constraints, capability snapshot, memory query results, and seed. Output contains ranked candidate directions, rejected decisions, rationale graph, execution requirements, fallback obligations, originality evidence, and unresolved human decisions—never components or vendor instructions.

**Risks:** homogenization, rationale laundering, fingerprint gaming, hidden model nondeterminism, brand data leakage.

**Failure modes:** unsatisfied constraints; no accessible fallback; missing asset version; incompatible capabilities; low-confidence memory; all candidates overly similar; non-deterministic adapter response. Fail closed to an unresolved decision, not an invented direction.

**Mandatory tests:** deterministic replay; constraint conflict; no-template vocabulary gate; rationale coverage; reference inspire-not-copy; accessible fallback completeness; candidate stability under input ordering; untrusted model output validation.

**Benchmark workload:** compile editorial, cinematic, asymmetric, and industrial probes with fixed seeds; measure latency, peak memory, determinism, constraint satisfaction, unresolved-decision rate, and human-scored usefulness/diversity. Vendor model latency is reported separately.

**Promotion evidence:** source + tests for `TESTED`; real probe runs and stored reports against thresholds for `BENCHMARKED`; intentional lab/app consumer for `INTEGRATED`; production records only for later states.

### 5.2 Creative Vault

**Problem:** current asset labels cannot guarantee provenance, compatibility, reproducibility, or stable variants.

**Why NEXUS:** art-direction decisions must resolve the same licensed, transformed bytes across builds and fallbacks.

**Complements/replaces:** Complements DAM/CDN/object stores. It replaces direct URL/string selection as the domain contract; storage remains an adapter.

**Boundary:** immutable `CreativeAssetManifest`, `AssetVariant`, `TransformationLineage`, `UsageConstraint`, `VaultReader`, and `VaultWriter` ports. Digests and versions are required; transport URLs are adapter output, not identity.

**Risks:** licensing mistakes, digest mismatch, metadata drift, oversized catalogs, leaking private asset metadata.

**Failure modes:** missing digest/version; corrupt bytes; unsupported codec; expired usage rights; unavailable preferred variant; fallback cycle; store outage. Resolution either selects a declared compatible fallback or returns a typed failure.

**Mandatory tests:** digest verification; deterministic resolution; rights/time constraint; variant compatibility; fallback cycle rejection; corrupt/store failure; tenant/brand scope isolation; manifest migration.

**Benchmark workload:** resolve and verify media-heavy storytelling manifests at cold/warm start; measure lookup latency, bytes read, peak memory, digest cost, and fallback behavior.

**Promotion evidence:** conformance fixtures and tests; stored cold/warm measurements; lab integration using immutable fixture assets; no operational claim without real records.

### 5.3 Art Direction Memory

**Problem:** design decisions, rejected alternatives, outcomes, and evidence are not reusable, so teams repeat mistakes or copy prior output without context.

**Why NEXUS:** memory must preserve *why* a direction worked, its scope, provenance, and validity—not just vector similarity.

**Complements/replaces:** Complements vector/search databases and project archives. It replaces unstructured prompt history as the decision-memory contract. It must not import Industrial V4 memory.

**Boundary:** append-only `ArtDirectionMemoryRecord`, typed observation/decision/outcome kinds, provenance, brand/tenant scope, temporal validity, confidence, supersession, `MemoryStore` and `MemoryRetriever` ports. Retrieved memory is untrusted evidence, never authority.

**Risks:** cross-brand leakage, stale decisions, feedback loops, plagiarism, false outcomes, unbounded retention.

**Failure modes:** stale/expired records; conflicting outcomes; missing provenance; backend outage; low-confidence retrieval; scope mismatch; duplicate/colliding identity. The engine proceeds without memory or asks for review; it never silently broadens scope.

**Mandatory tests:** scope isolation; provenance required; deterministic ranking/tie break; temporal validity; supersession; conflict visibility; backend failure; retention bounds; retrieval cannot directly select a final direction.

**Benchmark workload:** retrieve from realistic decision corpora with brand and time filters; measure recall against curated relevance judgments, p50/p95 latency, update/delete visibility, peak memory, and isolation failures.

**Promotion evidence:** backend-neutral conformance suite; curated relevance dataset and stored results; at least one replaceable adapter for integration; real operations separately evidenced.

### 5.4 Shader primitives

**Problem:** shader-driven Experiences otherwise duplicate unsafe lifecycle code and lock art direction to a rendering engine.

**Why NEXUS:** NEXUS needs a small expressive primitive set tied to deterministic assets, accessibility fallbacks, budgets, and evidence—not a general game engine.

**Complements/replaces:** Complements WebGL/WebGPU/Three.js. It replaces app-specific uniform/resource/fallback conventions, not their rendering implementations.

**Boundary:** validated shader graph/IR, typed uniforms/textures, bounded passes, deterministic seeds, color-space contract, resource lifetime, compile result, context lifecycle, and required static/2D fallback reference. Raw shader escape hatches remain experimental and cannot be the only path.

**Risks:** driver variance, compilation stalls, context loss, excessive overdraw/memory, seizure/motion risk, fingerprinting surface.

**Failure modes:** unsupported feature; compile/link failure; invalid uniform; missing texture; context lost; budget rejection; frame instability. Governor selects a declared lower tier or static fallback.

**Mandatory tests:** IR validation; resource/pass limits; deterministic uniforms; adapter conformance; compile failure; context loss/restore; fallback completeness; reduced motion; color-space fixtures; cleanup/leak tests.

**Benchmark workload:** shader-driven hero at fixed resolutions and DPRs via WebGL, WebGPU when available, Three.js adapter where relevant, and static fallback; measure startup compile, frame-time distribution, GPU/JS memory proxies, context recovery, and visual fixture tolerance.

**Promotion evidence:** browser/device matrix results with raw traces and screenshots; thresholds and environment manifest; no universal “fastest” claim.

### 5.5 Gesture / interaction primitives

**Problem:** pointer, touch, keyboard, scroll, and cursor state are currently implemented per app without shared cancellation, arbitration, replay, or accessibility semantics.

**Why NEXUS:** interactive storytelling needs predictable state transitions that preserve meaning across input modes and degraded environments.

**Complements/replaces:** Complements native events, Pointer Events, WAAPI, and specialist gesture libraries. It replaces ad-hoc app state machines, not browser input APIs.

**Boundary:** renderer-neutral input samples, gesture recognizer port, deterministic state machine, ownership/arbitration, cancellation, velocity normalization, logical clock, keyboard equivalence, and evidence events. DOM collection lives in `creative-web`.

**Risks:** scroll hijacking, inaccessible pointer-only controls, gesture conflict, event floods, latency, platform divergence.

**Failure modes:** pointer cancellation; lost capture; multi-input conflict; page visibility change; reduced motion; passive-listener constraint; excessive event rate; adapter unavailable. Default behavior remains usable and native scrolling is preserved unless explicit ownership is safe.

**Mandatory tests:** state-machine replay; cancellation; arbitration; keyboard equivalence; focus preservation; native scroll escape; reduced motion; event coalescing; SSR/no-DOM import; fuzzed event sequences.

**Benchmark workload:** cursor/gesture state system, scroll orchestration, interactive product story, and synchronized 2D/3D transition under mouse/touch/keyboard; measure input-to-state latency, long frames, event volume, cancellation correctness, and task completion.

**Promotion evidence:** deterministic replay corpus; accessibility checks; real-browser traces across input types; stored comparisons.

### 5.6 GPU Governor

**Problem:** static “webgl/webgpu allowed” selection cannot react safely to frame instability, context loss, resource pressure, visibility, or thermal-like sustained degradation.

**Why NEXUS:** visual ambition must be bounded by experience continuity and explicit policy rather than renderer heuristics.

**Complements/replaces:** Complements renderer statistics and browser Performance APIs. It replaces app-local quality toggles as the admission/degradation policy.

**Boundary:** pure `GpuPolicy.evaluate(snapshot, samples, currentTier): GovernorDecision`; declared budgets for frame time, resources, passes, DPR, animation count, and recovery; hysteresis/cooldown; deterministic degradation ladder; evidence event. Direct thermal state is not claimed because browsers do not expose a reliable standard signal.

**Risks:** oscillation, false capability denial, misleading GPU timings, device fingerprinting, degraded art-direction identity.

**Failure modes:** missing telemetry; long-frame streak; context loss; resource allocation failure; hidden tab; reduced motion/data change; adapter report corruption. Fail toward the lowest semantically complete tier.

**Mandatory tests:** pure deterministic decisions; hysteresis; cooldown; missing/corrupt samples; sustained pressure; recovery; reduced-motion override; identity/fallback invariant; bounded evidence volume.

**Benchmark workload:** mobile-class CPU/GPU throttling emulation plus real devices where available; stress DPR, shader passes, textures, scroll, and synchronized transitions; measure frame-time stability, tier changes, recovery, memory trend, and startup.

**Promotion evidence:** declared policy thresholds, raw frame traces, device/browser manifest, stored decisions/results, and reproducible failure injection.

### 5.7 Benchmark framework

**Problem:** without a fair runner, NEXUS can claim superiority from synthetic or mismatched comparisons.

**Why NEXUS:** maturity decisions and adapter selection must use NEXUS workloads, accessibility fallbacks, and reproducible evidence.

**Complements/replaces:** Complements Playwright/browser tracing and vendor profilers. It replaces prose-only technology selection and non-reproducible demos.

**Boundary:** versioned `BenchmarkScenario`, `ImplementationAdapter`, `EnvironmentManifest`, `ThresholdSet`, `RunSample`, and immutable `BenchmarkReport`. An adapter declares supported semantics; unsupported features are reported, never scored as zero.

**Risks:** biased scenarios, warm-cache leakage, incomparable visuals, flaky CI, cherry-picked devices, benchmark-specific optimization.

**Failure modes:** unsupported browser/API; trace loss; thermal drift; visual mismatch; missing raw result; insufficient samples; threshold ambiguity. Such runs are invalid, not failures assigned to a competitor.

**Mandatory tests:** schema validation; environment capture; warm/cold isolation; sample sufficiency; percentile calculation; threshold evaluation; unsupported semantics; report digest; raw-result linkage; deterministic reduced-motion scenario.

**Benchmark workload:** all workloads in `docs/evidence/NEXUS_V8_BENCHMARK_PLAN.md`.

**Promotion evidence:** the framework becomes `TESTED` with calculation/conformance tests; only a capability with real stored qualifying runs can be `BENCHMARKED`.

## 6. Technology adapter decisions

| Technology | Where it may be better | V8 position |
| --- | --- | --- |
| Web Animations API | Native, low-dependency element animation and straightforward timelines | First-party baseline adapter for 2D choreography where browser support meets the scenario. |
| GSAP | Mature complex timelines, ScrollTrigger ecosystem, production debugging, broad compatibility | Optional adapter and likely reference winner for complex scroll orchestration until NEXUS evidence says otherwise. Do not copy its timeline API. |
| Three.js | General 3D scene graph, loaders, materials, ecosystem, WebGL portability | Optional 3D/shader adapter; NEXUS owns budgets/fallback/evidence, not a competing scene graph. |
| Rive | Authored interactive vector state machines with strong design-tool workflow | Asset/interaction adapter when authored state machines are the workload; preserve Rive semantics rather than pretending a generic timeline is equivalent. |
| Lottie | Existing After Effects vector animation delivery and wide content pipeline adoption | Asset playback adapter for supported compositions; report feature/rendering differences and startup cost. |
| WebGL | Broad current GPU reach and mature tooling | Primary low-level shader execution path, always optional and fallback-bound. |
| WebGPU | Modern explicit GPU model and compute potential | Progressive adapter only; never required for meaning or baseline access until support and measured value justify promotion. |

No technology is selected globally. Each benchmark scenario declares semantic equivalence, visual tolerances, unsupported features, bundle/startup inclusion, and fallback behavior before comparison.

## 7. Initial maturity matrix

| V8 capability | Initial maturity | Current evidence |
| --- | --- | --- |
| V8 baseline audit and architecture | IMPLEMENTED | This reviewed source-based audit and plan; validation gate still required for `TESTED`. |
| Art Direction Engine | PLANNED | Existing DNA/compiler are reusable inputs only. |
| Creative Vault | PLANNED | No V8 contracts or implementation. |
| Art Direction Memory | PLANNED | No Experience memory contracts or implementation. |
| Shader primitives | PLANNED | Descriptive premium capability IDs only. |
| Gesture / interaction primitives | PLANNED | One simple React scroll-reveal hook is insufficient. |
| GPU Governor | PLANNED | Adaptive Luxury is static declarative gating, not a governor. |
| Benchmark framework | PLANNED | Workload/threshold plan exists; no runner or measured result. |
| Third-party adapters | PLANNED | No dependencies or implementations selected. |
| V8 lab integration | PLANNED | No V8 lab app. |
| V8 operational evidence | PLANNED | No deployment or operations record. |
| V8 production proof | PLANNED | No production history or audit. |

Nothing is `BENCHMARKED`, `INTEGRATED`, `OPERATIONALLY_EVIDENCED`, or `PRODUCTION_PROVEN` at baseline.

## 8. Implementation sequence and exact file plan

### Block A — contracts and deterministic policy

- create `packages/creative/package.json`, `tsconfig.json`, `index.ts`;
- create the nine domain directories shown in section 3 with public entrypoints and tests;
- add root TypeScript project reference, workspace lockfile importer, boundary tests, and intentional exports;
- do not add browser or vendor dependencies.

### Block B — first executable vertical slice

- implement Art Direction Engine candidate validation/scoring with deterministic replay;
- implement in-memory Creative Vault fixtures and Art Direction Memory conformance store for tests only;
- compile one existing cinematic probe into a renderer-neutral choreography plan;
- keep rendering app-owned until contracts survive review.

### Block C — browser execution and governance

- create `packages/creative-web` with capability signals, WAAPI, input, telemetry, WebGL, and progressive WebGPU adapters;
- implement shader lifecycle/context loss, gesture replay, GPU Governor policies, and deterministic fallback;
- add `apps/v8-creative-lab` as a workload lab, never a template.

### Block D — comparison adapters and evidence

- create isolated adapters only for technologies justified by a scenario;
- create `packages/creative-bench`, workload fixtures, raw-result schema, report generator, and CI smoke runs;
- store real reports under `docs/evidence/v8/<report-id>/` only after reproducible execution.

No Rust crate is planned for V8 Experience. A future need would require a separate boundary review; it is not implied by this plan.

## 9. V8 Definition of Done

V8 may close only when all mandatory foundation/creative criteria below are met:

1. All seven mandatory capabilities have owned contracts, concrete purpose, documented failure modes, deterministic fallback, evidence hooks, and tests.
2. Art Direction Engine produces explainable, deterministic decisions for all four V2 probe families without emitting JSX/templates or hiding unresolved decisions.
3. Creative Vault resolves immutable digested assets and enforces provenance/usage/fallback contracts.
4. Art Direction Memory passes scope, provenance, temporal validity, conflict, and backend conformance tests without importing Industrial memory.
5. Shader and gesture primitives execute through at least one first-party web adapter and pass failure injection, cleanup, accessibility, and reduced-motion tests.
6. GPU Governor enforces declared budgets with deterministic hysteresis and semantically complete degradation.
7. Benchmark framework runs the required NEXUS workloads, stores raw results/environment/thresholds, and reports alternatives honestly, including cases where they are better.
8. At least the WAAPI baseline and relevant WebGL path are integrated in the V8 lab; vendor adapters remain optional and tree-shakable.
9. Neutral seed incurs no V8 runtime/bundle cost unless a creative capability is intentionally imported.
10. V3–V7 gates and all Node/TypeScript/Rust validation remain green; boundary tests prove no Experience/Industrial/Kernel erosion.
11. Documentation and maturity claims match stored evidence. No capability is promoted beyond its evidence.

`OPERATIONALLY_EVIDENCED` and `PRODUCTION_PROVEN` are not automatically required to close a scoped V8 creative foundation unless a later, human-approved scope explicitly includes them. Their absence must remain visible and forbids those claims.

## 10. Current conclusion

V8 has started at **PLANNED** capability maturity with an implemented baseline audit and architecture proposal. Strong implementation has not started. The next review gate is Block A: owned contracts and deterministic policy with no vendor/runtime dependency. V9 is not started.
