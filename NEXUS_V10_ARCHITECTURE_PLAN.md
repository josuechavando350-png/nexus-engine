# NEXUS V10 Architecture Plan

## Mission

V10 evolves NEXUS from a measurable creative/runtime engine into a unified Operational + Creative Intelligence Engine. The same kernel must be able to model an enterprise, its digital experiences, the actions that change state, and the evidence that proves what happened.

V10 must not split NEXUS back into two products. Operational, creative, measurement and evidence concepts share one ontology kernel and remain isolated by domain modules, ports and policy.

## Core architecture

### 1. Ontology Kernel

The kernel defines vendor-neutral semantic primitives:

- ObjectType and immutable type identity
- PropertyType with explicit value type, cardinality and constraints
- RelationshipType with typed source/target roles
- InterfaceType for polymorphic capabilities
- ActionType for controlled state transitions
- FunctionType for pure/read-oriented derived logic
- EventType for immutable operational facts
- SchemaVersion and migrations
- tenant/organization/brand scope
- provenance, temporal validity and audit identity

The kernel is storage-neutral and graph-database-neutral. No database SDK, browser SDK, LLM SDK or vendor ontology type may leak into the public core contracts.

### 2. Operational Domain

Models real operating entities and processes such as customers, orders, products, inventory, assets, employees, suppliers, incidents, facilities, workflows and KPIs. Domain packages extend the kernel; they do not fork it.

### 3. Creative Domain

Connects brands, art direction, typography, layouts, components, interactions, motion, shaders, assets and reference-library entries to the same ontology. Creative decisions can therefore be traced to operational context and measured evidence.

### 4. Measurement and Evidence Domain

V9 Measurement, Capture, Benchmark and Evidence become first-class evidence sources for ontology objects, actions and experiences. V10 does not weaken V9 evidence semantics.

### 5. Action and Policy Runtime

Actions are declared separately from execution adapters. An action must define inputs, target object/interface types, authorization requirements, preconditions, effects and emitted events. Missing authorization or invalid preconditions must fail closed.

### 6. Query and Persistence Ports

V10 defines replaceable ports for schema storage, object persistence, relationship traversal, indexed search, transactions, subscriptions and event publication. Candidate technologies are benchmarked against NEXUS workloads before adoption.

### 7. AI Orchestration Boundary

AI is a caller of typed NEXUS capabilities, not an authority bypass. Agents receive explicit schemas and tool contracts, can query only authorized ontology surfaces, and may mutate state only through ActionType execution. Every mutation must be attributable and auditable.

### 8. Private Creative Library

The existing Creative Gallery/Vault evolves into a private reusable library of NEXUS-owned recipes and patterns. Entries may link to implementations, compatibility, performance evidence, device evidence, provenance and licensing metadata. External references remain references; third-party protected code is not copied into NEXUS.

## Unified semantic path

A valid V10 graph may connect:

Customer -> Order -> Product -> Brand -> Campaign -> WebExperience -> Component -> Interaction -> BenchmarkRun -> EvidenceBundle

This is intentionally one graph/kernel with multiple domains, not two engines glued together.

## Security invariants

- Cross-tenant and cross-organization access is denied by default.
- Authorization applies to schema discovery, reads, traversals, actions and subscriptions.
- Actions cannot mutate undeclared object/property types.
- AI callers never receive implicit superuser authority.
- Provenance and audit identities are immutable.
- Secrets and credentials are adapter concerns and never ontology properties by default.
- Missing evidence is never equivalent to successful evidence.

## Technology-selection rule

No major V10 backend technology is selected by popularity alone. For each critical layer NEXUS must:

1. evaluate current leading candidates using primary documentation;
2. preserve a vendor-neutral port;
3. define representative NEXUS workloads;
4. benchmark latency, throughput, consistency, migration complexity and operational cost;
5. record tradeoffs and replacement difficulty;
6. adopt only after measured evidence supports the decision.

## Initial V10 sequence

1. V10 foundation, technology landscape, gates and CI V3->V10.
2. Ontology Kernel types, constraints, canonical identities and negative tests.
3. Schema registry + versioning/migration contracts.
4. Object/relationship transaction port and in-memory conformance implementation.
5. Interfaces, Actions, Functions and Event contracts.
6. Contextual authorization and audit trail.
7. Operational domain reference model.
8. Creative ontology bridge + private library metadata.
9. Query/subscription adapters and benchmark harness.
10. AI orchestration/tool contracts with fail-closed policy.
11. Integrated operational + creative reference application.
12. V10 closure audit, benchmark evidence and claim reconciliation.

## Acceptance

V10 closes only when the unified kernel is implemented and tested; operational and creative domains both consume it; actions are authorization- and audit-aware; storage remains replaceable; V3->V10 CI is green; and any performance, maturity or production claim is backed by stored evidence rather than architecture prose.