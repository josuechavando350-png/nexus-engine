import { hash, normalizeIdentifier } from "./chatbot-knowledge-types.js";
import type { RenderedGuardrailResponse } from "./chatbot-guardrails-types.js";
import { MemoryAwareGuardrailCoordinator, type PreparedMemoryAwareGuardrailContext } from "./chatbot-memory-guardrail.js";
import type { MemoryAwareGuardrailRequest } from "./chatbot-memory-types.js";
import { ContextualBanditEngine } from "./chatbot-bandit-engine.js";
import { ContextualBanditError, type BanditContext, type BanditDecision, type BanditMutationPlan } from "./chatbot-bandit-types.js";

export interface BanditAwareGuardrailRequest extends MemoryAwareGuardrailRequest {
  readonly banditId: string;
  readonly interactionId: string;
  readonly banditContext: BanditContext;
  readonly eligibleArmIds: readonly string[];
}

export interface PreparedBanditAwareGuardrailContext {
  readonly base: PreparedMemoryAwareGuardrailContext;
  readonly decision: BanditDecision;
  readonly exposurePlan: BanditMutationPlan;
  readonly digest: string;
}

/**
 * Capability-4 boundary. The bandit can choose only among pre-registered guarded
 * response plans. It never authors text and cannot run on an escalation-required
 * turn. Final customer text still flows through capability 2 render/verifyOutbound.
 */
export class BanditAwareGuardrailCoordinator {
  private readonly issuedContexts = new WeakSet<object>();
  private readonly issuedResponses = new WeakMap<object, string>();
  readonly scopeDigest: string;

  constructor(
    private readonly base: MemoryAwareGuardrailCoordinator,
    private readonly bandit: ContextualBanditEngine,
  ) {
    const expected = hash("ltmscope", bandit.scope);
    if (base.scopeDigest !== expected) {
      throw new ContextualBanditError("POLICY_VIOLATION", "bandit and guarded memory coordinator must use the same ontology scope");
    }
    this.scopeDigest = expected;
  }

  async prepare(request: BanditAwareGuardrailRequest): Promise<PreparedBanditAwareGuardrailContext> {
    const prepared = await this.base.prepare(request);
    if (prepared.guardrails.envelope.requiredEscalation || prepared.guardrails.envelope.disposition === "ESCALATE") {
      throw new ContextualBanditError("POLICY_VIOLATION", "contextual optimization is disabled on escalation-required responses");
    }
    const banditId = normalizeIdentifier(request.banditId, "banditId");
    const interactionId = normalizeIdentifier(request.interactionId, "interactionId");
    const selected = this.bandit.select({
      banditId,
      interactionId,
      context: request.banditContext,
      eligibleArmIds: request.eligibleArmIds,
      guardrailContextDigest: prepared.digest,
    });
    const core = {
      base: prepared,
      decision: selected.decision,
      exposurePlan: selected.exposurePlan,
    };
    const context = Object.freeze({ ...core, digest: hash("cbguardctx", {
      baseDigest: prepared.digest,
      decisionDigest: selected.decision.digest,
      exposurePlanDigest: selected.exposurePlan.digest,
    }) });
    this.issuedContexts.add(context);
    return context;
  }

  private verifyContext(context: PreparedBanditAwareGuardrailContext): void {
    if (!this.issuedContexts.has(context)) throw new ContextualBanditError("INTEGRITY_FAILURE", "bandit-aware guardrail context was not issued by this coordinator");
    if (context.decision.guardrailContextDigest !== context.base.digest) throw new ContextualBanditError("INTEGRITY_FAILURE", "bandit decision is not bound to this guarded context");
    const expected = hash("cbguardctx", {
      baseDigest: context.base.digest,
      decisionDigest: context.decision.digest,
      exposurePlanDigest: context.exposurePlan.digest,
    });
    if (context.digest !== expected) throw new ContextualBanditError("INTEGRITY_FAILURE", "bandit-aware guardrail context digest mismatch");
  }

  renderSelected(context: PreparedBanditAwareGuardrailContext): RenderedGuardrailResponse {
    this.verifyContext(context);
    const response = this.base.render(context.decision.plan, context.base);
    this.issuedResponses.set(response, context.decision.digest);
    return response;
  }

  verifyOutbound(response: RenderedGuardrailResponse, context: PreparedBanditAwareGuardrailContext): void {
    this.verifyContext(context);
    if (this.issuedResponses.get(response) !== context.decision.digest) {
      throw new ContextualBanditError("INTEGRITY_FAILURE", "outbound response was not rendered from the selected bandit arm");
    }
    if (response.planId !== context.decision.plan.planId) {
      throw new ContextualBanditError("INTEGRITY_FAILURE", "outbound response plan does not match selected bandit arm");
    }
    this.base.verifyOutbound(response, context.base);
  }
}
