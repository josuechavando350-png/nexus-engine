# NEXUS Chatbot Deliberative Reasoning

Capability 5 of the NEXUS chatbot intelligence stack.

## Purpose

This module adds bounded deliberation, self-healing candidate search and specialized multi-agent verification on top of capabilities 1–4.

The production path is:

`Knowledge Graph -> Formal Guardrails -> Long-Term Memory -> Contextual Bandit -> Deliberative Multi-Agent Verification -> guarded render -> verifyOutbound -> transport`

The module does **not** expose or persist hidden chain-of-thought. The "tree-of-thought" idea is implemented as a bounded search tree over already-registered response-plan arms. Every branch is represented only by an arm ID, plan ID, structured verdicts, confidence values, issue codes and deterministic digests.

## Specialized agents

The default reasoning engine ships with three deterministic specialists:

- `PLANNER`: compares optional candidate intent tags to the current user message and contributes a bounded intent-fit verdict.
- `CRITIC`: rejects plans that reference facts outside the formal-guardrail envelope, empty plans, malformed segment shapes or escalation-required states.
- `VERIFIER`: re-checks the personalization-only memory authority boundary and basic guarded-plan invariants.

Additional agents can implement `ReasoningAgentPort`. That port intentionally accepts and returns structured data. Provider-specific adapters for models such as ChatGPT or Claude may implement it later without gaining permission to author customer-facing text or execute NEXUS actions directly.

## Self-healing search

`DeliberativeBanditCoordinator` asks capability 4 for a selected registered arm, then submits that exact plan to the specialist quorum.

If any specialist rejects the candidate or quorum/confidence requirements are not met:

1. the rejected arm is removed from the remaining candidate set;
2. the bandit is asked to re-plan among the remaining approved arms;
3. the new candidate is verified again;
4. search stops when a verified candidate is found or the repair budget is exhausted.

No rejected candidate exposure plan is returned to the caller. The final accepted capability-4 exposure plan is the only one available for durable execution.

The default reasoning policy allows three repair attempts after the initial branch, requires at least two acceptance votes, requires mean confidence of at least 0.6, permits at most one agent failure per branch and caps reasoning input at 4,000 characters.

## Fail-closed boundaries

The reasoning layer cannot:

- run around an `ESCALATE` decision from formal guardrails;
- introduce a new FACT, COPY, template or arbitrary free-text segment;
- promote long-term memory from `PERSONALIZATION_ONLY` to business truth;
- select an arm outside the capability-4 eligible set;
- accept forged agent identity, role, candidate identity, verdict, confidence or issue codes;
- return a response that was rendered under another deliberation;
- wire reasoning and bandit engines across ontology scopes.

If the agent failure budget is exceeded or the bounded search cannot find a verified candidate, the module fails closed with a typed `ChatbotReasoningError`.

## Chain-of-thought boundary

Agent adapters may internally use whatever private reasoning mechanism their provider supports, but NEXUS does not request, store, trust or render hidden reasoning transcripts. Returned assessments are reduced to:

- `agentId`
- `role`
- `candidateArmId`
- `verdict`
- `confidence`
- bounded `issueCodes`
- deterministic digest

Unexpected fields such as arbitrary rationale or chain-of-thought text are discarded before the verified assessment enters the deliberation record.

## Integrity and lineage

Every verified assessment, branch attempt, final deliberation and combined deliberative context carries a deterministic digest. Weak-reference issuance tracking binds the exact in-memory final context and response object to the coordinator that created them. A copied or forged context cannot be used to render or verify outbound text.

Capability 4 now exposes its scope digest so capability 5 can verify exact ontology-scope binding before any deliberation occurs.

## Non-claims

This is bounded plan search and verification, not a proof of general intelligence. It does not prove that a model's private reasoning is correct, that a conversion strategy caused a sale, or that an external provider is available. It improves the response-selection path by requiring multiple structured checks and bounded repair before a guarded plan reaches rendering.

This module is complete only when repository CI is green, the adversarial audit passes and the PR is merged to `main`. A later whole-engine audit still needs to verify real chatbot/runtime consumers, transport wiring and provider adapters in production rather than inferring deployment from package code alone.
