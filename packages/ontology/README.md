# NEXUS Ontology Kernel

The V10 Ontology Kernel is the vendor- and storage-neutral semantic core shared by NEXUS operational, creative, AI and evidence domains.

## Public contracts

The package defines ObjectType, PropertyType, InterfaceType, RelationshipType, ActionType, FunctionType, EventType and SchemaVersion primitives, plus deterministic SHA-256 schema identities and validation.

## Non-negotiable boundaries

- No database SDK types leak into public contracts.
- No AI/LLM SDK types leak into public contracts.
- Actions fail closed without explicit permission.
- Functions are read/derived only and cannot declare mutation effects.
- Cross-scope schema composition is rejected.
- Schema identities are deterministic and independent of declaration order.
- Operational and Creative domains consume this kernel; they do not fork it.

## Event/workflow invariants

- Domain events are append-only and scoped.
- Event identities are deterministic SHA-256 values over canonical event data.
- correlationId and causationId preserve causal lineage without granting execution authority.
- Workflow transitions are deterministic and validated against the active definition.
- Terminal workflow states cannot transition further.
- Optimistic concurrency rejects stale workflow revisions.
- Cross-scope workflow execution is denied.
- Event publication does not bypass Action authorization or transaction boundaries.
- Recovery/replay logic must preserve event ordering and scope isolation.

## Validation requirement

Any material change to ontology events/workflows must pass the full V3→V10 validation before merge. The workflow supports both pull-request validation and a v10-* branch-push fallback so missing PR event delivery cannot silently block release evidence.

## Operator note

This package must remain understandable without oral knowledge from the original author. Any new primitive, invariant or migration behavior must be documented alongside tests and the V10 architecture plan.
