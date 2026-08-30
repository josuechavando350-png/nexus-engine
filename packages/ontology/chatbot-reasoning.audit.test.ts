import { describe, expect, it } from "vitest";

import type { OntologyScope } from "./index.js";
import { hash } from "./chatbot-knowledge-types.js";
import type { GuardrailResponsePlan } from "./chatbot-guardrails-types.js";
import type { MemoryAwareGuardrailCoordinator, PreparedMemoryAwareGuardrailContext } from "./chatbot-memory-guardrail.js";
import { InMemoryOntologyPersistence } from "./persistence-query.js";
import { ContextualBanditEngine } from "./chatbot-bandit-engine.js";
import { createDefaultContextualBanditPolicy } from "./chatbot-bandit-policy.js";
import { BanditAwareGuardrailCoordinator } from "./chatbot-bandit-guardrail.js";
import { BoundedMultiAgentReasoningEngine } from "./chatbot-reasoning-engine.js";
import { createDefaultReasoningPolicy, finalizeReasoningPolicy } from "./chatbot-reasoning-policy.js";
import { DeliberativeBanditCoordinator } from "./chatbot-reasoning-coordinator.js";
import type { ReasoningAgentInput, ReasoningAgentPort, ReasoningEvidenceSnapshot } from "./chatbot-reasoning-types.js";

const SCOPE: OntologyScope = { tenantId: "tenant:audit5", organizationId: "org:audit5", brandId: "brand:audit5" };
const NOW_MS = Date.parse("2026-08-30T05:00:00.000Z");
const ARMS = [
  { armId: "safe-a", plan: { planId: "plan:safe-a", segments: [{ kind: "COPY" as const, copyId: "es.offer-help" }] } },
  { armId: "safe-b", plan: { planId: "plan:safe-b", segments: [{ kind: "COPY" as const, copyId: "es.offer-help" }] } },
] as const;

function snapshot(): ReasoningEvidenceSnapshot {
  return {
    userMessage: "quiero ayuda",
    userMessageDigest: "message_digest",
    guardedContextDigest: "guarded_digest",
    groundingStatus: "SUPPORTED",
    disposition: "ALLOW",
    allowedFactIds: [],
    qualifiedFactIds: [],
    requestedClaimClasses: [],
    memoryStatus: "EMPTY",
    memoryCategories: [],
    memoryAuthority: "PERSONALIZATION_ONLY",
  };
}

function prepared(disposition: "ALLOW" | "ESCALATE" = "ALLOW"): PreparedMemoryAwareGuardrailContext {
  return {
    guardrails: {
      grounding: { status: "SUPPORTED", facts: [], evidence: [], conflicts: [], matchedEntityIds: [], instructions: [], digest: "grounding_digest" },
      envelope: {
        policyId: "policy",
        policyVersion: "1",
        policyDigest: "policy_digest",
        groundingDigest: "grounding_digest",
        requestDigest: "request_digest",
        requestedClaimClasses: [],
        groundingStatus: "SUPPORTED",
        disposition,
        allowedFactIds: [],
        qualifiedFactIds: [],
        rejectedFacts: [],
        facts: [],
        requiredEscalation: disposition === "ESCALATE",
        suppressFacts: disposition === "ESCALATE",
        createdAt: "2026-08-30T05:00:00.000Z",
        digest: "envelope_digest",
      },
      digest: "guarded_digest",
    },
    memory: {
      status: "EMPTY",
      authority: "PERSONALIZATION_ONLY",
      subjectId: "customer:audit5",
      recalledAt: "2026-08-30T05:00:00.000Z",
      policyDigest: "memory_policy_digest",
      scopeDigest: hash("ltmscope", SCOPE),
      items: [],
      instructions: [],
      digest: "memory_digest",
    },
    businessEntityId: "business:audit5",
    customerEntityId: "customer:audit5",
    userMessageDigest: "message_digest",
    scopeDigest: hash("ltmscope", SCOPE),
    digest: `base_${disposition.toLowerCase()}`,
  };
}

function fakeBase(disposition: "ALLOW" | "ESCALATE" = "ALLOW"): MemoryAwareGuardrailCoordinator {
  const exact = prepared(disposition);
  return {
    scopeDigest: hash("ltmscope", SCOPE),
    prepare: async () => exact,
    render: (plan: GuardrailResponsePlan) => ({
      planId: plan.planId,
      policyDigest: "policy_digest",
      groundingDigest: "grounding_digest",
      envelopeDigest: "envelope_digest",
      text: `approved:${plan.planId}`,
      usedFactIds: [],
      usedCopyIds: ["es.offer-help"],
      renderedAt: "2026-08-30T05:00:00.000Z",
      digest: `response_${plan.planId}`,
    }),
    verifyOutbound: () => undefined,
  } as unknown as MemoryAwareGuardrailCoordinator;
}

function bandit(scope: OntologyScope = SCOPE): ContextualBanditEngine {
  return new ContextualBanditEngine(new InMemoryOntologyPersistence(), scope, createDefaultContextualBanditPolicy(), ARMS, () => NOW_MS);
}

class BadOutputAgent implements ReasoningAgentPort {
  constructor(readonly agentId: string, readonly role: "PLANNER" | "CRITIC" | "VERIFIER") {}
  assess(input: ReasoningAgentInput) {
    return {
      agentId: this.agentId,
      role: this.role,
      candidateArmId: `${input.candidateArmId}-forged`,
      verdict: "ACCEPT" as const,
      confidence: 1,
      issueCodes: ["NONE" as const],
      rationale: "hidden chain of thought should never be carried forward",
    };
  }
}

