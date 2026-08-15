# NEXUS V8 Experience / Creative Baseline Audit

Status: **AUDITED / V8 PLANNED**. Audit date: 2026-08-15. This document describes the repository at the start of V8. It does not claim that any V8 capability is implemented, benchmarked, integrated, operationally evidenced, or production proven.

## Scope and source of truth

The audit uses the checked-out repository after the scoped V7 foundation/architecture closure. Active source, manifests, workspace configuration, tests, and package exports take precedence over historical prose. V8 is confined to the Experience / Creative execution plane. It does not alter V3–V7 Industrial authority, the V7 Kernel, or their build planes.

Inspected sources:

- `packages/experience`, including its tests and public exports;
- `packages/core`, especially motion, accessibility, composition, tokens, theme, and reset contracts;
- `packages/experimental`;
- the neutral seed, three reference Experiences, and four V2 probes under `apps/`;
- repository architecture, research, and quality tests;
- package manifests, workspace configuration, and lockfiles.

## Reusable Experience-plane inventory

| Existing asset | Actual reusable value | V8 disposition |
| --- | --- | --- |
| `ExperienceBrief` and reference observations | Brand intent, available assets, constraints, and explicit inspire-not-copy rule | Extend through versioned adapters; do not mutate V2 inputs silently. |
| `ExperienceDNA` | Justified, normalized art-direction intent across composition, density, geometry, typography, media, navigation, interaction, CTA, and motion | Primary input to a future Art Direction Engine, but not itself an engine. |
| `CompositionMove`, Recipes, and narrative stages | UI-agnostic structural vocabulary | Reuse as planning input; never compile directly to JSX or templates. |
| `compileExperiencePlan` | Deterministic capability placement and high-level media, interaction, responsive, motion, and originality plan | Preserve as V2 compiler; a V8 creative compiler may consume its output through an explicit compatibility adapter. |
| Originality fingerprints | Color-independent structural comparison and explicit similarity visibility | Reuse as one evidence signal; never treat structural novelty as automatic quality. |
| Premium capability registry | Purpose, cost, signal requirements, and named fallback for costly media/motion capabilities | Evolve into executable creative capability descriptors with measurable budgets; current entries are descriptive only. |
| Adaptive Luxury resolver | Reliable-signal gating for reduced motion, reduced data, hover, precise pointer, and declared JS/GPU/network budgets | Reuse its conservative signal policy; it is not yet a runtime GPU Governor. |
| Core motion roles and CSS | Semantic duration/easing roles and shared reduced-motion declarations | Reuse for deterministic 2D fallback; retain brand-owned concrete values. |
| `useScrollReveal` | Small React hook using `IntersectionObserver` with reduced-motion handling | Treat as a legacy/simple adapter, not the V8 gesture or scroll orchestration model. |
| Core accessibility signals | SSR-safe media-query constants/helpers for reduced motion, hover, pointer precision, and reduced data | Reuse as the only current device capability signals; do not infer hardware from unreliable APIs. |
| Core theme/tokens/components | Stable semantic styling and accessible primitives | Consume from apps as today; do not move creative runtime policy into Core. |
| Experience seed | Neutral integration target with no art direction | Use to prove optionality and zero-cost absence of V8 creative features. |
| Reference Experiences | Three deliberately distinct visual languages | Use as regression fixtures, not templates or benchmark winners. |
| Four V2 probes | Existing asymmetric, cinematic, editorial, and industrial plans/implementations | Candidate real workloads for compilation and rendering benchmarks. |
| Experimental style fingerprint and capability budget | Candidate APIs already isolated from Core | Evaluate for promotion only with evidence; do not import them into Core. |

## Current dependencies

### Package-level graph

- `@nexus/experience` has no runtime dependencies and no dependency on React, Next.js, Core, apps, Experimental, or Rust.
- `@nexus/core` has React only as a peer dependency; its motion hook is the sole React-specific motion primitive.
- `@nexus/experimental` has no declared dependencies.
- V2 probes depend on Core, Experience, Next.js, React, and React DOM.
- The seed and reference Experiences depend on Core, Next.js, React, and React DOM, but not Experience.
- No Experience package depends on the Rust workspace, and no Rust crate depends on an Experience package.
- No GSAP, Three.js, Rive, Lottie, WebGPU helper, WebGL engine, or browser benchmark runner is installed.

### Public-contract constraints

- `@nexus/experience` is framework-agnostic orchestration IP and currently exports brief, DNA, capabilities, composition, recipes, originality, Adaptive Luxury, premium capabilities, and compiler entrypoints.
- `@nexus/core` owns stable brand-agnostic foundation, accessibility, composition, components, and basic motion contracts.
- App-owned CSS and rendering remain the only concrete visual execution layer.
- V7 Kernel carries shared contract/evidence vocabulary only and is not a destination for V8 visual/runtime APIs.

## Existing coupling points

