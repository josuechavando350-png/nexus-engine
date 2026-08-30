# @nexus/topical-authority-graph

Deterministic, auditable internal graph diagnostics for pages, topics, intents, entities and evidence. The package preserves the reference capability's PageRank and weighted topical-authority model, but treats every score as a **NEXUS internal metric**, never as a Google/Search ranking metric or proof of external authority.

`createGraph()` canonicalizes and binds the exact graph; validates hard node/edge budgets, typed edge endpoints, HTTP(S) page/evidence URLs, duplicate nodes/edges, relation weights and acyclic topic-parent relationships. `pageRank()`, `assessTopics()` and `diagnostics()` operate only after graph replay validation.

`assessAuthority()` combines the reference dimensions: topical coverage, intent coverage, primary-evidence locality, internal-link cohesion and page centrality. The `0.6` relation/readiness thresholds are internal NEXUS heuristics preserved for deterministic diagnostics; they are not search-engine thresholds.

Cannibalization is emitted only as a **candidate diagnostic** when more than one page strongly serves the same declared intent. It is not evidence of ranking harm, keyword cannibalization in a search engine, or an instruction to create doorway pages.

Every diagnostic and assessment carries `INTERNAL_TOPICAL_AUTHORITY_DIAGNOSTIC_NOT_SEARCH_ENGINE_RANKING_EVIDENCE`. `validateAssessment()` deterministically replays the full assessment against the exact graph instead of trusting a caller-provided digest.

Operational consumer: `node scripts/audit-topical-authority.mjs --spec <graph.json>`. It exits successfully only for the internal `READY` state; `NEEDS_WORK` and `BLOCKED` remain non-zero.
