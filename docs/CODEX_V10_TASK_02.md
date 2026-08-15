# Codex V10 Task 02 — Object/Relationship Transaction Port

## Goal
Implement the next executable V10 capability on top of the Ontology Kernel and Schema Registry: a storage-neutral transaction port for ontology objects and relationships, plus a pure in-memory conformance implementation used by tests.

## Required contracts
- ObjectRecord with stable objectId, typeId, scope, properties, schemaId, createdAt and updatedAt.
- RelationshipRecord with stable relationshipId, relationshipTypeId, scope, role bindings, schemaId, createdAt and updatedAt.
- TransactionContext with tenant/organization/brand scope and actor/audit identity.
- TransactionPort supporting begin/commit/rollback semantics and atomic create/update/delete for objects and relationships.
- Query methods for get-by-id and relationship traversal sufficient for conformance tests.
- optimistic concurrency token/version on mutable records.

## Required invariants
- deny cross-scope reads/writes by default;
- reject undeclared type/property/relationship IDs against the active validated schema;
- reject relationship role bindings that violate declared endpoint constraints;
- reject stale optimistic-concurrency writes;
- commit is atomic: partial writes must not escape on failure;
- rollback leaves no externally visible mutation;
- immutable properties cannot be changed after creation;
- missing required properties fail closed;
- unknown properties fail closed;
- IDs remain deterministic/stable for the same canonical creation identity where applicable;
- no database SDK or vendor persistence type leaks into public contracts.

## In-memory conformance adapter
Implement only enough persistence to prove the port contract. It must be deterministic, isolated per scope and unsuitable to claim production durability.

## Tests
Add strong tests for atomic rollback, cross-scope denial, stale-write rejection, immutable-property enforcement, invalid role bindings, required-property validation and successful object+relationship transaction flow.

## Definition of done
- lint, typecheck, tests, build and V3→V10 gates pass;
- no persistence vendor dependency;
- in-memory adapter is clearly marked conformance-only;
- exact changed files and tradeoffs are reported;
- do not merge directly to main.