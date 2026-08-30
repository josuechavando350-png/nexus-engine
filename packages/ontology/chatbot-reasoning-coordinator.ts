import { hash, normalizeIdentifier } from "./chatbot-knowledge-types.js";
import type { RenderedGuardrailResponse } from "./chatbot-guardrails-types.js";
import {
  BanditAwareGuardrailCoordinator,
  type BanditAwareGuardrailRequest,
  type PreparedBanditAwareGuardrailContext,
} from "./chatbot-bandit-guardrail.js";
import { BoundedMultiAgentReasoningEngine } from "./chatbot-reasoning-engine.js";
import {
  ChatbotReasoningError,
  type ReasoningAttemptRecord,
  type ReasoningDeliberation,
  type ReasoningEvidenceSnapshot,
} from "./chatbot-reasoning-types.js";

export interface DeliberativeBanditRequest extends BanditAwareGuardrailRequest {
  readonly reasoningId: string;
}

export interface PreparedDeliberativeBanditContext {
  readonly bandit: PreparedBanditAwareGuardrailContext;
  readonly deliberation: ReasoningDeliberation;
  readonly digest: string;
}

function evidenceSnapshot(userMessage: string, context: PreparedBanditAwareGuardrailContext): ReasoningEvidenceSnapshot {
  const envelope = context.base.guardrails.envelope;
  const memory = context.base.memory;
  const memoryCategories = [...new Set(memory.items.map((item) => item.memory.category))].sort();
  return Object.freeze({
    userMessage,
    userMessageDigest: context.base.userMessageDigest,
    guardedContextDigest: context.base.digest,
    groundingStatus: context.base.guardrails.grounding.status,
    disposition: envelope.disposition,
    allowedFactIds: Object.freeze([...envelope.allowedFactIds]),
    qualifiedFactIds: Object.freeze([...envelope.qualifiedFactIds]),
    requestedClaimClasses: Object.freeze([...envelope.requestedClaimClasses]),
    memoryStatus: memory.status,
    memoryCategories: Object.freeze(memoryCategories),
    memoryAuthority: memory.authority,
  });
}

function verifyDeliberation(deliberation: ReasoningDeliberation): void {
  const core = {
    reasoningId: deliberation.reasoningId,
    interactionId: deliberation.interactionId,
    policyDigest: deliberation.policyDigest,
    scopeDigest: deliberation.scopeDigest,
    status: deliberation.status,
    selectedArmId: deliberation.selectedArmId,
    selectedPlanId: deliberation.selectedPlanId,
    rejectedArmIds: deliberation.rejectedArmIds,
    attempts: deliberation.attempts,
    createdAt: deliberation.createdAt,
  };
  if (hash("reasoning-deliberation", core) !== deliberation.digest) {
    throw new ChatbotReasoningError("INTEGRITY_FAILURE", "reasoning deliberation digest mismatch");
  }
}

/**
 * Capability-5 entry point.
 *
 * It performs bounded candidate-tree search over capability-4 arms. Specialized
 * agents emit structured verdicts only; no hidden chain-of-thought transcript is
 * accepted, persisted or rendered. Rejected candidates are removed and the bandit
 * is asked to re-plan within a strict repair budget. Final text still comes only
 * from capability-2 guarded rendering and must pass verifyOutbound().
 */
export class DeliberativeBanditCoordinator {
  private readonly issuedContexts = new WeakSet<object>();
  private readonly issuedResponses = new WeakMap<object, string>();

  constructor(
    private readonly bandit: BanditAwareGuardrailCoordinator,
    private readonly reasoning: BoundedMultiAgentReasoningEngine,
    private readonly now: () => number = Date.now,
  ) {
    if (bandit.scopeDigest !== reasoning.scopeDigest) {
      throw new ChatbotReasoningError("POLICY_VIOLATION", "reasoning and bandit coordinators must use the same ontology scope");
    }
  }

