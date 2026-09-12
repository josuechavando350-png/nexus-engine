# SEO Avengers 2500 — strict white-hat local growth

This branch is the incremental build toward the final exact M001-M2500 composition.

Current reviewed implementation in this tree:
- M001-M1000: delegated to the audited `seo-avengers-1000` runtime.
- M1001-M1200: 200 executable local-growth capabilities implemented here.
- M1201-M2500: explicitly `RESERVED_NOT_EXECUTABLE` while later reviewed batches are built. Reserved slots are never counted as production capabilities.
- M2501: forbidden.

## Non-negotiable policy

Every local module in this batch is `SAFE_WHITE_HAT` and `OBSERVE_ONLY`.

The runtime:
- does not publish pages;
- does not mutate client content;
- does not create links;
- does not scrape Google;
- does not call an external provider;
- does not write to a database;
- does not require a new API, database, queue, service, cloud resource, secret, API key, token, or credential;
- never fabricates missing search/local/content evidence;
- returns `INSUFFICIENT_DATA` when evidence is missing and `ERROR` for malformed/conflicting evidence.

The white-hat policy block M1176-M1200 explicitly searches for doorway-like near-duplicates, location/service swap clones, keyword/location/service repetition, thin local pages, weak unique value, unsupported service/location claims, uncorroborated local facts, NAP conflicts, query-only pages, local-intent pages without verified identity evidence, unjustified freshness recommendations, predecessor policy regressions, scaled similar-page clusters, weak information gain, and identity conflicts. M1200 aggregates the exact M1176-M1199 receipts and fails closed if any policy guard reports a finding or execution error.

## Local-growth families in M1001-M1200

- M1001-M1100 — local demand capture: ranking-band opportunities, zero-click demand, intent share, query/page fragmentation, landing-page breadth, Pareto opportunity frontiers, integer Gini concentration, service×location demand tensors, confidence-aware CTR gaps, and click-efficiency lift.
- M1101-M1150 — local entity evidence: NAP/content corroboration, modal source quorum, exact outlier isolation, query↔entity alignment, evidence completeness, NAP+geolocation corroboration, grouped identity/geolocation disagreement, and local-demand→page→identity bridges.
- M1151-M1175 — local content intelligence: service/location/commercial/question/urgency coverage and distribution, plus pair co-occurrence and proximity.
- M1176-M1200 — strict white-hat safety firewall and release gate.

The implementations are not ID-only threshold clones. The manifest binds each module to a distinct operation, evidence contract, kernel/parameter program, purpose, policy classification, source mapping, and functional fingerprint. Import-time invariants reject duplicate operation names or duplicate functional fingerprints.

## Determinism and evidence

The runtime uses NFC canonical JSON, SHA-256 receipts, int64-bounded integers and PPM fixed-point arithmetic. Floats are rejected. Tests scan the runtime for float literals and direct network-client imports.

Search evidence uses the already-existing `search_performance_records` contract. Local evidence uses the already-existing `local_business_records` contract. Content uses the already-existing `content_documents` and `content_decay_records` contracts. `upstream_evidence` is reused for predecessor policy receipts. No new infrastructure contract is introduced.

## Verification

From the repository root:

```bash
bash seo-avengers-2500/scripts/verify.sh
```

The verifier first chains the audited `seo-avengers-1000` verifier, then compiles and tests this batch. The current batch test suite proves exact M1001-M1200 cardinality, exact M2001-M2200 source mapping, 200 unique operations, 200 unique functional fingerprints, deterministic receipts, no runtime float literals or direct network clients, honest reserved slots, malformed-input fail-closed behavior, and a fail-closed M1200 white-hat gate.

This is deliberately not represented as the final 2500 certification yet. Later ranges must be implemented, audited, connected, and tested before any terminal M2500 certifier can truthfully claim a complete M001-M2500 suite.
