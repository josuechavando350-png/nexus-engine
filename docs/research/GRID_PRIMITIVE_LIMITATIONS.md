# Grid primitive — limitation analysis

Status: evidence + recommendation only. No change made to `@nexus/core`.

Source: `packages/core/components/primitives/grid.tsx`, read in full during
NEXUS V1.1. Two real limitations were hit while building the three
experience probes — not theoretical, both blocked an actual composition
decision and forced hand-written CSS instead of the primitive.

## Current implementation (verbatim behavior)

```ts
export function Grid({
  children,
  columns = 1,
  gap = "space.md",
  style,
  ...rest
}: GridProps) {
  const safeColumns = Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 1;

  return (
    <div
      {...rest}
      style={mergeStyles(
        {
          display: "grid",
          gridTemplateColumns: `repeat(${safeColumns}, minmax(0, 1fr))`,
          gap: spaceValue(gap)
        },
        style
      )}
    >
      {children}
    </div>
  );
}
```

`GridProps.columns` is a single `number`. `GridProps.gap` is a `SpaceRole`
(`"space.xs"` … `"space.xl"`) with no way to represent zero.

## Limitation 1 — no asymmetric column ratios

`gridTemplateColumns` is always `repeat(n, minmax(0, 1fr))` — every column
is forced to equal width. There is no prop for a ratio like `7fr 5fr`.

**Where this blocked real work:** `reference-meson`'s hero (`7fr 5fr` text/
media split) and `reference-alfil`'s hero (`7fr 5fr` title/aside split)
both needed an asymmetric split as a direct expression of "editorial,
not uniform" art direction. `Grid` could not express this — a symmetric
`columns={2}` grid was tried mentally and rejected because it would have
produced a centered, evenly-split layout, which is a different (and for
these two briefs, wrong) composition. Custom `grid-template-columns: 7fr
5fr` in `styles.css` was used instead, correctly, per instruction ("no
fuerces una primitive").

**Severity:** Moderate. Not a blocker — the workaround (hand-written CSS
grid) is one line and fully standard. But it means `Grid` in its current
form is only useful for uniform multi-column layouts (e.g. an equal card
grid), not for any asymmetric editorial composition — a meaningful chunk
of what "genuinely different Experiences" tends to need, based on this
sample of three.

**Note on `reference-nexus-bot`:** its module grid uses `repeat(2, 1fr)`
— columns ARE equal there. `Grid` was still not used, but for a different
reason (see Limitation 2), not this one.

## Limitation 2 — no true zero gap

`gap` only accepts a `SpaceRole`. No role maps to `0`. There is no way to
ask `Grid` for zero gap without inventing a new token value outside the
role system.

**Where this blocked real work:** `reference-nexus-bot`'s module section
needed cells with **shared borders and no gap** — a continuous
spec-sheet/table reading as one structure, not a set of separated boxes
(this was also the deliberate way to keep card dependence at zero for
that probe — see `V1_1_VISUAL_DIVERSITY_REPORT.md`, card dependency
section). Any non-zero gap would have visually turned the module grid
into a set of floating cards, defeating the specific art-direction goal.
Custom CSS (`display: grid`, no `gap`, shared `border-right`/`border-bottom`
per cell) was used instead.

**Severity:** Moderate. Same shape as Limitation 1 — not a blocker, but
it means `Grid` cannot produce the "unified table/diagram" composition
family at all, only "cards with breathing room between them."

## Are these worth fixing in Core?

Not decided here — that determination belongs in
`V1_1_VISUAL_DIVERSITY_REPORT.md`'s abstraction classification
(`PROMOTE` / `KEEP LOCAL` / `NEED MORE EVIDENCE` / `REJECT`). This
document only establishes what was actually observed and why, so that
classification has real evidence under it instead of a general
impression that "Grid felt limited."

## What this does NOT show

Both limitations are about **column geometry**, not about Core forcing
any aesthetic. Nothing here contradicts the Phase 1 finding that Core is
visually agnostic — `Grid` is agnostic too, just narrower in what
geometries it can express than these three probes needed. A geometry
limitation is not the same defect class as a leaked aesthetic default.