  async prepare(request: DeliberativeBanditRequest): Promise<PreparedDeliberativeBanditContext> {
    const reasoningId = normalizeIdentifier(request.reasoningId, "reasoningId");
    const interactionId = normalizeIdentifier(request.interactionId, "interactionId");
    const userMessage = request.userMessage.trim();
    if (!userMessage) throw new ChatbotReasoningError("INVALID_INPUT", "userMessage must be non-empty");
    if (userMessage.length > this.reasoning.policy.maxInputChars) {
      throw new ChatbotReasoningError("POLICY_VIOLATION", "userMessage exceeds reasoning input budget");
    }
    let remaining = [...new Set(request.eligibleArmIds.map((id) => normalizeIdentifier(id, "eligibleArmId")))].sort();
    if (remaining.length === 0) throw new ChatbotReasoningError("INVALID_INPUT", "eligibleArmIds must not be empty");

    const rejectedArmIds: string[] = [];
    const attempts: ReasoningAttemptRecord[] = [];
    const maxAttempts = Math.min(remaining.length, this.reasoning.policy.maxRepairAttempts + 1);
    let acceptedContext: PreparedBanditAwareGuardrailContext | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const prepared = await this.bandit.prepare({ ...request, interactionId, userMessage, eligibleArmIds: remaining });
      const selectedArmId = prepared.decision.armId;
      if (!remaining.includes(selectedArmId)) {
        throw new ChatbotReasoningError("INTEGRITY_FAILURE", "bandit selected an arm outside the remaining reasoning candidate set");
      }
      const evaluation = await this.reasoning.evaluate({
        reasoningId,
        interactionId,
        attempt,
        candidateArmId: selectedArmId,
        candidatePlan: prepared.decision.plan,
        remainingArmIds: remaining,
        evidence: evidenceSnapshot(userMessage, prepared),
      });
      attempts.push(evaluation.attempt);
      if (evaluation.accepted) {
        acceptedContext = prepared;
        break;
      }
      rejectedArmIds.push(selectedArmId);
      remaining = remaining.filter((armId) => armId !== selectedArmId);
      if (remaining.length === 0) break;
    }

    if (!acceptedContext) {
      throw new ChatbotReasoningError("NO_SAFE_CANDIDATE", "bounded self-healing search exhausted without a verified response plan");
    }
    const nowMs = this.now();
    if (!Number.isFinite(nowMs) || nowMs < 0) throw new ChatbotReasoningError("INTEGRITY_FAILURE", "reasoning clock returned an invalid timestamp");
    const createdAt = new Date(nowMs).toISOString();
    const status = rejectedArmIds.length > 0 ? "REPAIRED" as const : "VERIFIED" as const;
    const deliberationCore = {
      reasoningId,
      interactionId,
      policyDigest: this.reasoning.policy.digest,
      scopeDigest: this.reasoning.scopeDigest,
      status,
      selectedArmId: acceptedContext.decision.armId,
      selectedPlanId: acceptedContext.decision.plan.planId,
      rejectedArmIds: Object.freeze([...rejectedArmIds]),
      attempts: Object.freeze([...attempts]),
      createdAt,
    };
    const deliberation: ReasoningDeliberation = Object.freeze({ ...deliberationCore, digest: hash("reasoning-deliberation", deliberationCore) });
    const contextCore = { bandit: acceptedContext, deliberation };
    const context = Object.freeze({ ...contextCore, digest: hash("reasoning-guarded-context", {
      banditDigest: acceptedContext.digest,
      deliberationDigest: deliberation.digest,
    }) });
    this.issuedContexts.add(context);
    return context;
  }

  private verifyContext(context: PreparedDeliberativeBanditContext): void {
    if (!this.issuedContexts.has(context)) {
      throw new ChatbotReasoningError("INTEGRITY_FAILURE", "deliberative context was not issued by this coordinator");
    }
    verifyDeliberation(context.deliberation);
    if (context.deliberation.policyDigest !== this.reasoning.policy.digest || context.deliberation.scopeDigest !== this.reasoning.scopeDigest) {
      throw new ChatbotReasoningError("INTEGRITY_FAILURE", "deliberative policy or scope lineage mismatch");
    }
    if (context.bandit.decision.armId !== context.deliberation.selectedArmId || context.bandit.decision.plan.planId !== context.deliberation.selectedPlanId) {
      throw new ChatbotReasoningError("INTEGRITY_FAILURE", "deliberation is not bound to the selected bandit response plan");
    }
    const expected = hash("reasoning-guarded-context", {
      banditDigest: context.bandit.digest,
      deliberationDigest: context.deliberation.digest,
    });
    if (context.digest !== expected) throw new ChatbotReasoningError("INTEGRITY_FAILURE", "deliberative context digest mismatch");
  }

  renderSelected(context: PreparedDeliberativeBanditContext): RenderedGuardrailResponse {
    this.verifyContext(context);
    const response = this.bandit.renderSelected(context.bandit);
    this.issuedResponses.set(response, context.deliberation.digest);
    return response;
  }

  verifyOutbound(response: RenderedGuardrailResponse, context: PreparedDeliberativeBanditContext): void {
    this.verifyContext(context);
    if (this.issuedResponses.get(response) !== context.deliberation.digest) {
      throw new ChatbotReasoningError("INTEGRITY_FAILURE", "outbound response was not rendered from this exact deliberation");
    }
    if (response.planId !== context.deliberation.selectedPlanId) {
      throw new ChatbotReasoningError("INTEGRITY_FAILURE", "outbound response plan does not match the verified deliberation");
    }
    this.bandit.verifyOutbound(response, context.bandit);
  }
}
