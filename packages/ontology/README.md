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

## Controlled AI boundary

AI providers are adapters, never execution authorities. The AI layer may inspect only explicitly exposed ontology Action metadata and may produce proposals for allowlisted Actions, but it cannot mutate ontology state directly. Proposals must preserve the caller scope, obey configured input budgets, fail closed if the provider fails or returns an invalid result, and escalate HIGH/CRITICAL risk work to explicit human approval. Execution remains behind contextual authorization, the Action Execution Orchestrator and the transaction boundary.

## Operator note

This package must remain understandable without oral knowledge from the original author. Any new primitive, invariant, migration behavior or AI execution boundary must be documented alongside tests and the V10 architecture plan.
