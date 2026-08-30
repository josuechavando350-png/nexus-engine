import { describe, expect, it } from "vitest";

import type { OntologyScope } from "./index.js";
import { hash } from "./chatbot-knowledge-types.js";
import type { GuardrailResponsePlan, RenderedGuardrailResponse } from "./chatbot-guardrails-types.js";
import type { MemoryAwareGuardrailCoordinator, PreparedMemoryAwareGuardrailContext } from "./chatbot-memory-guardrail.js";
import { InMemoryOntologyPersistence } from "./persistence-query.js";
import { ContextualBanditEngine } from "./chatbot-bandit-engine.js";
import { createDefaultContextualBanditPolicy } from "./chatbot-bandit-policy.js";
import { BanditAwareGuardrailCoordinator } from "./chatbot-bandit-guardrail.js";
import { BoundedMultiAgentReasoningEngine } from "./chatbot-reasoning-engine.js";
import { createDefaultReasoningPolicy, finalizeReasoningPolicy } from "./chatbot-reasoning-policy.js";
import { DeliberativeBanditCoordinator } from "./chatbot-reasoning-coordinator.js";
import type { ReasoningAgentInput, ReasoningAgentPort, ReasoningEvidenceSnapshot } from "./chatbot-reasoning-types.js";

const SCOPE: OntologyScope = { tenantId: "tenant:reasoning", organizationId: "org:reasoning", brandId: "brand:reasoning" };
const NOW_MS = Date.parse("2026-08-30T04:00:00.000Z");

const ARMS = [
  { armId: "close-a", plan: { planId: "plan:close-a", segments: [{ kind: "COPY" as const, copyId: "es.offer-help" }] } },
  { armId: "close-b", plan: { planId: "plan:close-b", segments: [{ kind: "COPY" as const, copyId: "es.offer-help" }] } },
] as const;

function evidence(overrides: Partial<ReasoningEvidenceSnapshot> = {}): ReasoningEvidenceSnapshot {
  return {
    userMessage: "quiero cotizar",
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
    ...overrides,
  };
}

function prepared(disposition: "ALLOW" | "QUALIFY" | "ESCALATE" = "ALLOW"): PreparedMemoryAwareGuardrailContext {
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
        createdAt: "2026-08-30T04:00:00.000Z",
        digest: "envelope_digest",
      },
      digest: "guarded_digest",
    },
    memory: {
      status: "EMPTY",
      authority: "PERSONALIZATION_ONLY",
      subjectId: "customer:reasoning",
      recalledAt: "2026-08-30T04:00:00.000Z",
      policyDigest: "memory_policy_digest",
      scopeDigest: hash("ltmscope", SCOPE),
      items: [],
      instructions: [],
      digest: "memory_digest",
    },
    businessEntityId: "business:reasoning",
    customerEntityId: "customer:reasoning",
    userMessageDigest: "message_digest",
    scopeDigest: hash("ltmscope", SCOPE),
    digest: `base_${disposition.toLowerCase()}`,
  };
}

function fakeBase(disposition: "ALLOW" | "QUALIFY" | "ESCALATE" = "ALLOW"): MemoryAwareGuardrailCoordinator {
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
      renderedAt: "2026-08-30T04:00:00.000Z",
      digest: `response_${plan.planId}`,
    }),
    verifyOutbound: () => undefined,
  } as unknown as MemoryAwareGuardrailCoordinator;
}

function bandit(scope: OntologyScope = SCOPE): ContextualBanditEngine {
  return new ContextualBanditEngine(
    new InMemoryOntologyPersistence(),
    scope,
    createDefaultContextualBanditPolicy(),
    ARMS,
    () => NOW_MS,
  );
}

class ConditionalAgent implements ReasoningAgentPort {
  constructor(
    readonly agentId: string,
    readonly role: "PLANNER" | "CRITIC" | "VERIFIER",
    private readonly rejectArm?: string,
  ) {}

  assess(input: ReasoningAgentInput) {
    const reject = input.candidateArmId === this.rejectArm;
    return {
      agentId: this.agentId,
      role: this.role,
      candidateArmId: input.candidateArmId,
      verdict: reject ? "REJECT" as const : "ACCEPT" as const,
      confidence: 1,
      issueCodes: reject ? ["INTENT_MISMATCH" as const] : ["NONE" as const],
    };
  }
}

