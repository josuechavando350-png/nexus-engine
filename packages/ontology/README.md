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

## Authorization and action execution

State-changing work follows one controlled path:

`principal/AI -> action request -> contextual authorization -> transaction -> audit`

The authorization layer requires an explicit permission, exact ontology scope matching, and human approval when the action is HIGH or CRITICAL risk. The action executor validates the action against the active schema before it reaches the transaction port, uses a non-empty requestId for idempotency, and records COMMITTED, DENIED or FAILED outcomes in the audit trail. No AI provider or caller is allowed to bypass this boundary and mutate ontology state directly.

## Operator note

This package must remain understandable without oral knowledge from the original author. Any new primitive, invariant, authorization rule or migration behavior must be documented alongside tests and the V10 architecture plan.
