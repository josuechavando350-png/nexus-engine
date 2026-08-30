# Entity Intelligence audit

Status: source integration in progress; exact-head CI required before merge.

## Capability 7/20

Implements `@nexus/entity-intelligence` from the consolidated NEXUS reference: entity salience/mentions through Cloud Natural Language plus conservative Enterprise Knowledge Graph resolution.

## Preserved source contract

- entity mention locations are UTF-8 byte offsets;
- MID lookup is the strongest resolution path;
- search without a MID may return `AMBIGUOUS`;
- entity salience and weighted resolution scores are NEXUS diagnostics, not Google ranking metrics.

## Hardening beyond reference

- canonical document digest with exact content/section byte coverage validation;
- bounded sections, content bytes, expected entities, detected entities, mentions and KG candidates;
- bounded network timeout with injectable provider transport;
- strict runtime object validation and reserved/unknown-field rejection at stored evidence boundaries;
- HTTP(S)-only URLs and credential-bearing URL rejection;
- mention-to-section rebinding from actual UTF-8 offsets;
- detected entity, provider payload, resolution and assessment digests are explicitly linked;
- external responses are marked `UNATTESTED_PROVIDER_RESPONSE`, avoiding false cryptographic provenance claims;
- exact MID requirement for lookup resolution;
- conservative ambiguity handling for competing search candidates;
- required KG evidence fails closed when missing, unresolved or ambiguous;
- resolution and assessment validators deterministically replay derived state.

## Acceptance

Before merge: synchronize workspace lockfile, pass package typecheck/test/build and repository lint, run operational consumer against a deterministic evidence fixture, audit the final diff for placeholders/dead/mock production paths, then require all four exact-head NEXUS validation workflows green.
