# CANO Penal CDMX — Tournament Zero

This is the clean starting boundary for the next CANO strategy tournament.

## Zero means zero

The tournament begins with:

- **0 inherited strategies**;
- **0 selected winners**;
- **0 copied NEXUS software-tournament inputs**;
- **0 commercial outcome claims**;
- **0 production mutations**;
- **0 assumptions imported from the September CANO exploratory tournament**.

The fixed identity is `cano-penal / canopenal.com`, market scope Mexico / Ciudad de México, language `es-MX`.

## Pre-audit state

Running:

```bash
node tournaments/cano-penal-zero/tournament-zero.mjs
```

must return `READY_FOR_AUDIT` with `strategyCount: 0`.

No strategy generation, scoring, ranking, winner selection, SEO change, content publication, Ads mutation, deployment, or client-site mutation is authorized by this stage.

## Binding the audit

The user's market audit may be any file type. Before its contents can influence strategy generation, its exact bytes must be bound by SHA-256 to a small JSON manifest:

```json
{
  "schemaVersion": 1,
  "tournamentId": "CANO_PENAL_CDMX_ZERO",
  "siteId": "cano-penal",
  "siteHostname": "canopenal.com",
  "evidenceClass": "USER_SUPPLIED_MARKET_AUDIT",
  "evidenceLabel": "descriptive-label",
  "evidenceSha256": "sha256:<64 lowercase hex>"
}
```

Then:

```bash
node tournaments/cano-penal-zero/tournament-zero.mjs \
  --audit /path/to/audit \
  --audit-manifest /path/to/audit-manifest.json
```

The only successful transition is `AUDIT_BOUND_STRATEGY_GENERATION_PENDING`. It still contains zero strategies and no winner. Strategy creation is a later stage derived from the bound audit and any additional evidence explicitly introduced for CANO.

## Fail-closed boundaries

The engine rejects:

- another tenant ID or hostname;
- reuse of a previous tournament;
- production mutation authority;
- audit bytes whose SHA-256 does not match the manifest;
- a manifest from another tenant;
- extra manifest fields that attempt to preselect a strategy;
- evidence classes that promote the audit into certified market truth.

This directory is intentionally independent of the NEXUS software commercial tournaments V1–V4. Their strategies, Search Console rows, keyword snapshots, winners, assumptions, and modeled outcomes are not inputs to CANO Tournament Zero.
