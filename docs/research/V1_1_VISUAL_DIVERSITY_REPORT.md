# NEXUS V1.1 — Visual Diversity Report

Comparing `reference-meson`, `reference-alfil`, `reference-nexus-bot`.
Descriptive only — no invented percentage of "difference." All claims
below are backed by direct inspection of the three probes' source (grep
output quoted where useful), not impression.

## Methodology note — read this before the rest

**All three probes were designed by the same single author (me, in one
session) in immediate succession.** This is a real limitation of this
evidence, not a footnote. Any habit I default to — an opening block
shaped like "label + heading + copy + action," a closing single-line
statement section, a "primary filled action + secondary lighter action"
pairing — will show up as "shared" across all three regardless of
whether NEXUS's architecture forces it. A same-author study cannot fully
distinguish "Core allows genuine divergence" from "this particular
author's taste didn't diverge as much as three independent designers
would have." `HUMAN_VISUAL_DIVERSITY_TEST.md` exists specifically to
address this gap later, with real external judgment — it has not been
run.

## Pairwise comparison

### Composition
- Mesón: layered/asymmetric, text and media overlap via negative margin.
- Alfil: asymmetric editorial split, no dominant hero media at all.
- Nexus Bot: left-aligned text + bordered technical diagram.
- No two probes share a composition family. Mesón↔Alfil both use a
  `7fr 5fr` asymmetric grid ratio in the hero — same underlying CSS
  mechanism, but arranged with different content and directionality
  (Mesón: media overlaps and bleeds past the grid; Alfil: no media in
  that slot at all, a bordered aside instead). Flagged as a real,
  specific overlap at the mechanism level, not at the perceived-result
  level.

### Typography
- Mesón: large sans-serif system stack, tight leading, small-caps tag.
- Alfil: Georgia/serif headlines, sentence case throughout.
- Nexus Bot: sans body + monospace labels/brackets.
- Confirmed zero shared `font-family` declarations across the three
  `styles.css` files (grep, see below). Case treatment differs
  genuinely: small-caps / sentence / uppercase-monospace.

```
reference-meson:      (no font-family override — inherits reset's system stack)
reference-alfil:      font-family: Georgia, "Times New Roman", serif
reference-nexus-bot:  font-family: ui-monospace, "SFMono-Regular", Menlo, monospace
```

### Navigation
All three: static (non-sticky) header, wordmark + `nav[aria-label]`, no
nav-embedded CTA button. This is the one area with almost no divergence
— classified below as convención web / infrastructure, not art
direction (see "GOOD SHARED INFRASTRUCTURE").

### CTA treatment
- Mesón: solid filled rectangle, hard offset shadow, "stamp" press
  interaction; secondary is underlined text.
- Alfil: primary is a bare underlined text link (no button chrome at
  all); secondary is a sharp outline rectangle.
- Nexus Bot: solid rectangle + outline rectangle, both with bracketed
  monospace labels (`[ Ver módulos ]`).
- Zero shared visual shape. **But** all three land on the same abstract
  interaction pattern — one higher-emphasis action, one lower-emphasis
  action. That pattern-level repetition is real; judged here as
  interaction convention (offering a primary/secondary action is
  extremely common web practice), not visual art direction, but it is
  reported rather than hidden. A genuinely different structure would be,
  e.g., a single CTA with no secondary at all, or three co-equal actions
  — none of the three probes tried that.

### Surface / radius
```
reference-meson:      radius.sm 0px / md 2px / lg 3px / full 999px (unused)
reference-alfil:      radius.sm 0px / md 0px / lg 0px / full 999px (unused)
reference-nexus-bot:  radius.sm 0px / md 0px / lg 2px / full 999px (unused)
```
- Alfil and Nexus Bot both land on "no radius, ever" — for independently
  argued reasons (editorial sharpness vs technical precision), not
  because either copied the other (each was designed without seeing the
  other two). Mesón diverges with visible small radius accents.
- `radius.full` (999px) is declared in all three themes and **used by
  none of them** — a shared value with zero actual visual effect. Not
  evidence of coupling; evidence that the theme files copied the full
  token role list out of habit even where a role went unused. Noted as
  a minor honesty issue in the probes themselves, not a Core problem.
- Two of three converging on "no radius" is worth watching if a fourth
  or fifth probe is ever built — one more data point in the same
  direction would start to look like an unspoken default rather than
  coincidence. Not concerning yet at n=3.

### Density / section rhythm
- Mesón: asymmetric, irregular (`nth-child(3n)` exception in the menu).
- Alfil: alternating, airy, generous whitespace.
- Nexus Bot: uniform, balanced, technical regularity (deliberate — a
  spec sheet is supposed to look regular).
- Genuinely different rhythms, and the regularity itself is meaningful
  per-brand (Nexus Bot's uniformity is not "less effort," it is correct
  for that brand).

### Media treatment
- Mesón: warm gradient/texture placeholder, explicitly captioned "Foto
  de muestra."
- Alfil: cool flat gradient placeholder, same honest captioning.
- Nexus Bot: no photography at all, by design — replaced with a line
  diagram.