class SafeAgent implements ReasoningAgentPort {
  constructor(readonly agentId: string, readonly role: "PLANNER" | "CRITIC" | "VERIFIER") {}
  assess(input: ReasoningAgentInput) {
    return { agentId: this.agentId, role: this.role, candidateArmId: input.candidateArmId, verdict: "ACCEPT" as const, confidence: 1, issueCodes: ["NONE" as const] };
  }
}

describe("chatbot reasoning adversarial audit", () => {
  it("fails closed when invalid agent outputs exceed the configured failure budget", async () => {
    const base = createDefaultReasoningPolicy();
    const policy = finalizeReasoningPolicy({
      policyId: base.policyId,
      version: base.version,
      maxInputChars: base.maxInputChars,
      maxRepairAttempts: base.maxRepairAttempts,
      minAcceptVotes: 1,
      minMeanConfidence: base.minMeanConfidence,
      maxAgentFailures: 0,
      maxIntentTagsPerCandidate: base.maxIntentTagsPerCandidate,
      maxIntentTagChars: base.maxIntentTagChars,
    });
    const engine = new BoundedMultiAgentReasoningEngine(SCOPE, policy, [], [new BadOutputAgent("bad:planner", "PLANNER")]);
    await expect(engine.evaluate({
      reasoningId: "audit:bad-output",
      interactionId: "audit:interaction",
      attempt: 1,
      candidateArmId: "safe-a",
      candidatePlan: ARMS[0].plan,
      remainingArmIds: ["safe-a"],
      evidence: snapshot(),
    })).rejects.toThrow(/failure budget exceeded/i);
  });

  it("does not preserve arbitrary rationale or chain-of-thought fields from agents", async () => {
    const base = createDefaultReasoningPolicy();
    const policy = finalizeReasoningPolicy({
      policyId: base.policyId,
      version: base.version,
      maxInputChars: base.maxInputChars,
      maxRepairAttempts: base.maxRepairAttempts,
      minAcceptVotes: 1,
      minMeanConfidence: 0,
      maxAgentFailures: 1,
      maxIntentTagsPerCandidate: base.maxIntentTagsPerCandidate,
      maxIntentTagChars: base.maxIntentTagChars,
    });
    const forged = new BadOutputAgent("bad:planner", "PLANNER");
    const engine = new BoundedMultiAgentReasoningEngine(SCOPE, policy, [], [forged, new SafeAgent("safe:critic", "CRITIC")]);
    const result = await engine.evaluate({
      reasoningId: "audit:no-cot",
      interactionId: "audit:no-cot-interaction",
      attempt: 1,
      candidateArmId: "safe-a",
      candidatePlan: ARMS[0].plan,
      remainingArmIds: ["safe-a"],
      evidence: snapshot(),
    });
    expect(JSON.stringify(result)).not.toContain("hidden chain of thought");
    expect(JSON.stringify(result)).not.toContain("rationale");
  });

  it("rejects cross-scope reasoning and bandit wiring", () => {
    const other: OntologyScope = { tenantId: "tenant:other5", organizationId: "org:other5" };
    const guarded = new BanditAwareGuardrailCoordinator(fakeBase(), bandit());
    const reasoning = new BoundedMultiAgentReasoningEngine(other, createDefaultReasoningPolicy());
    expect(() => new DeliberativeBanditCoordinator(guarded, reasoning)).toThrow(/same ontology scope/i);
  });

  it("cannot reason around an escalation-required guarded turn", async () => {
    const guarded = new BanditAwareGuardrailCoordinator(fakeBase("ESCALATE"), bandit());
    const reasoning = new BoundedMultiAgentReasoningEngine(SCOPE, createDefaultReasoningPolicy());
    const coordinator = new DeliberativeBanditCoordinator(guarded, reasoning, () => NOW_MS);
    await expect(coordinator.prepare({
      reasoningId: "audit:escalation",
      businessEntityId: "business:audit5",
      customerEntityId: "customer:audit5",
      userMessage: "garantizame un resultado no soportado",
      banditId: "sales-close",
      interactionId: "audit:escalation-interaction",
      banditContext: { intent: "quote" },
      eligibleArmIds: ["safe-a", "safe-b"],
    })).rejects.toThrow(/disabled on escalation/i);
  });

  it("enforces the reasoning input budget before invoking the candidate search", async () => {
    const base = createDefaultReasoningPolicy();
    const policy = finalizeReasoningPolicy({
      policyId: base.policyId,
      version: base.version,
      maxInputChars: 8,
      maxRepairAttempts: base.maxRepairAttempts,
      minAcceptVotes: base.minAcceptVotes,
      minMeanConfidence: base.minMeanConfidence,
      maxAgentFailures: base.maxAgentFailures,
      maxIntentTagsPerCandidate: base.maxIntentTagsPerCandidate,
      maxIntentTagChars: base.maxIntentTagChars,
    });
    const coordinator = new DeliberativeBanditCoordinator(
      new BanditAwareGuardrailCoordinator(fakeBase(), bandit()),
      new BoundedMultiAgentReasoningEngine(SCOPE, policy),
      () => NOW_MS,
    );
    await expect(coordinator.prepare({
      reasoningId: "audit:budget",
      businessEntityId: "business:audit5",
      customerEntityId: "customer:audit5",
      userMessage: "este mensaje excede",
      banditId: "sales-close",
      interactionId: "audit:budget-interaction",
      banditContext: { intent: "quote" },
      eligibleArmIds: ["safe-a"],
    })).rejects.toThrow(/exceeds reasoning input budget/i);
  });
});