1. V2 probe apps manually translate `ExperiencePlan` intent into React and CSS. There is no typed bridge between plan decisions and execution evidence.
2. Premium capability IDs are compiled into plans, but no renderer registry resolves them to optional adapters.
3. Adaptive Luxury accepts caller-supplied signals and budgets; it has no feedback loop from measured frame time, thermal pressure, memory pressure, context loss, or startup cost.
4. `useScrollReveal` couples one motion behavior to React and the DOM. It does not model scroll ownership, cancellation, synchronization, gesture arbitration, or evidence.
5. Concrete animation timings are correctly app-owned, but there is no portable choreography IR connecting art-direction intent to WAAPI, CSS, GSAP, Rive, Lottie, or 3D adapters.
6. Asset references in briefs are human labels without content digests, transformation lineage, licensing/provenance fields, or deterministic version selection.

## Primitives that can evolve

- `ExperienceDNA` + rationale can evolve into scored art-direction constraints and explainable candidate selection.
- Recipes and composition moves can evolve into a renderer-neutral creative scene/choreography graph.
- Premium capability cost and fallback fields can evolve into declared resource envelopes and deterministic fallback chains.
- Adaptive Luxury can feed a future GPU Governor, provided measured runtime signals are separated from unreliable device inference.
- Core reduced-motion and capability helpers can drive a single deterministic capability snapshot at session start, with explicit updates when media queries change.
- Structural fingerprints can become evidence attached to generated directions and memory retrieval, without becoming an automatic originality oracle.

## Missing mandatory V8 capabilities

| Capability | Baseline reality |
| --- | --- |
| Art Direction Engine | No candidate generation, constraint solver, scoring, explanation graph, or decision evidence exists. V2 DNA/compiler are inputs, not this engine. |
| Creative Vault | No content-addressed creative asset manifest, provenance, license, compatibility, or deterministic version resolver exists. |
| Art Direction Memory | No Experience-owned memory record/store/retrieval contract exists. Industrial V4 memory is authority-separated and must not be reused by dependency. |
| Shader primitives | No shader IR, uniform/resource contract, compiler boundary, lifecycle, context-loss handling, or fallback implementation exists. |
| Gesture / interaction primitives | No renderer-neutral gesture state machine, arbitration, cancellation, keyboard equivalence, or event replay contract exists. |
| GPU Governor | No measured budget controller, admission policy, degradation ladder, hysteresis, or evidence hook exists. |
| Creative benchmark framework | No browser workload runner, comparison adapters, thresholds, stored results, or reproducibility manifest exists. |

The mandatory **Benchmark framework** therefore starts at `PLANNED`; the existing Industrial benchmark harness is a separate execution plane and is not reused as an Experience implementation.

## Relevant technical debt and discrepancies

1. Historical premium-capability documentation uses labels such as “PRODUCTION BASELINE.” Those are informal category labels, not V7/V8 maturity evidence. V8 uses only the canonical maturity vocabulary and makes no production claim.
2. Historical docs describe WebGL/WebGPU/shader capabilities, but active code only describes their intent and fallback. There are no shader primitives.
3. `RuntimeSignals` are booleans supplied by a caller; signal collection consistency and change handling are not contractual.
4. The current GPU budget is a coarse enum (`none`, `css-only`, `webgl`, `webgpu`) rather than a measurable policy.
5. Existing probe implementations are useful workloads but contain app-local CSS, so benchmark fixtures will need stable scenario manifests rather than source-copy comparison.
6. Build tooling warns when the runtime Node version is below the repository’s Node 24 contract; V8 benchmark evidence must record the exact toolchain and reject unsupported environments.
7. There is no remote CI result or deployed browser/device matrix embedded in the repository; local green must not be called operational evidence.

## V8 risks

- **Wrapper risk:** mirroring vendor APIs would add maintenance without NEXUS-owned semantics.
- **False originality:** an engine could optimize fingerprint distance rather than justified experience quality.
- **Vendor lock-in:** scene, timeline, asset, or telemetry contracts could accidentally encode one provider’s model.
- **Accessibility regression:** visual continuity could hide content, keyboard access, focus, or reduced-motion equivalence.
- **Nondeterminism:** asset drift, random seeds, time-based transitions, and capability races could make builds and evidence irreproducible.
- **GPU instability:** context loss, shader compilation failure, memory growth, thermal throttling, and long frames can destroy the experience.
- **Benchmark theater:** synthetic microbenchmarks or incomparable feature sets could manufacture a winner.
- **Boundary erosion:** placing creative contracts in Core/Kernel or importing Industrial runtime code would violate V7.
- **Bundle tax:** universal installation of 3D/animation engines would penalize Experiences that do not need them.

## Baseline conclusion

The repository has strong intent, composition, originality, accessibility, and conservative capability-gating foundations. It does not yet implement any of the seven mandatory V8 capabilities deeply enough to claim `IMPLEMENTED`. V8 starts at architecture and workload definition, with optional adapters and evidence-first promotion.
