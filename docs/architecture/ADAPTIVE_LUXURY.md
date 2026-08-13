# NEXUS Adaptive Luxury — architecture

Status: V1.2 reliable signals remain in `packages/core/a11y`. V2 adds a pure decision layer in `packages/experience/adaptive-luxury.ts` that resolves optional execution cost against those signals and a declared budget. Rendering remains Experience-owned.

## Principle

Same artistic identity, different execution cost, depending on real
device/user signals — never `if (mobile) removeEverything()`. The
identity should survive at every tier; only the computational cost
changes.

```
HIGH CAPABILITY / no reduced-motion / fine pointer
  → full expressive execution

REDUCED MOTION / coarse pointer / reduced data
  → simplified execution, same identity
```

## Signals NEXUS uses (implemented, `packages/core/a11y`)

| Signal | Export | Reliability |
|---|---|---|
| Reduced motion preference | `REDUCED_MOTION_QUERY`, `prefersReducedMotion()` | High — already existed, standardized |
| Pointer precision | `POINTER_COARSE_QUERY`, `POINTER_FINE_QUERY` | High — standardized |
| Hover capability | `HOVER_NONE_QUERY`, `HOVER_HOVER_QUERY`, `hasHoverCapability()` | High — standardized |
| Reduced data preference | `REDUCED_DATA_QUERY` | Medium — real but not universal (mostly Chromium today); treat as progressive enhancement, never the sole gate for critical content |
| Viewport / element size | native `@media`, `@container` | High — standardized, no Core wrapper needed |

## Signals NEXUS deliberately does NOT use

- `navigator.deviceMemory` — Chromium-only, inconsistent, exactly the
  "device detection disguised as intelligence" this architecture was
  asked to avoid.
- `navigator.connection` / `effectiveType` — not standardized across
  browsers; not reliable enough to gate a critical decision on.

`packages/core/__tests__/a11y.test.ts` has a standing test
(`does not infer capability from unreliable hardware/network signals`)
that fails if either of these gets added to `a11y/index.ts` later —
this exclusion is enforced, not just documented.

## What is intentionally NOT built yet

- No React hook (e.g. a hypothetical `useCapabilityTier()`). Nothing
  consumes these signals yet, so there is no real usage pattern to
  generalize from. Building one now would be the same mistake as
  Recipes-before-Experiences from V1.1.
- No numeric tiers. See `packages/experimental/capability-budget` — the
  Capability Budget shape exists, thresholds do not.
- No real user monitoring (RUM) feedback loop. A reasonable future
  direction, explicitly deferred to V2 or later, once a real Experience
  exists to collect real data from.

## How an Experience would use this today

Directly, via `@supports`/media queries and the exported query strings
— e.g. wrapping an expressive motion sequence in
`@media (prefers-reduced-motion: no-preference) and (hover: hover)` so
it only runs where it can be appreciated and controlled, while the
underlying content and identity stay identical at every tier.
