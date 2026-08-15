# V10 Technology Evaluation Baseline

Status: FOUNDATION / NO BACKEND SELECTED YET

## Purpose

V10 requires an ontology kernel capable of operational and creative modeling without binding NEXUS to a single vendor. This document records the first architecture candidates and the benchmark questions that must be answered before adoption.

## Reference systems and candidates

### Palantir Foundry Ontology

Reference architecture only, not a dependency target. Relevant concepts include object types, link types, interfaces, actions, functions and dynamic security. NEXUS will study these semantics while implementing its own vendor-neutral contracts and domain-specific behavior.

### TypeDB / TypeQL

Candidate semantic persistence/query backend. Relevant characteristics to benchmark include strongly typed entities/relations/attributes, schema constraints, subtyping, relation roles and query functions. It must remain behind NEXUS persistence/query ports.

### Property-graph backend class

Property-graph systems remain candidates for traversal-heavy workloads and ecosystem interoperability. NEXUS must benchmark relationship traversal, schema enforcement strategy, transaction semantics, operational complexity and migration cost before selecting one.

### Relational/PostgreSQL backend class

Relational storage remains a serious candidate for operational source-of-truth workloads, transactional integrity, policy enforcement and portability. Graph/ontology semantics may be represented above relational storage through adapters if NEXUS workloads justify it.

## Decision dimensions

Every candidate must be scored with evidence across:

- object lookup latency;
- 1-hop, 3-hop and bounded multi-hop traversal latency;
- write transaction latency;
- mixed read/write throughput;
- schema migration safety;
- temporal-history support;
- contextual authorization integration;
- event/subscription integration;
- full-text/indexed search integration;
- SDK quality for TypeScript and Rust boundaries;
- backup/recovery and operability;
- horizontal scaling path;
- hosted/self-hosted deployment options;
- license and vendor-lock-in risk;
- replacement difficulty;
- cost under representative NEXUS workloads.

## Required NEXUS benchmark workloads

1. Operational graph: Customer -> Orders -> Products -> Suppliers with authorization filters.
2. Asset graph: Facility -> Equipment -> Sensor -> Incident -> MaintenanceAction.
3. Creative graph: Brand -> Experience -> Component -> Interaction -> Asset -> Evidence.
4. Mixed graph: Order/Product/Brand -> Campaign -> Experience -> BenchmarkRun -> EvidenceBundle.
5. Action transaction: validate policy, update multiple objects, append audit event atomically.
6. Temporal query: reconstruct object state and relationships at a historical point.
7. Subscription workload: publish object/action changes to authorized subscribers.
8. Schema evolution: additive and breaking type/property/relationship migrations.

## Architecture decision rule

The Ontology Kernel owns semantic contracts. Persistence engines implement ports. No persistence candidate is allowed to redefine NEXUS public object, relationship, action, function, event or authorization contracts.

A technology becomes a default backend only after benchmark artifacts are committed or stored as V10 evidence and the decision record includes measured strengths, measured weaknesses and a replacement strategy.

## Initial conclusion

V10 starts deliberately without selecting an ontology database. The first implementation target is the NEXUS Ontology Kernel and an in-memory conformance adapter. External persistence candidates are evaluated only after kernel behavior and representative workloads exist.