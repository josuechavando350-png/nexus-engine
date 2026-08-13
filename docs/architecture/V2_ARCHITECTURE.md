# NEXUS V2 — Experience Engine Architecture

Status: implemented in `@nexus/experience`.

## Objective

NEXUS V2 separates five concerns that were previously too easy to collapse into one implementation habit:

1. **Content / business truth** — what the project needs to say and accomplish.
2. **Capability** — what a visitor/business needs to be able to do.
3. **Composition** — how meaning is ordered, related, interrupted, layered or revealed.
4. **Art direction** — the project-specific Experience DNA that gives those decisions a reason.
5. **Implementation** — React/Next/CSS/media code owned by an Experience app.

The V2 package is deliberately pure TypeScript. It imports no React, Next.js, NEXUS Core or application code. It plans intent; implementation remains local to each Experience.

## Physical boundary

```text
packages/core          stable engineering primitives; no art direction
packages/experience    V2 intent/orchestration contracts; no React/Next/UI
packages/experimental  research candidates and V1.x experimental vocabulary
apps/*                  concrete visual implementation
```

Core does not depend on Experience Engine. Experience Engine does not depend on Core. Apps may consume both.

## Primary pipeline

```text
Business / Experience Brief
        ↓
Experience DNA
        ↓
Capabilities (outcomes, not UI)
        ↓
Recipe (compositional strategy, not template)
        ↓
Experience Compiler
        ↓
Experience Plan
        ↓
App-specific implementation
        ↓
StyleFingerprintV2 observation
        ↓
Originality comparison + human review
```

## Why the compiler does not generate JSX

Generating a finished page from a Recipe would turn Recipes into templates by another name. V2 deliberately stops at a structured plan: narrative stages, capability placement, media/motion/responsive strategy, adaptive-luxury request and originality seed. A designer/agent still owns the implementation.

## Stability

V2 adds `@nexus/experience`; it does not rewrite `@nexus/core`. The V1.2 Core contract remains intact.
