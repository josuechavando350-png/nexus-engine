# NEXUS Web Engine

Reusable engineering + Experience orchestration for building fast, accessible, secure and visually independent client experiences.

> Shared engineering. Local art direction.

**Current baseline:** `v2.0.0`

## What changed in V2

V1.x proved that Core could be brand-agnostic. V2 adds an **Experience Engine** so the workflow no longer collapses business intent, capability, composition and implementation into one repeated design recipe.

NEXUS V2 now has three explicit layers:

- `@nexus/core` — stable engineering primitives and contracts.
- `@nexus/experience` — pure TypeScript Experience DNA, briefs, capabilities, Recipes, originality analysis, Adaptive Luxury and plan compilation.
- `apps/*` — concrete visual implementation owned by each Experience.

`@nexus/experience` contains **no React, Next.js, CSS, brand palette or component variants**.

## Experience Engine flow

```text
Business Brief
  → Experience DNA
  → Capabilities
  → Recipe
  → Experience Compiler
  → Experience Plan
  → App-specific implementation
  → StyleFingerprintV2
  → Originality + human review
```

## Visual-independence proof

Four V2 probes intentionally use different structural grammars:

- `apps/v2-probe-editorial` — reading-led editorial sequence
- `apps/v2-probe-cinematic` — media-led full-height chapters
- `apps/v2-probe-industrial` — dense operational matrix
- `apps/v2-probe-asymmetric` — spatial asymmetric field

Their fingerprints exclude color and are compared structurally in repository tests.

## Repository

```text
nexus-web-engine/
├── apps/
│   ├── _experience-seed/
│   ├── reference-alfil/
│   ├── reference-meson/
│   ├── reference-nexus-bot/
│   ├── v2-probe-editorial/
│   ├── v2-probe-cinematic/
│   ├── v2-probe-industrial/
│   └── v2-probe-asymmetric/
├── packages/
│   ├── core/
│   ├── experience/
│   ├── experimental/
│   └── config/
├── archive/
│   └── _template-client-v1/
├── docs/
├── scripts/
└── tests/
```

## Non-negotiable boundaries

- Core never imports Experience, Experimental or apps.
- Experience Engine is framework/UI agnostic.
- Capabilities describe outcomes, never components.
- Recipes describe compositional relationships, never finished templates.
- StyleFingerprintV2 does not use color to decide originality.
- Apps own branding, composition and project-specific interaction.

## Validation

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm quality-gates
pnpm audit --audit-level high
```

GitHub Actions executes the same validation on `main` and pull requests.

## Documentation

Start with:

- `docs/architecture/V2_ARCHITECTURE.md`
- `docs/architecture/EXPERIENCE_DNA.md`
- `docs/architecture/CAPABILITIES_V2.md`
- `docs/architecture/RECIPES.md`
- `docs/architecture/ORIGINALITY_ENGINE.md`
- `docs/architecture/EXPERIENCE_COMPILER.md`
- `docs/research/V2_EXPRESSIVENESS_REPORT.md`
- `docs/research/HUMAN_VISUAL_DIVERSITY_TEST_V2.md`

NEXUS is not a page builder and not a library of industry templates. The objective is reusable technical IP that makes high-quality implementation faster without making the resulting sites look related by default.

---

## NEXUS V3 — Industrial Agentic Runtime

As of V3 this repository holds two independent execution planes.

```text
NEXUS
├── Core / Experience Plane     packages/core, packages/experience   (TypeScript)
└── Industrial Agentic Plane    runtime/                             (Rust)
```

The Industrial Agentic Plane is a Rust-first runtime for industrial
infrastructure, civil robotics, inspection, maintenance, logistics, defensive
monitoring and simulation: event ingest, an ontology with provenance,
deterministic entity resolution, task orchestration behind a safety policy
engine, a sandboxed WASM edge, and a one-way observation gateway.

It implements no targeting, fire control, weapon interface or lethal autonomy,
and the prohibition is compiled into the policy engine rather than configured.

```bash
node scripts/v3-architecture-gates.mjs   # architecture gates, no toolchain needed
cd runtime && cargo test --workspace     # full test suite, no infrastructure needed
cd runtime && cargo run -p factory-line  # end-to-end demo, offline
```

Start with [`runtime/README.md`](runtime/README.md) and
[`docs/architecture/V3_ARCHITECTURE.md`](docs/architecture/V3_ARCHITECTURE.md).
Verification status of every gate is in `NEXUS_V3_VALIDATION.txt`.


## V4 — Autonomous Intelligence Engine
V4 adds provider-neutral memory, persistent goals, typed planning, bounded reasoning, world-state branches, durable replay semantics, evaluation/recovery and capability-bounded multi-agent delegation. V4 cannot dispatch hardware directly; physical execution remains behind the V3 policy/simulation/approval/EdgeTask chain.


## V5 Build Candidate
Control-plane domain contracts live under `runtime/crates/nexus-*` V5 crates. V5 remains unclosed until Rust/adapters/benchmarks and the art-directed operational console are validated.

## V6 — Distributed Runtime (build candidate)

V6 adds provider-neutral cluster membership, consensus contracts, replication/anti-entropy semantics, constraint-first placement, leased discovery, explicit federation, offline journals, secure-mesh authorization contracts, fleet rollout state and signed-update policy. The distributed layer requires prior policy evidence and cannot bypass V3/V4/V5 safety or authorization.

The V6 source is a build candidate until Rust compile/tests, real adapter integration, distributed fault injection and reproducible benchmarks are executed.
