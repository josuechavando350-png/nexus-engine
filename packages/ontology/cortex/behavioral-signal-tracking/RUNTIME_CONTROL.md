# CORTEX #6 production runtime control

`CortexBehavioralSignalRuntime` is the governed production entry point for CORTEX GREEN-SPEC #6. It binds the base behavioral tracker and the browser micro-signal tracker to the same durable transaction store, scope, privacy configuration and active policy.

## Durable control state

The runtime persists a single integrity-digested control object per ontology scope. The control stores only non-secret policy configuration, the active policy, the immediately previous policy and a monotonic generation. The pseudonymization secret is never written to control state.

Policy activation uses revision compare-and-swap plus an expected active-policy digest. A stale operator therefore cannot overwrite a newer policy silently. A policy supplied with a forged or stale digest is rejected before activation.

## Kill switch and rollback

`kill(expectedActiveDigest)` creates and activates a verified `KILLED` revision of the current policy. Both base and micro ingestion then fail closed without adding measurement state.

`rollbackPolicy(expectedActiveDigest)` atomically swaps the active policy with the immediately previous verified policy. This is configuration rollback, not deletion of already accepted measurement facts: erasing historical observations would make analytics less auditable, so rollback restores behavior without rewriting accepted evidence.

Control state is durable through the same `OntologyTransactionPort`; SQLite restart tests prove that an activated policy survives close/reopen and can still be rolled back afterward.

## Unified observability

The runtime emits privacy-minimized telemetry for base ingestion, micro ingestion and control transitions. Telemetry contains no raw event ID, raw session ID or privacy-decision reference. Validation failures are observable as error outcomes, and telemetry-sink failures are isolated from committed semantic results.

Direct construction of the lower-level trackers remains available for tests and specialized embedding, but deployments claiming GREEN-PROD for #6 should use `CortexBehavioralSignalRuntime` so kill, rollback and unified observability cannot be accidentally bypassed.
