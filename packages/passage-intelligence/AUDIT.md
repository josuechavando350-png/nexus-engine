# Passage Intelligence audit

Status: source implementation in progress; exact-head CI required before merge.

## Capability 5/20

Implements passage-level optimization as an internal diagnostic surface. It does not claim to activate indexing of a passage and does not create doorway URLs.

## Revalidated Search contract

Google Search Central currently describes Passage Ranking as an AI system used to identify individual sections or passages of a web page to better understand how relevant a page is to a search. Google separately documents that crawling, indexing and serving are page/search-system outcomes and are not guaranteed merely because a page follows requirements. Helpful-content guidance explicitly says Google has no preferred word count.

## Hardening

- exact canonical page and passage digests;
- replay validation of every page assessment;
- hard passage/evidence/text budgets;
- duplicate IDs, dangling evidence references, unsafe URLs and URL credentials rejected;
- local-context debt detects ambiguous references and missing named entities;
- claim/evidence locality remains explicit;
- segmentation thresholds are internal human-utility diagnostics, not Google ranking thresholds;
- semantic duplication uses bounded pairwise comparison and yields consolidation recommendations, never doorway-page generation;
- blocked page crawl/index states fail closed;
- every result carries `INTERNAL_PASSAGE_DIAGNOSTIC_NOT_INDEXING_EVIDENCE`.

## Acceptance

Package typecheck/test/build, repository lint, all four exact-head NEXUS workflows, and final diff audit must pass before merge. No external indexing observation is inferred from the internal readiness score.
