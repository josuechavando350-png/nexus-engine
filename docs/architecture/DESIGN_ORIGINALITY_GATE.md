# NEXUS Design Originality Gate

Status: **PERMANENT**, effective NEXUS V1.2. This is a standing review
principle for every future Experience, not a one-time audit.

## The rule

NEXUS has no mandatory visual appearance. There is no default hero, no
default navbar, no default button shape, no pill-by-habit, no default
card, no characteristic border-radius, no recognizable section
structure, no recognizable footer, no NEXUS motion signature, no NEXUS
splash signature. There is no "Nexus look."

Two sites built with NEXUS should be able to look like they came from
completely different creative studios. We share engineering. We do not
share art direction.

## The review checklist

Before approving any Experience, review each of the following and ask
the one mandatory question:

> **"¿Por qué ESTA Experience necesita esta decisión?"**

Not: "is it different from the others?" A decision that happens to be
different by accident still fails this gate if it wasn't chosen for a
reason specific to this Experience.

- HEADER
- NAVIGATION
- OPENING COMPOSITION
- TYPOGRAPHY
- CTA LANGUAGE
- GEOMETRY
- SURFACES
- CONTENT CONTAINERS
- MEDIA TREATMENT
- SECTION RHYTHM
- MOTION
- FOOTER

## Pass / fail

If the honest answer to any item is **"because that's how it was done
last time"** (the previous probe, the retired template, a habit) — that
item **FAILS**, regardless of whether the Experience ends up looking
different from every other NEXUS build. Looking different is not the
goal. Every decision being justified by this specific brand is the
goal; divergence is a side effect of doing that honestly across
multiple Experiences, not a target to hit directly.

## Relationship to other V1.1/V1.2 artifacts

- `StyleFingerprintV0` (`packages/experimental/style-fingerprint`)
  describes what an Experience became, after the fact. This gate is
  applied before/during design, not after.
- `docs/research/V1_1_VISUAL_DIVERSITY_REPORT.md` already flagged one
  real risk this gate exists to catch: the closing "statement" section
  that appeared in all three probes and in the retired
  `_template-client` — the report could not fully rule out anchoring
  (the same author having seen the old pattern before). This gate is
  the standing process meant to catch that kind of drift on every
  future Experience, not just retroactively in a research report.
- This is a manual review checklist, not automated tooling. There is
  no evidence yet to justify automating "does this decision have a
  brand-specific reason" — that is a judgment call, not a static
  analysis.


## V2 tooling

NEXUS V2 adds `StyleFingerprintV2` and `compareFingerprints()` under `packages/experience/originality.ts`. These tools measure structural similarity without using color/palette. They support this permanent human gate; they do not replace it. Similarity can be justified by a project-specific reason, but the score remains visible.
