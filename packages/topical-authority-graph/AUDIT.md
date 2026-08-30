# Topical Authority Graph audit

Status: source integration in progress; exact-head CI required before merge.

## Capability 6/20

Implements `@nexus/topical-authority-graph` from the consolidated NEXUS reference as an auditable internal graph of pages, topics, intents, entities and evidence.

## Preserved source contract

- PageRank is an internal graph-centrality calculation.
- Weighted topical authority is a NEXUS metric built from coverage, intent coverage, primary evidence, internal-link cohesion and centrality.
- Cannibalization output is a diagnostic candidate when multiple pages strongly serve the same intent; it is not proof of external ranking harm.

## Hardening beyond the reference source

- exact canonical graph digest plus full replay validation;
- hard node, edge, text, URL and PageRank iteration budgets;
- strict node/edge runtime shape validation and unknown-field rejection;
- typed edge endpoint matrix prevents semantic edge confusion;
- duplicate nodes/edges, self edges, dangling references and non-finite/zero relation weights rejected;
- HTTP(S)-only page/evidence URLs with credential rejection;
- deterministic topic-parent cycle rejection;
- PageRank zero-weight ambiguity removed by requiring relation weights in `(0,1]`;
- assessment and diagnostics carry an explicit non-claim marker;
- final assessment validator recomputes every derived metric and rejects forged/rehashed outputs.

## Acceptance

Package typecheck/test/build, repository lint, operational-consumer execution, all four exact-head NEXUS workflows and final diff audit must pass before merge. Documentation and SHA-256 digests are not substitutes for replay validation or CI evidence.
