# @nexus/generative-readiness

Evidence-bound internal readiness diagnostics for pages that may appear in generative Search experiences. The package models crawl/index eligibility, snippet controls, evidence coverage, primary/first-party support, entity clarity, original contribution, explicit questions, volatile-content freshness, and media context.

There is no magic GEO tag in this package. Google documents that AI Overviews and AI Mode have no additional technical requirements or special schema beyond normal Search eligibility and SEO fundamentals. A page must be indexed and eligible to appear with a snippet to be eligible as a supporting link. `nosnippet`, `max-snippet`, and `data-nosnippet` are treated as real publisher controls; `nosnippet` is therefore `BLOCKED` for this supporting-link readiness model, while bounded/section-level snippet restrictions can produce `LIMITED`.

The weighted score is a NEXUS diagnostic only. It is not a Google metric and does not predict crawling, indexing, ranking, traffic, AI Overview inclusion, AI Mode inclusion, or citation. The package never emits `llms.txt`, an AI text file, special GEO markup, or fabricated visibility evidence.

`createPage()` canonicalizes and validates the supplied content model. `assess()` revalidates that model, computes bounded diagnostics, binds the exact observation time, and emits replay-verifiable evidence. `robotsSnippetControls()` and `dataNoSnippetSectionIds()` expose only supported snippet controls for an actual emitter/consumer to apply.

Operational consumer: `scripts/audit-generative-readiness.mjs --spec <page.json> [--observed-at <ISO timestamp>]` reads a real page model from disk, computes readiness, emits the exact robots controls/section exclusions, and exits non-zero for `BLOCKED` or `NEEDS_WORK`.
