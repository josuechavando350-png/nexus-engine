# NEXUS Chatbot Formal Guardrails

Capability 2 of the NEXUS chatbot intelligence stack.

## Purpose

This layer sits immediately after `KnowledgeGraphReader.grounding()` and before any customer-facing response leaves the chatbot runtime.

It is intentionally not a prompt such as “do not hallucinate”. The language model is not the authority that decides whether a commercial claim may be emitted.

The guardrail engine applies deterministic policy to the evidence-grounded facts produced by capability 1 and only renders output from:

- fact IDs explicitly allowed by the guardrail policy; and
- pre-approved static copy IDs.

There is no arbitrary free-text response segment in the outbound contract.

## Fail-closed path

`KnowledgeGraphReader -> FormalGuardrailEngine.prepare -> model chooses approved fact/copy IDs -> FormalGuardrailEngine.render -> verifyOutbound -> transport`

If any link is missing, tampered, stale, conflicting, unsupported or not issued by the same guardrail engine instance, the response does not pass verification.

## Formal controls

Each claim class has policy for:

- risk level;
- minimum confidence;
- minimum evidence count;
- allowed evidence kinds;
- required stronger evidence kinds;
- whether partial support may be qualified;
- whether evidence requires a source digest; and
- maximum evidence age.

Default risk classes:

- LOW: general facts
- MEDIUM: availability, contact, schedules
- HIGH: price, policy, promotions
- CRITICAL: guarantees, credentials, legal claims

High and critical claims require stronger provenance and a source digest. Critical guarantees and legal claims require operator-approved evidence by default.

## Sensitive-intent defense

The guardrail layer independently recognizes sensitive customer intents such as price, promotion, guarantee, credential, legal, contact, schedule and availability questions.

If the user asks for a sensitive class and no allowed fact of that class exists, the engine requires escalation even if unrelated lower-risk facts are available. This prevents answering around a missing price or credential with some other true but irrelevant fact.

## Approved rendering

The model never supplies final customer-facing prose directly.

A response plan may contain only:

- `FACT`: an allowed fact ID plus an approved template ID
- `COPY`: a pre-approved copy ID

Partially supported facts must use a qualified template. Unsupported or conflicted grounding suppresses factual output completely and requires approved escalation copy.

If a requested sensitive class is omitted from the response, an escalation segment is mandatory.

## Freshness and time

The engine owns its clock. The caller cannot provide a fake current time to make stale evidence look fresh.

The default customer-facing policy disables historical grounding. Historical facts cannot be selected by passing an arbitrary `at` timestamp unless a custom policy explicitly enables that behavior.

Evidence dated in the future is rejected.

## Lineage and tamper resistance

Policies, facts, evidence, grounding contexts, decisions, guardrail envelopes and rendered responses carry deterministic SHA-256 digests.

In addition, prepared contexts and rendered responses must be the exact objects issued by the same `FormalGuardrailEngine` instance. A caller cannot construct a new object with a recomputed digest and have it accepted as an issued outbound response.

`verifyOutbound()` is the final mandatory check immediately before transport.

## Important truth about “never lies”

No generative system can prove that every source fact supplied by a business is objectively true. These guardrails enforce a narrower and machine-verifiable guarantee: the chatbot cannot emit an unapproved commercial fact through this response path, and unsupported/conflicted/high-risk claims fail closed or escalate.

That guarantee only holds when the production transport accepts responses exclusively after `verifyOutbound()` succeeds. Capability 5 and the final chatbot integration gate must preserve this invariant.

## Audit requirements

Before merge this capability must pass:

- lint
- TypeScript typecheck
- unit/integration tests
- hermetic build
- full NEXUS validation
- adversarial tests for unsupported claims, stale/future evidence, wrong templates, raw free text, historical lookup, missing requested classes and outbound tampering

Source code alone is not LIVE status.
