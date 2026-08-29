# NEXUS Chatbot Knowledge Graph

Capability 1 of the NEXUS chatbot intelligence stack.

## Purpose

This module gives sales and customer-service chatbots an evidence-grounded semantic source of truth. It is built directly on the existing `@nexus/ontology` kernel; it does not introduce a second graph database, an LLM-owned memory store, or a parallel mutation authority.

Public import:

```ts
import {
  KnowledgeGraphPlanner,
  KnowledgeGraphReader,
  chatbotKnowledgeSchema,
} from "@nexus/ontology/chatbot-knowledge";
```

## What is represented

The schema adds three ontology object types:

- `chatbot.knowledge_entity`
- `chatbot.knowledge_evidence`
- `chatbot.knowledge_fact`

Facts are connected with native ontology relationships:

- `chatbot.fact_subject`
- `chatbot.fact_object`
- `chatbot.fact_evidence`

The graph therefore preserves both machine-readable fact payloads and graph-native edges.

## Grounding states

`KnowledgeGraphReader.grounding()` returns exactly one state:

- `SUPPORTED`
- `PARTIALLY_SUPPORTED`
- `UNSUPPORTED`
- `CONFLICTED`

`UNSUPPORTED` never falls back to unrelated facts. `CONFLICTED` never silently selects a winner.

## Commercial claim classes

Facts can be marked as:

- `GENERAL`
- `PRICE`
- `AVAILABILITY`
- `POLICY`
- `GUARANTEE`
- `CREDENTIAL`
- `LEGAL`
- `CONTACT`
- `SCHEDULE`
- `PROMOTION`

This is intentionally exposed so capability 2 (formal guardrails) can enforce stricter rules for high-risk commercial claims.

## Provenance and temporal truth

Every fact requires at least one existing evidence object. Evidence is immutable: changing its source, digest, excerpt, observation time or metadata requires a new evidence record.

Facts support `validFrom` / `validUntil`. Two different active values for the same subject + predicate are rejected when their validity windows overlap. Historical values are allowed when windows do not overlap.

Every entity, evidence record, fact, mutation plan, query and grounding context carries a deterministic SHA-256 digest. Read paths recompute record digests and fail closed on tampering.

Grounded reads also verify that the fact's native ontology relationships exactly match the fact payload. A missing or malformed subject/object/evidence edge is an integrity failure, not a partial success.

## Mutation boundary

`KnowledgeGraphPlanner` produces deterministic `TransactionOperation[]` plans and declares the permission `chatbot.knowledge.write`. It does **not** execute mutations itself.

That separation is deliberate. NEXUS already defines the authoritative state-changing boundary as authorization -> transaction -> audit. Chatbot/LLM code must not bypass it. Production ingestion must execute approved plans through the existing privileged ontology mutation path.

The chatbot response path is read-only: it consumes `KnowledgeGraphReader.grounding()`.

## Example

```ts
const planner = new KnowledgeGraphPlanner(ontologyReadPort, scope);
const reader = new KnowledgeGraphReader(ontologyReadPort, scope);

const evidencePlan = planner.planEvidenceAdd({
  id: "evidence:pricing-v1",
  kind: "FIRST_PARTY",
  source: "client-approved-pricing",
  sourceDigest: "sha256:...",
  observedAt: "2026-08-29T12:00:00.000Z",
});

// Execute evidencePlan through the authorized NEXUS mutation boundary.

const factPlan = await planner.planFactUpsert({
  id: "fact:chatbot-price",
  subjectId: "service:chatbot",
  predicate: "base-price-mxn",
  object: { kind: "LITERAL", value: 3500 },
  evidenceIds: ["evidence:pricing-v1"],
  claimClass: "PRICE",
  observedAt: "2026-08-29T12:00:00.000Z",
});

// Execute factPlan through the authorized NEXUS mutation boundary.

const grounding = await reader.grounding({
  businessEntityId: "business:client",
  userMessage: "¿Cuánto cuesta el chatbot?",
});

if (grounding.status === "UNSUPPORTED" || grounding.status === "CONFLICTED") {
  // Do not guess; ask for clarification or escalate.
}
```

## Release truth

This capability is not considered LIVE solely because the source code exists. It must pass the repository typecheck/tests/build and then be consumed by the final chatbot runtime. The complete NEXUS chatbot product must not be declared complete until all five requested capabilities are wired into the same runtime and the integration gate proves that none is missing.