describe("chatbot deliberative reasoning", () => {
  it("accepts a guarded copy plan through the default specialist quorum", async () => {
    const engine = new BoundedMultiAgentReasoningEngine(SCOPE, createDefaultReasoningPolicy());
    const result = await engine.evaluate({
      reasoningId: "reasoning:default",
      interactionId: "interaction:default",
      attempt: 1,
      candidateArmId: "close-a",
      candidatePlan: ARMS[0].plan,
      remainingArmIds: ["close-a", "close-b"],
      evidence: evidence(),
    });
    expect(result.accepted).toBe(true);
    expect(result.attempt.acceptVotes).toBeGreaterThanOrEqual(2);
    expect(result.attempt.rejectVotes).toBe(0);
  });

  it("rejects a plan that references a fact not allowed by formal guardrails", async () => {
    const engine = new BoundedMultiAgentReasoningEngine(SCOPE, createDefaultReasoningPolicy());
    const result = await engine.evaluate({
      reasoningId: "reasoning:fact",
      interactionId: "interaction:fact",
      attempt: 1,
      candidateArmId: "fact-arm",
      candidatePlan: { planId: "plan:fact", segments: [{ kind: "FACT", factId: "fact:forged", templateId: "template:general" }] },
      remainingArmIds: ["fact-arm"],
      evidence: evidence(),
    });
    expect(result.accepted).toBe(false);
    expect(result.attempt.issueCodes).toContain("FACT_NOT_ALLOWED");
  });

  it("self-heals by pruning a rejected arm and replanning to a verified arm", async () => {
    const agents: ReasoningAgentPort[] = [
      new ConditionalAgent("agent:planner", "PLANNER", "close-a"),
      new ConditionalAgent("agent:critic", "CRITIC"),
      new ConditionalAgent("agent:verifier", "VERIFIER"),
    ];
    const reasoning = new BoundedMultiAgentReasoningEngine(SCOPE, createDefaultReasoningPolicy(), [], agents);
    const guardedBandit = new BanditAwareGuardrailCoordinator(fakeBase(), bandit());
    const coordinator = new DeliberativeBanditCoordinator(guardedBandit, reasoning, () => NOW_MS);
    const context = await coordinator.prepare({
      reasoningId: "reasoning:repair",
      businessEntityId: "business:reasoning",
      customerEntityId: "customer:reasoning",
      userMessage: "quiero cotizar",
      banditId: "sales-close",
      interactionId: "interaction:repair",
      banditContext: { intent: "quote" },
      eligibleArmIds: ["close-a", "close-b"],
    });
    expect(context.deliberation.status).toBe("REPAIRED");
    expect(context.deliberation.rejectedArmIds).toEqual(["close-a"]);
    expect(context.deliberation.selectedArmId).toBe("close-b");
    const response = coordinator.renderSelected(context);
    expect(response.planId).toBe("plan:close-b");
    expect(() => coordinator.verifyOutbound(response, context)).not.toThrow();
  });

  it("fails closed when every candidate is rejected", async () => {
    const agents: ReasoningAgentPort[] = [
      new ConditionalAgent("agent:planner", "PLANNER", "close-a"),
      new ConditionalAgent("agent:critic", "CRITIC", "close-b"),
      new ConditionalAgent("agent:verifier", "VERIFIER", "close-a"),
    ];
    const defaults = createDefaultReasoningPolicy();
    const policy = finalizeReasoningPolicy({
      policyId: defaults.policyId,
      version: defaults.version,
      maxInputChars: defaults.maxInputChars,
      maxRepairAttempts: 3,
      minAcceptVotes: defaults.minAcceptVotes,
      minMeanConfidence: defaults.minMeanConfidence,
      maxAgentFailures: defaults.maxAgentFailures,
      maxIntentTagsPerCandidate: defaults.maxIntentTagsPerCandidate,
      maxIntentTagChars: defaults.maxIntentTagChars,
    });
    const reasoning = new BoundedMultiAgentReasoningEngine(SCOPE, policy, [], agents);
    const coordinator = new DeliberativeBanditCoordinator(new BanditAwareGuardrailCoordinator(fakeBase(), bandit()), reasoning, () => NOW_MS);
    await expect(coordinator.prepare({
      reasoningId: "reasoning:none",
      businessEntityId: "business:reasoning",
      customerEntityId: "customer:reasoning",
      userMessage: "quiero cotizar",
      banditId: "sales-close",
      interactionId: "interaction:none",
      banditContext: { intent: "quote" },
      eligibleArmIds: ["close-a", "close-b"],
    })).rejects.toThrow(/without a verified response plan/i);
  });

  it("binds outbound responses to the exact issued deliberation", async () => {
    const reasoning = new BoundedMultiAgentReasoningEngine(SCOPE, createDefaultReasoningPolicy());
    const coordinator = new DeliberativeBanditCoordinator(new BanditAwareGuardrailCoordinator(fakeBase(), bandit()), reasoning, () => NOW_MS);
    const context = await coordinator.prepare({
      reasoningId: "reasoning:binding",
      businessEntityId: "business:reasoning",
      customerEntityId: "customer:reasoning",
      userMessage: "quiero cotizar",
      banditId: "sales-close",
      interactionId: "interaction:binding",
      banditContext: { intent: "quote" },
      eligibleArmIds: ["close-a", "close-b"],
    });
    const response = coordinator.renderSelected(context);
    expect(() => coordinator.verifyOutbound(response, { ...context })).toThrow(/not issued by this coordinator/i);
    const forged: RenderedGuardrailResponse = { ...response, planId: "plan:close-b" };
    expect(() => coordinator.verifyOutbound(forged, context)).toThrow(/not rendered from this exact deliberation/i);
  });
});
