# NEXUS V8 Creative Benchmark Plan

Status: **PLAN ONLY / NOT MEASURED**. No V8 capability is `BENCHMARKED`. This file defines candidate workloads, validity rules, and initial thresholds; it contains no benchmark result.

## Evidence required for a valid run

Every stored run must include repository commit, scenario/fixture digest, asset manifest digest, adapter and dependency versions, browser/OS/device, CPU/GPU identifiers when directly reported, viewport/DPR, power mode if known, cold/warm state, reduced-motion/data settings, sample count, raw traces, errors, visual reference captures, threshold set, and report digest.

Runs are invalid when semantic output is not equivalent, required raw data is missing, sample count is insufficient, the environment changes mid-comparison, or an adapter silently omits required behavior.

## Required workloads

| Workload | Required semantics | Candidate comparisons | Primary measures |
| --- | --- | --- | --- |
| Editorial choreography | Layered type/media sequence, interrupt, focus preservation, deterministic completion | CSS/WAAPI, GSAP where timeline complexity warrants it | startup JS, p50/p95/p99 frame time, long-frame count, completion correctness |
| Scroll orchestration | Pinned and free-flow chapters without trapping native scroll | WAAPI/ScrollTimeline where supported, GSAP ScrollTrigger, NEXUS adapter | input latency, frame stability, scroll escape, bundle/startup cost |
| Shader-driven hero | Bounded animated shader with static and reduced-motion equivalents | WebGL, WebGPU, Three.js adapter, static fallback | compile/startup, frame time, context recovery, memory/resource trend |
| Interactive product storytelling | Gesture-controlled chapters with deterministic state and keyboard equivalence | NEXUS interaction + WAAPI, GSAP, Rive where authored state machines fit | input-to-state latency, task completion, cancellation, accessibility |
| Cursor/gesture states | Hover/fine-pointer enhancement plus touch/keyboard baseline | Pointer Events adapter and relevant specialist adapter | event rate, latency, dropped/coalesced events, state replay correctness |
| Synchronized 2D/3D transition | DOM narrative synchronized with a bounded 3D scene | WAAPI + WebGL, GSAP + Three.js, NEXUS choreography adapters | clock drift, p95/p99 frame time, startup, recovery/fallback |
| Authored vector animation | Equivalent authored vector sequence and interaction | Rive, Lottie when semantically supported, static/WAAPI fallback | decode/startup, bundle/assets, frame time, supported-feature fidelity |
| Reduced-motion fallback | Same meaning, controls, focus, and final state without problematic motion | Every applicable implementation | zero prohibited motion, completion equivalence, startup and memory |
| Sustained mobile pressure | Repeated transitions, DPR/resource stress, background/foreground, context loss | Applicable GPU adapters and governor tiers | frame stability, tier oscillation, recovery, memory trend, battery/thermal notes when directly observable |
| Memory/startup pressure | Cold route plus media/creative initialization under constrained profiles | Every applicable adapter | transferred/parsed JS, first usable state, peak JS heap where supported, GPU resource count |

## Initial threshold sets

Thresholds are scenario acceptance criteria, not proof that any implementation currently meets them.

### Baseline desktop profile

- at least 30 measured runs per cold-start implementation and three 30-second steady-state samples;
- p95 frame time ≤ 20 ms and p99 ≤ 33.4 ms during required motion;
- no task over 100 ms attributable to creative initialization after first usable state;
- no unbounded positive memory trend across five repeated scenario cycles;
- deterministic state/result digest across repeated runs with the same seed and capability snapshot;
- zero missing keyboard/focus/reduced-motion completion paths.

### Mobile-constrained profile

- p95 frame time ≤ 33.4 ms and p99 ≤ 50 ms at the governor-selected tier;
- governor degradation begins after the declared long-frame streak and does not oscillate more than once per cooldown window;
- context/resource failure reaches a semantically complete fallback within 500 ms or before the next user action, whichever is earlier;
- no required content or control depends on GPU capability;
- reduced-motion run performs no continuous parallax, camera travel, or pointer-following animation.

### Synchronization profile

- p95 absolute 2D/3D logical-clock drift ≤ 8 ms and maximum drift ≤ 20 ms during a valid visible run;
- cancellation and page-visibility transitions finish in the documented state with no orphan animation/resource;
- adapter output satisfies the scenario’s visual/semantic fixture before performance comparison is considered valid.

## Comparison rules

1. Compare only implementations that satisfy the same required semantics and fallback obligations.
2. Include library, adapter, assets, initialization, and runtime cost; do not time only an inner loop.
3. Separate cold/warm results and native/vendor execution.
4. Report unsupported features plainly. Do not penalize them as zero-time wins or hide them.
5. Publish raw samples and invalid runs alongside summaries.
6. Do not force NEXUS to win. If GSAP, Three.js, Rive, Lottie, WAAPI, WebGL, or WebGPU is better for a workload, retain it as a replaceable adapter and record why.

## Promotion rule

A V8 capability may be marked `BENCHMARKED` only when a committed report references this or a superseding threshold set, includes valid real measurements and raw results, and passes the capability’s declared acceptance criteria. The existence of this plan, a harness, a smoke test, or a chart without raw evidence is insufficient.
