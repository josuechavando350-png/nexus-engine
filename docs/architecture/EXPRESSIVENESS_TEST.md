# NEXUS Expressiveness Test — design only, not implemented

## Question it answers

Can the same Core sustain radically different Experiences WITHOUT each
Experience fighting the framework to get there? Visual diversity alone
(three screenshots that look different) is weak evidence — an Experience
could look different only by working around Core, which would mean Core
isn't actually flexible, just avoidable.

## What it would measure, per Experience

| Signal | How it would be counted (design, not built) |
|---|---|
| Overrides | Occurrences of `!important`, or inline styles that override a value already supplied by a Core primitive's own style output |
| Hacks | Magic-number CSS selectors targeting Core's internal DOM structure (e.g. `:has()`/`:not()` chains reaching past a primitive's public API), `@ts-expect-error` / `eslint-disable` comments touching Core imports |
| Abandoned primitives | Custom `<div>`s that re-implement what an available Core primitive (`Box`, `Stack`, `Cluster`, `Grid`, `Container`) already does |
| Duplicated code | Re-implementations of something Core already exports (the exact pattern found during the V1.1 audit: `SR_ONLY_CSS`/`SKIP_LINK_CLASS` hand-copied instead of imported) |
| Exceptions | Any documented deviation from `AGENTS.md` boundaries, tracked explicitly rather than silently |
| CSS fighting defaults | Rules whose only effect is to cancel something a Core primitive or Core CSS export already set, rather than add new design |

## Target shape of the result

```
high visual diversity (Style Fingerprint spread across Experiences)
                    +
low friction against Core (few overrides/hacks/duplicates)
```

Low diversity + low friction = everyone still building the same site.
High diversity + high friction = Core isn't actually reusable, Experiences
are fighting it. High diversity + low friction is the only combination
that supports the underlying claim ("same Core, genuinely different
Experiences").

## Why this is not implemented yet

There is nothing to measure it against. Zero reference implementations
exist today (`reference-alfil` is an empty placeholder). Building
automated counting against a sample size of zero would produce a number
with no meaning. This document exists so that when reference
implementations are built (explicitly NOT in this phase), there is
already a defined methodology to apply to them, rather than inventing
metrics after the fact to match whatever was built.

## Explicitly out of scope for V1.1 Phase 1

No tooling, no CI check, no score. This is a specification for later use.
