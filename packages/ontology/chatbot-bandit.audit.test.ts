import { describe, expect, it } from "vitest";

import type { OntologyScope } from "./index.js";
import { hash } from "./chatbot-knowledge-types.js";
import type { GuardrailResponsePlan, RenderedGuardrailResponse } from "./chatbot-guardrails-types.js";
import type { MemoryAwareGuardrailCoordinator, PreparedMemoryAwareGuardrailContext } from "./chatbot-memory-guardrail.js";
import { InMemoryOntologyPersistence } from "./persistence-query.js";
import { BanditAwareGuardrailCoordinator } from "./chatbot-bandit-guardrail.js";
import { ContextualBanditEngine } from "./chatbot-bandit-engine.js";
import { createDefaultContextualBanditPolicy } from "./chatbot-bandit-policy.js";

const SCOPE: OntologyScope = { tenantId: "tenant:audit", organizationId: "org:audit", brandId: "brand:audit" };
const NOW_MS = Date.parse("2026-08-30T03:00:00.000Z");

const ARMS = [
  { armId: "close-a", plan: { planId: "plan:close-a", segments: [{ kind: "COPY" as const, copyId: "es.offer-help" }] } },
  { armId: "close-b", plan: { planId: "plan:close-b", segments: [{ kind: "COPY" as const, copyId: "es.offer-help" }] } },
] as const;

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
        createdAt: "2026-08-30T03:00:00.000Z",
        digest: "envelope_digest",
      },
      digest: "guarded_digest",
    },
    memory: {
      status: "EMPTY",
      authority: "PERSONALIZATION_ONLY",
      subjectId: "customer:audit",
      recalledAt: "2026-08-30T03:00:00.000Z",
      policyDigest: "memory_policy_digest",
      scopeDigest: hash("ltmscope", SCOPE),
      items: [],
      instructions: [],
      digest: "memory_digest",
    },
    businessEntityId: "business:audit",
    customerEntityId: "customer:audit",
    userMessageDigest: "message_digest",
    scopeDigest: hash("ltmscope", SCOPE),
    digest: `base_${disposition}`,
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
      renderedAt: "2026-08-30T03:00:00.000Z",
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

describe("contextual bandit adversarial audit", () => {
  it("refuses to optimize escalation-required responses", async () => {
    const coordinator = new BanditAwareGuardrailCoordinator(fakeBase("ESCALATE"), bandit());
    await expect(coordinator.prepare({
      businessEntityId: "business:audit",
      customerEntityId: "customer:audit",
      userMessage: "give me an unsupported guarantee",
      banditId: "sales-close",
      interactionId: "audit:escalation",
      banditContext: { intent: "quote" },
      eligibleArmIds: ["close-a", "close-b"],
    })).rejects.toThrow(/disabled on escalation/i);
  });

  it("binds the outbound response to the exact selected arm", async () => {
    const coordinator = new BanditAwareGuardrailCoordinator(fakeBase(), bandit());
    const context = await coordinator.prepare({
      businessEntityId: "business:audit",
      customerEntityId: "customer:audit",
      userMessage: "quiero cotizar",
      banditId: "sales-close",
      interactionId: "audit:binding",
      banditContext: { intent: "quote", channel: "whatsapp" },
      eligibleArmIds: ["close-a", "close-b"],
    });
    const response = coordinator.renderSelected(context);
    expect(response.planId).toBe(context.decision.plan.planId);
    expect(() => coordinator.verifyOutbound(response, context)).not.toThrow();

    const forged: RenderedGuardrailResponse = { ...response, planId: "plan:close-b" };
    expect(() => coordinator.verifyOutbound(forged, context)).toThrow(/not rendered from the selected bandit arm/i);
  });

  it("rejects copied contexts that were not issued by the coordinator", async () => {
    const coordinator = new BanditAwareGuardrailCoordinator(fakeBase(), bandit());
    const context = await coordinator.prepare({
      businessEntityId: "business:audit",
      customerEntityId: "customer:audit",
      userMessage: "quiero cotizar",
      banditId: "sales-close",
      interactionId: "audit:copy",
      banditContext: { intent: "quote" },
      eligibleArmIds: ["close-a", "close-b"],
    });
    expect(() => coordinator.renderSelected({ ...context })).toThrow(/not issued by this coordinator/i);
  });

  it("rejects cross-scope wiring", () => {
    const other: OntologyScope = { tenantId: "tenant:other", organizationId: "org:other" };
    expect(() => new BanditAwareGuardrailCoordinator(fakeBase(), bandit(other))).toThrow(/same ontology scope/i);
  });
});
