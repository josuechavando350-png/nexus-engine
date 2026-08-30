# NEXUS Chatbot Contextual Bandits

Capability 4 of the NEXUS chatbot intelligence stack.

## Purpose

This capability lets a chatbot learn which **already-approved response strategy** performs better for a bounded context. It is an optimizer, not an author. It cannot invent prices, guarantees, discounts, claims, policies or arbitrary customer-facing text.

The production path is:

`Knowledge Graph + Long-Term Memory -> Formal Guardrails -> eligible guarded plans -> Contextual Bandit -> selected guarded plan -> render -> verifyOutbound -> transport`

## Contextual learning model

The engine uses deterministic contextual UCB selection over exact, policy-approved context buckets. A context is reduced to a bounded set of allow-listed categorical/numeric/boolean features such as intent, channel, journey stage, locale and returning-customer status.

Raw context values are not persisted in bandit state or decision records. Persistence stores deterministic context digests/keys, arm identity, exposure counts and bounded reward aggregates.

The default policy:

- allows at most 16 registered arms;
- allows at most 8 context features;
- requires 3 exposures per eligible arm/context before normal UCB exploitation;
- uses exploration weight 1.25;
- accepts rewards only inside a 30-day attribution window;
- permits only explicitly allow-listed context keys.

Deployments may tighten or replace this policy. Policy configuration itself is digest-bound.

## Arms and output safety

An arm is a registered `GuardrailResponsePlan`. It contains only the capability-2 segment types:

- approved `FACT` + template IDs;
- approved `COPY` IDs.

There is no free-text bandit arm. The bandit selects only among arm IDs registered when the engine is constructed and among the subset explicitly declared eligible for the current grounded turn.

`BanditAwareGuardrailCoordinator` refuses to optimize an `ESCALATE` / escalation-required turn. A selected response must be rendered through the existing memory-aware formal guardrail coordinator and must pass `verifyOutbound()` immediately before transport.

The coordinator also binds an exact rendered response object to the exact selected decision using weak-reference issuance tracking. A caller cannot render one arm and claim it came from another bandit decision.

## Exposure accounting

Selection returns two things:

1. a frozen decision describing the selected arm;
2. an `exposurePlan` requiring `chatbot.bandit.write`.

The exposure plan atomically creates the decision record and increments the selected arm/context exposure count using optimistic revisions. Durable callers must execute the plan through the existing NEXUS authorization -> transaction -> audit boundary.

A caller-provided `interactionId` makes selection idempotent. Reusing the same interaction with a changed context, guardrail context or policy fails closed.

For privacy, interaction IDs should be opaque application identifiers rather than emails, phone numbers or raw customer data.

## Rewards

`planReward()` accepts a finite reward from 0 to 1 and an explicit canonical UTC outcome timestamp. Typical deployments can use:

- `1` for a verified conversion / booked consultation / completed purchase;
- `0` for a verified non-conversion;
- fractional rewards only when the deployment has a documented outcome model.

A reward:

- must refer to an existing persisted exposure;
- cannot predate the decision;
- cannot be future-dated;
- must fall inside the configured attribution window;
- is idempotent when retried with the exact same value and timestamp;
- conflicts if the same decision is later assigned a different outcome.

The reward update and decision finalization are emitted in the same mutation plan so production execution can be transactional.

## Determinism and concurrency

Cold-start exploration is deterministic: under-sampled arms are selected by exposure deficit and then stable arm ID tie-breaking. After the exploration floor, UCB uses persisted mean reward and a deterministic exploration bonus.

Bandit state mutations carry `expectedRevision`. Concurrent writers racing on the same arm/context must resolve the optimistic conflict by reading fresh state and replanning; silently overwriting another learner is outside the supported invariant.

## Integrity / poisoning controls

Persisted decision and state records carry deterministic record digests. Projection validates identities, aggregates, timestamps, decision status and digests before a record can influence selection or reward processing.

The learner never treats memory as commercial truth and never bypasses capabilities 1-3. Reward only changes future arm preference; it does not create a new fact, new copy, new template or new response segment.

## Non-claims

This is not autonomous causal inference. A higher observed reward can reflect selection effects, measurement errors or omitted context. Contextual bandits optimize the supplied reward signal under the configured policy; they do not prove that a strategy caused a sale.

This module also does not prove consent, privacy-law compliance, fraud-free conversion events or correct analytics instrumentation. Those belong to production adapters and deployment governance.

Capability 4 is complete only after repository CI is green, adversarial audit passes and the PR is merged to `main`. The complete five-capability chatbot stack remains incomplete until capability 5 and the final production integration gate are finished.
