# Generative Readiness audit

Status: source implementation in progress; exact-head CI required before merge.

## Capability 4/20

Implements an internal, evidence-bound readiness model for generative Search experiences without inventing a GEO protocol, ranking signal, citation API, or special markup.

## Revalidated external contract

Google Search Central currently states that AI Overviews and AI Mode use normal Search eligibility and SEO fundamentals; there are no additional technical requirements or special schema/AI text files required. A supporting-link candidate must be indexed and eligible to be shown with a snippet. Google also documents `nosnippet`, `max-snippet` and `data-nosnippet` as real preview controls.

## Hardening beyond the preserved reference

- canonical runtime validation for all page inputs and collection budgets;
- duplicate IDs, dangling claim/evidence links, unsafe URLs and URL credentials rejected;
- empty claims/entities no longer receive perfect ratio scores by denominator shortcut;
- original-contribution score requires evidence-linked substantive descriptions rather than raw string count;
- entity clarity requires descriptions or explicit external identity links rather than raw entity count;
- volatile content freshness uses validated observation and modification timestamps and rejects materially future modification dates;
- `nosnippet` fails supporting-link readiness closed as `BLOCKED`; bounded/section snippet restrictions remain explicit `LIMITED` controls only when the quality model otherwise passes;
- readiness evidence carries exact `pageDigest` + `observedAt` and is independently replayed by `validateReadiness()`;
- deterministic digests are identity/integrity evidence, not proof that Google crawled, indexed, ranked, cited, or surfaced the page;
- no fabricated provider/AI-citation observation path exists.

## Acceptance

Package typecheck/test/build, repository lint, and all four exact-head NEXUS workflows must pass. Final diff must contain no production placeholders/TODO/FIXME/mock adapters. Documentation and a computed internal score do not count as external Search visibility evidence.
