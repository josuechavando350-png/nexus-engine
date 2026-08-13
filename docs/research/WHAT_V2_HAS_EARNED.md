# WHAT NEXUS V2 HAS EARNED THE RIGHT TO ABSTRACT

Status: recommendation only. Nothing below is implemented. `@nexus/core`
was not modified in Phase 2. This is the evidence-gated gate for V2 the
brief asked for — only what the three probes actually proved, not ideas.

Classification key: **PROMOTE** (real, repeated, low-risk, safe to move
into Core) · **KEEP LOCAL** (real pattern, correctly belongs at the
Experience/app layer, should not move) · **NEED MORE EVIDENCE**
(plausible, but the sample size or the fact all three probes share one
author makes it too early to commit an API/architecture change) ·
**REJECT** (should not become shared infrastructure regardless of how
often it recurs).

## PROMOTE

### 1. `SKIP_LINK_CSS` (skip-link visual behavior as an exported string)
- **Evidence:** hand-written identically 4 times (`_experience-seed`,
  `reference-meson`, `reference-alfil`, `reference-nexus-bot`) — same
  ~10 lines, differing only in which token vars they reference (which
  already resolve automatically per theme).
- **Why promote:** zero art direction (pure a11y behavior), same shape
  Core already solved correctly for `SR_ONLY_CSS`/`REDUCED_MOTION_CSS`.
  Not promoting it means every future Experience keeps hand-copying it,
  with the drift risk already proven real (the broken `a11y.css`/
  `var(--space-3)` bug found in Phase 1).
- **Risk of promoting:** low. Adding a string constant does not
  constrain any Experience's design.

### 2. `:focus-visible` global rule (exported string, likely bundled with #1)
- **Evidence:** same 4 occurrences, identical outline rule
  (`outline: 2px solid var(--focus-ring); outline-offset: var(--focus-offset);`).
- **Why promote:** same reasoning as #1. This is the other half of the
  same gap.
- **Risk:** low, same as #1.

### 3. Base reset stylesheet (box-sizing, body margin/font, button/img reset)
- **Evidence:** near-identical across `_experience-seed` and all 3
  probes (4 occurrences) — every property either normalizes the box
  model or references a token variable, never a literal brand value.
- **Why promote:** this is exactly the kind of "infrastructure" Core is
  supposed to own per `AGENTS.md` §8 — it contains no client identity at
  all, unlike the retired `_template-client/globals.css`, which mixed
  reset rules with composition rules in one file (that mixing is part of
  why it went uncorrected for so long).
- **Risk:** low, provided whoever implements it resists adding anything
  beyond box-model normalization — the boundary between "reset" and
  "opinion" is exactly where `_template-client` went wrong before.

## NEED MORE EVIDENCE

### 4. Grid — asymmetric column ratios (e.g. `7fr 5fr`)
- **Evidence:** n=2 (`reference-meson`, `reference-alfil`), both hit
  identically, both from the same author in the same session (see
  `GRID_PRIMITIVE_LIMITATIONS.md`). `reference-nexus-bot` did not need
  this.
- **Why not promote yet:** the workaround (one line of hand-written
  `grid-template-columns`) is trivial and carries no duplication/drift
  risk — unlike #1–#3, there is nothing here that degrades if left
  alone. Two data points from one designer in one sitting is a weak
  basis for committing to a specific API shape (a ratio prop? a raw
  template-columns passthrough? unclear from n=2). Both probes happened
  to want the exact same `7fr 5fr` split, which could mean "this ratio
  matters" or could mean "one designer reached for a familiar number
  twice" — this dataset cannot tell those apart.
- **What would upgrade this to PROMOTE:** the same wall hit again by a
  different author, or by a real (non-probe) Experience, ideally with a
  different ratio than `7fr 5fr`.

### 5. Grid — true zero gap
- **Evidence:** n=1 (`reference-nexus-bot` only). Weaker than #4.
- **Why not promote yet:** same reasoning as #4, with less evidence
  behind it. The underlying use case (a continuous bordered/table-like
  composition family) is coherent and likely to recur, but one
  same-author data point isn't enough to shape an API around.
- **What would upgrade this to PROMOTE:** a second, independent probe or
  Experience needing a genuinely gapless grid.

## REJECT

### 6. The closing "statement" section (single big line before the footer)
- **Evidence:** appears in all 3 probes, AND in the retired
  `_template-client`, AND resembles the closing sections visible in the
  real production screenshots reviewed in Phase 1.
- **Why reject as a shared/Core abstraction, despite n=3:** this is
  composition, not infrastructure — promoting it would recreate exactly
  the kind of marketing-pattern default (`Statement`, functionally a
  sibling of the already-banned `Hero`/`Features`/`CTA`) that
  `packages/core/__tests__/components.test.ts` already exists to block.
  The evidence is also contaminated: I had already seen
  `_template-client`'s version of this pattern before designing any of
  the three probes, so repeated appearance may reflect anchoring, not
  independent convergence — `V1_1_VISUAL_DIVERSITY_REPORT.md`'s
  methodology note applies most strongly here. Rejecting a Core/shared
  version does not forbid any individual Experience from using this
  shape; it only means NEXUS should not bake it in as a default.

### 7. `radius.*` = 0 convergence (Alfil, Nexus Bot)
- **Evidence:** n=2, independently argued (editorial sharpness vs.
  technical precision), not copied from each other.
- **Why reject regardless of how often it recurs:** `radius.*` is
  classified EXPERIENCE-SPECIFIC per `_experience-seed/theme-contract.ts`
  — that classification is a deliberate boundary, not an observation
  waiting to be overturned by a popular vote. Centralizing "no radius"
  as a shared default is exactly the mechanism that produced the
  original problem this whole V1.1 effort exists to fix (a value that
  feels safe and tasteful becomes the unspoken default everyone keeps).
  This should stay rejected even at n=10, not just n=2.

## Not a candidate (observation, not an abstraction)

- **Primary-action + secondary-action interaction pairing** — real
  pattern (n=3), but it is a UX convention, not an artifact. There is no
  file or string to promote; noting it in
  `V1_1_VISUAL_DIVERSITY_REPORT.md` is the correct and complete handling
  of this finding.

## Already correctly placed — no action needed

- The four-tier `motion.duration`/`motion.easing` role structure already
  lives in Core and was exercised successfully by three Experiences with
  genuinely different motion character (physical press, slow underline
  grow, near-instant fade) built on the same four roles with different
  concrete values. This is the token system working as designed — not a
  new candidate, just a confirmation.


## V2 implementation note (2026-08-11)

V2 did not move compositional defaults into Core. Instead it introduced the separate pure-TypeScript `@nexus/experience` layer. The PROMOTE items listed above were already completed during V1.2 hardening; the NEED MORE EVIDENCE Grid items remain unpromoted; the REJECT items remain rejected.
