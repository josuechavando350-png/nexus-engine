# @nexus/passage-intelligence

Deterministic, evidence-bound diagnostics for section/passsage clarity, answerability, local context, claim/evidence locality, segmentation and semantic duplication.

Google currently describes **passage ranking** as a system used to identify individual sections or passages of a web page to better understand page relevance. NEXUS therefore does not expose a fictional "passage indexing API" or claim that an internal score proves a passage was indexed, ranked or served. Page crawlability/indexability remain page-level prerequisites, and Google explicitly does not guarantee crawling, indexing or serving merely because requirements are met.

`createPage()` canonicalizes page/passsage inputs and validates IDs, evidence references, URLs and hard collection budgets. `assessPage()` computes bounded internal diagnostics and human-oriented recommendations such as reheading, adding local context/evidence, useful subdivision, expansion and deduplication. It does not recommend doorway pages or arbitrary word counts for ranking purposes.

Every assessment carries `INTERNAL_PASSAGE_DIAGNOSTIC_NOT_INDEXING_EVIDENCE` and can be replayed through `validateAssessment()` against the exact page digest.

Operational consumer: `node scripts/audit-passage-intelligence.mjs --spec <page.json>`. It exits successfully only for the internal `READY` state; `NEEDS_WORK` and `BLOCKED` remain non-zero.
