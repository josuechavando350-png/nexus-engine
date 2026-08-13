# NEXUS Visual Architecture

Status: Draft — NEXUS V1.1 Phase 1. Not yet a governing baseline like
`docs/architecture/README.md` (Architecture v0.2). This document
describes intent for the visual/composition layers specifically.

## The layers

### Core (`packages/core`)

Semantic contracts only. No client identity, no marketing components, no
hardcoded colors/fonts/radius/typography values. Enforced today by real
tests (`packages/core/__tests__/*`, `tests/repository-boundaries.test.ts`).
Confirmed agnostic during the V1.1 audit — not changed in this phase.

### Starter (`apps/_experience-seed`)

Technical scaffolding for a new Experience: Next.js + Core wiring,
security headers, a11y contracts, a theme file with only the token roles
Core primitives actually read (see `theme-contract.ts` in that app).

**Contains:** infrastructure, behavior, contracts.
**Does not contain:** Hero, Navbar with visual opinion, CTA styling,
Cards, Gallery layout, marketing sections, default art direction, default
motion language, brand typography, decorative surfaces.

If the seed ever looks "finished" when rendered unmodified, that is a
regression — something opinionated leaked into it.

### Experience (a real client app, e.g. a future `apps/client-*`)

Fully free. Concrete theme values, composition, content, brand-specific
styling. An Experience is expected to be highly opinionated — that
opinion is supposed to look different from every other Experience's
opinion. NEXUS does not police design decisions inside an Experience.
The boundary NEXUS protects is what an Experience *starts from*, not what
it becomes.

### Capability (future, not built yet)

A capability is behavior + data model + accessibility contract, decoupled
from its visual representation (e.g. "Reviews" as a concept, independent
of whether it renders as a carousel, a quote wall, or a list). Nothing in
this repo implements this today. Not part of V1.1 Phase 1.

### Recipe (future, not built yet)

A named, composable way to arrange a capability visually (e.g. one of
several Hero recipes). Not built in V1.1 Phase 1 — explicitly deferred
per the approved scope.

### Experience DNA (future, not built yet)

A composable description of an Experience's art direction (typography,
geometry, composition, motion, surface, density...). Not built in V1.1
Phase 1.

### Reference Implementation (`apps/reference-*`)

Not a client mirror, not a demo, not a template. A deliberate proof that
the same Core can sustain a genuinely different design language. Frozen
by design — updated when the engine's architecture changes and needs
re-proving, not when a real client changes their copy or photos. Can be
partial (hero + nav + one section), not a full site. Currently:
`apps/reference-alfil` exists as an empty placeholder
(`package.json` only, already labeled "frozen reference implementation;
not a template"). Populating it with real content is explicitly OUT of
V1.1 Phase 1 scope (approved decision: no reference implementations built
yet).

## What belongs where — quick reference

| Decision | Core | Starter | Experience |
|---|---|---|---|
| Token role names (`space.md`, `radius.lg`...) | yes | no | no |
| Concrete spacing/motion timing values | no | yes (required roles only) | can override |
| Concrete brand colors, fonts, radius | no | **no** | yes |
| Layout primitives (Box, Stack, Grid...) | yes | consumes | consumes |
| Hero/Card/CTA/Navbar visual composition | no | **no** | yes |
| Security headers, a11y contracts | yes | consumes | consumes |
| Marketing copy | no | placeholder text only | yes |

## Core API candidates (documented, not implemented)

Found during the V1.1 audit. None of these were fixed — Core was not
modified in this phase, per instruction.

1. **`packages/core/a11y/a11y.css` export is broken.** The `package.json`
   `exports` map points `./a11y.css` at `./a11y/a11y.css`, but the
   physical file on disk is named `a11y . css` (literal spaces around the
   dot). Any consumer importing `@nexus/core/a11y.css` would fail to
   resolve. Additionally, that file's content uses `var(--space-3)`,
   which does not correspond to any token produced by
   `foundation/tokens/roles.ts` (`--space-xs/sm/md/lg/xl`) — it appears to
   predate the current token naming scheme.
2. **No exported `SKIP_LINK_CSS` string.** Core exports `SR_ONLY_CSS` and
   `REDUCED_MOTION_CSS` as ready-to-render string constants, and exports
   `SKIP_LINK_CLASS` / `skipLinkProps()`, but no equivalent CSS string for
   skip-link visual behavior or a global `:focus-visible` rule. Every
   consumer currently hand-writes this (found duplicated, with drift, in
   `_template-client/globals.css`; written again, deliberately, in
   `_experience-seed/a11y-gap.css` — see that file's header comment).
3. **`TokenRole` has no required/optional/derived/experience-specific
   metadata.** Today that classification lives only in
   `_experience-seed/theme-contract.ts`, as app-level convenience. If more
   apps need it, it may belong in Core instead — not decided, not
   implemented.
4. **No token derivation mechanism exists.** `accent.emphasis` and
   `accent.muted` are independent roles today; nothing computes them from
   `accent.default`. Flagged as a possible future direction only.

## What NEXUS V1.1 does NOT decide

- Whether `_template-client` gets renamed, moved, or becomes a formal
  fourth reference implementation. Documented as a candidate, not
  executed.
- Any fix to the Core API candidates above.
- Recipes, Experience DNA, Capability decoupling, Forge, Certify,
  Anti-Template. All explicitly out of scope for this phase.
