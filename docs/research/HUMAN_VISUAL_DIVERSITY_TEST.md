# Human Visual Diversity Test — protocol only, not executed

Status: methodology for future use. No participants exist. No session
has been run. Nothing below is a result.

## Why this exists

`V1_1_VISUAL_DIVERSITY_REPORT.md` was written by the same person who
built all three probes — that is a real bias (see its methodology
note). An external human, shown the results with no context, is a much
stronger check on whether NEXUS actually produces distinct identities.

## Main question

> "¿Estas tres experiencias parecen provenir de la misma plantilla?"

## Participants (future)

- No fewer than 8–10 people, not previously involved in NEXUS or told
  anything about it beforehand.
- Mix of people with and without design/development background — the
  question is about perceived sameness, not technical critique.
- None of them should be the author of the probes.

## Materials (future)

- Full-page screenshots (desktop and mobile) of `reference-meson`,
  `reference-alfil`, `reference-nexus-bot`. No URLs, no filenames, no
  branding that reveals "NEXUS" — relabel screenshots as "Site A / Site
  B / Site C" before showing them.
- Optionally mixed in with 2–3 unrelated real websites (not built with
  NEXUS) as distractors, so participants aren't primed to assume all
  shown sites come from one place.

## Procedure (future)

1. Show all screenshots (A, B, C, plus distractors if used) at once,
   unlabeled beyond the letter.
2. Ask, open-ended, before any leading question: "Describe what you see
   in each one, in your own words."
3. Then ask directly: "Do any of these look like they came from the
   same template, design system, or agency? Which ones, if any?"
4. Then ask: "If you had to guess which ones (if any) were built using
   the exact same underlying code/framework, which would you group
   together, and why?"
5. Record verbatim reasoning, not just yes/no — the *why* is the useful
   signal (e.g. "these two feel similar because of the button style" is
   actionable; a bare "yes/no" is not).
6. Do not tell participants the real answer (all three share
   `@nexus/core`) until after they've answered.

## What would count as a good result

Most participants do NOT group all three together, and when they do
group any two together, their stated reason is not "they look like the
same site" in general but something specific and minor (e.g. "similar
button shape") — that would be useful, specific signal rather than a
global sameness verdict.

## What would count as a bad result

Multiple participants independently say something like "these all look
like they came from the same builder/agency/template" about all three,
unprompted, before the direct question. That would be strong evidence of
hidden visual coupling this project's own analysis missed.

## Explicitly out of scope here

No participants recruited. No screenshots captured. No session
scheduled or run. No results section exists because none should be
invented.
