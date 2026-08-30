# @nexus/entity-intelligence

Deterministic entity-salience, mention-location and conservative Knowledge Graph diagnostics for NEXUS.

The package preserves the consolidated reference contract: Google Cloud Natural Language entity analysis is used for detected entities, salience and UTF-8 mention offsets; Enterprise Knowledge Graph lookup/search is used as an optional resolution layer. MID lookup is the strongest resolution path. Search without a MID may remain `AMBIGUOUS` or `UNRESOLVED`.

## Trust boundary

Provider responses are carried as `UNATTESTED_PROVIDER_RESPONSE`. HTTPS/OAuth transport and deterministic parsing do not turn Google responses into cryptographically attested evidence. NEXUS binds the exact parsed response digest, document digest, entity digest and resolution digest, but does not claim provider signatures that do not exist.

All assessment output carries `ENTITY_INTELLIGENCE_INTERNAL_DIAGNOSTIC_NOT_GOOGLE_RANKING_OR_AUTHORITY_EVIDENCE`. Salience thresholds and resolution scores are internal NEXUS heuristics, not Google ranking metrics and not the former Knowledge Graph `resultScore`.

## Integrity and safety

- exact UTF-8 byte ranges are contiguous and cover the complete canonical document;
- hard limits bound sections, expected entities, text bytes, detected entities, mentions, KG candidates and request timeouts;
- unsafe/non-HTTP URLs, credential-bearing URLs, non-finite numbers, malformed offsets, duplicate semantic IDs and unknown object fields are rejected;
- detected mentions are rebound to document sections from their UTF-8 byte offsets;
- required Knowledge Graph resolution fails closed unless the bound resolution is `RESOLVED`;
- MID lookup only resolves an exact matching MID;
- search can return `AMBIGUOUS` when multiple candidates cross the internal threshold;
- `validateEntityResolution()` and `validateEntityAssessment()` replay deterministic derived state rather than trusting a digest alone.

The operational audit consumer is `node scripts/audit-entity-intelligence.mjs --spec <evidence.json>`. It validates an offline evidence packet and exits non-zero unless the assessment is `READY`.
