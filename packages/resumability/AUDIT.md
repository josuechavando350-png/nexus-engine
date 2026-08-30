# Resumability audit

Status: source integration in progress; exact-head CI required before merge.

## Capability 8/20

Implements `@nexus/resumability` from the consolidated NEXUS reference: serialized state, explicit symbol manifest, delegated events and exact lazy import without whole-tree hydrate replay.

## Preserved source contract

- state is JSON-serializable;
- symbols declare exact module/export pairs;
- event delegation finds the bound host and imports only the selected handler;
- handlers may access only explicitly captured state IDs;
- submit prevention occurs before lazy import;
- V1 is an explicit-handler runtime, not a Qwik optimizer clone.

## Hardening beyond reference

- deterministic replay validation for state and manifest before render/resume;
- bounded state values, JSON depth/nodes, symbols, bindings, captured IDs and payload bytes;
- strict IDs, event enum, symbol export names and duplicate detection;
- root-relative `.js`/`.mjs` module paths plus same-origin enforcement at runtime;
- manifest-to-state binding rejects captured IDs that do not exist;
- safe JSON script escaping;
- import cache removes failed loads, while `onError` contains async importer/handler failures;
- `dispose()` removes listeners and cache state;
- explicit non-claim: manifest/build digests are deterministic metadata checksums and do not prove fetched module-byte integrity.

## Acceptance

Before merge: browser-safe source (no Node-only runtime imports), package typecheck/test/build, repository lint, source-level operational consumer, deterministic runtime test with delegated event/lazy import/state projection, workspace lockfile synchronization, final diff audit and all four exact-head NEXUS workflows green.
