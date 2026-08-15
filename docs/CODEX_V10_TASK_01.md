# Codex V10 Task 01 — Ontology Kernel Core

## Goal

Implement the first executable V10 capability: a storage-neutral and vendor-neutral Ontology Kernel that can represent both operational and creative domains without depending on Palantir, TypeDB, Neo4j, PostgreSQL, an LLM SDK, browser APIs or a persistence driver.

## Required package

Create `packages/ontology` as an isolated TypeScript package. Do not merge these primitives into an existing industrial, creative or persistence-specific package.

## Required contracts

- `OntologyScope` with tenantId and organizationId plus optional brandId.
- canonical `TypeId` and schema-local names.
- `PropertyType` with scalar value kind, required/optional cardinality, uniqueness and immutable flag.
- `ObjectType` with typed properties and implemented interfaces.
- `RelationshipType` with explicit named roles and allowed object/interface endpoints.
- `InterfaceType` for polymorphic capabilities.
- `ActionType` declaration with target type/interface, typed inputs, preconditions/effects as declarative references only, required permission and emitted event types.
- `FunctionType` declaration for read/derived logic with typed inputs/outputs and no mutation semantics.
- `EventType` for immutable facts.
- `SchemaVersion` and deterministic schema identity.
- canonicalization independent of object insertion order and locale.
- SHA-256 identities for schema/type definitions.

## Validation invariants

Reject:

- empty or malformed IDs/names;
- duplicate property names;
- duplicate relationship role names;
- relationship types with fewer than two roles;
- references to undeclared interface/property/type IDs within a schema;
- action definitions without an explicit permission;
- action target types absent from the schema;
- function declarations that claim mutation effects;
- cross-scope schema composition;
- NaN/Infinity in numeric defaults or constraints;
- conflicting immutable/derived property semantics.

## Architecture constraints

- No imports from Palantir, TypeDB, Neo4j, PostgreSQL clients, Prisma, Drizzle, browser SDKs or AI/LLM SDKs.
- No persistence implementation in this task except an optional pure in-memory schema registry used for tests.
- Do not make Palantir-compatible naming a public API requirement.
- Preserve V9 Measurement/Evidence behavior.
- Keep Operational and Creative domains out of the kernel package; they will consume it later.

## Tests

Add strong Vitest coverage for deterministic identities, order invariance, invalid references, duplicate detection, scope isolation, action permission fail-closed behavior, relationship role validation and mutation-free FunctionType semantics.

## Definition of done

- lint, typecheck, tests, build and V3->V10 gates pass;
- public contracts are vendor/storage neutral;
- package contains no database or AI SDK dependency;
- exact changed files and tradeoffs are reported;
- do not merge directly to main.