- No real photography exists for any of the three (see "NO INVENTAR
  DATOS DE CLIENTES" in each `EXPRESSIVENESS.md`), so `media.dominantType`
  is honestly `unknown` for Mesón/Alfil in their fingerprints, not
  `photography` — this report does not claim photographic diversity that
  wasn't actually built.

### Motion
```
reference-meson:      instant 0 / fast 140ms / base 260ms / slow 480ms — press-and-lift
reference-alfil:      instant 0 / fast 180ms / base 420ms / slow 720ms — underline-grow, slow
reference-nexus-bot:  instant 0 / fast 90ms  / base 160ms / slow 240ms — near-instant, precise
```
- The four-tier duration *structure* is shared — that structure comes
  directly from Core's token roles (`motion.duration.instant/fast/base/
  slow`), so this is infrastructure, not art direction. The actual
  numbers span roughly 2x between Nexus Bot (fastest) and Alfil
  (slowest) at every tier, and the motion *character* (press/lift vs
  underline-grow vs near-instant fade) is different in kind, not just
  speed.

### Card dependence
Definition used: a **card-like unit** has its own independent visual
containment (border/background forming a discrete boundary) AND is
separated from siblings by margin/gap — it reads as a floating object.
A row or cell inside one continuous bordered structure (shared borders,
no gap) does not count.

| Probe | Total content units | Card-like units | Ratio |
|---|---|---|---|
| Mesón (hero-text, hero-media, 5 menu rows, statement) | 8 | 1 (hero media block) | 0.125 |
| Alfil (hero-title, hero-aside, media, 4 service rows, statement) | 8 | 1 (media block) | 0.125 |
| Nexus Bot (hero-text, diagram, 4 modules, statement) | 7 | 1 (diagram block) | ≈0.143 |

All three land low and within a narrow band (~0.12–0.14), despite
wildly different visual styles. Reading this: none of the three needed
cards as the default way to present multiple things — menu items,
services, and modules were each solved without floating boxes. This is
the strongest piece of evidence against "premium = cards" as a NEXUS
default. It is also consistent with all three being designed by someone
(me) who was explicitly primed against card-reliance going in — see
methodology note above.

### Information hierarchy
All three: single largest heading, then supporting copy, then a
labeled block of repeated content, then a closing single statement.
This shape is close to universal for one-page marketing sites generally
— treated as convención web, not NEXUS-specific coupling.

## Composition reuse — repeated patterns found, NOT abstracted

| Pattern | Seen in | Classification |
|---|---|---|
| Skip-link + `:focus-visible` CSS block, hand-written | Seed + all 3 probes (4x) | Infrastructure, currently duplicated — see abstraction recommendation |
| Reset stylesheet shape (box-sizing, body margin, button/img reset) | Seed + all 3 probes (4x) | Infrastructure, currently duplicated |
| `NEXUS_SECURITY_HEADERS_BASE` wiring in `next.config.ts` | Seed + all 3 probes (4x) | Infrastructure, correctly shared already |
| `SR_ONLY_CSS`/`REDUCED_MOTION_CSS` rendered from Core constants | Seed + all 3 probes (4x) | Infrastructure, correctly shared already |
| Header = wordmark `Link` + `nav[aria-label]`, no nav CTA | All 3 probes | Convención web |
| Opening block = label/tag + heading + copy + action(s) | All 3 probes | Convención web (see methodology caveat) |
| Closing single-line statement section before footer | All 3 probes, and matches the retired `_template-client` and the real production sites in the screenshots reviewed in Phase 1 | **Flagged for scrutiny** — most likely convención web, but given the retired template already had a `.nexus-statement` section, this is the one pattern where "I'm repeating a shape I've already seen in this repo" is a live possibility, not just single-author taste in the abstract |
| Primary filled action + secondary lighter action | All 3 probes | Interaction convention, not visual art direction |
| `7fr 5fr` asymmetric grid ratio in the hero | Mesón, Alfil (not Nexus Bot) | Mechanism-level coincidence — same CSS technique, different resulting composition |
| `radius.*` = 0 everywhere except `full` | Alfil, Nexus Bot (not Mesón) | Independently-argued convergence, not copying — watch if it recurs at n=4/5 |

## GOOD SHARED INFRASTRUCTURE vs BAD SHARED ART DIRECTION

**Good shared infrastructure (appropriate, should stay shared, some
currently missing a proper home):**
- `@nexus/core` primitives (`Container`, `Cluster`, `Link`, `Stack`)
- `NEXUS_SECURITY_HEADERS_BASE`
- `SR_ONLY_CSS` / `REDUCED_MOTION_CSS`
- Skip-link / `:focus-visible` CSS (duplicated 4x — see recommendation)
- Reset stylesheet shape (duplicated 4x — see recommendation)
- Four-tier motion duration/easing *structure* (values differ per brand)

**Bad shared art direction found:** none. No shared color. No shared
font-family. No shared CTA shape. No shared card usage (all near-zero,
for different structural reasons). The closing-statement section pattern
is the closest candidate and is explicitly flagged above rather than
cleared.

## Answer to the specific questions asked

- **Composition, typography, navigation, CTA, surface, density, media,
  motion, section rhythm, card dependence, geometry, information
  hierarchy** — covered above, section by section.
- **Similitudes accidentales identificadas:** the `7fr 5fr` hero ratio
  (Mesón/Alfil), the "no radius" convergence (Alfil/Nexus Bot), the
  closing-statement section (all three), the primary/secondary CTA
  pairing (all three).
