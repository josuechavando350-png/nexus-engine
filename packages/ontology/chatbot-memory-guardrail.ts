import { hash, normalizeIdentifier, type GroundingRequest } from "./chatbot-knowledge-types.js";
import { KnowledgeGraphReader } from "./chatbot-knowledge-reader.js";
import { FormalGuardrailEngine } from "./chatbot-guardrails-engine.js";
import type { FormalGuardrailPolicy, GuardedGenerationContext, GuardrailResponsePlan, RenderedGuardrailResponse } from "./chatbot-guardrails-types.js";
import { LongTermMemoryReader } from "./chatbot-memory-reader.js";
import { LongTermMemoryError, type MemoryAwareGuardrailRequest, type MemoryRecallContext } from "./chatbot-memory-types.js";

export interface PreparedMemoryAwareGuardrailContext {
  readonly guardrails: GuardedGenerationContext;
  readonly memory: MemoryRecallContext;
  readonly businessEntityId: string;
  readonly customerEntityId: string;
  readonly userMessageDigest: string;
  readonly scopeDigest: string;
  readonly digest: string;
}

/**
 * Couples personalization memory to the exact guarded response path without
 * promoting remembered customer context into commercial/business truth.
 *
 * The coordinator owns its FormalGuardrailEngine so the knowledge reader and
 * memory reader can be bound to exactly the same ontology scope. Memory may
 * influence which approved FACT/COPY IDs a planner selects, but final outbound
 * text still has to be rendered and verified by capability 2.
 */
export class MemoryAwareGuardrailCoordinator {
  private readonly issuedContexts = new WeakSet<object>();
  private readonly guardrails: FormalGuardrailEngine;
  readonly scopeDigest: string;

  constructor(
    knowledge: KnowledgeGraphReader,
    guardrailPolicy: FormalGuardrailPolicy,
    private readonly memory: LongTermMemoryReader,
    now: () => number = Date.now,
  ) {
    const knowledgeScopeDigest = hash("ltmscope", knowledge.scope);
    const memoryScopeDigest = hash("ltmscope", memory.scope);
    if (knowledgeScopeDigest !== memoryScopeDigest) {
      throw new LongTermMemoryError("POLICY_VIOLATION", "knowledge grounding and long-term memory must use the same ontology scope");
    }
    this.scopeDigest = knowledgeScopeDigest;
    this.guardrails = new FormalGuardrailEngine(knowledge, guardrailPolicy, now);
  }

  async prepare(request: MemoryAwareGuardrailRequest): Promise<PreparedMemoryAwareGuardrailContext> {
    const businessEntityId = normalizeIdentifier(request.businessEntityId, "businessEntityId");
    const customerEntityId = normalizeIdentifier(request.customerEntityId, "customerEntityId");
    const userMessage = request.userMessage.trim();
    if (!userMessage) throw new LongTermMemoryError("INVALID_INPUT", "userMessage must be non-empty");

    const groundingRequest: GroundingRequest = {
      businessEntityId,
      userMessage,
      ...(request.minimumConfidence === undefined ? {} : { minimumConfidence: request.minimumConfidence }),
      ...(request.maxFacts === undefined ? {} : { maxFacts: request.maxFacts }),
      ...(request.maxMatchedEntities === undefined ? {} : { maxMatchedEntities: request.maxMatchedEntities }),
    };

    const [guarded, recalled] = await Promise.all([
      this.guardrails.prepare(groundingRequest),
      Promise.resolve(this.memory.recall({ subjectId: customerEntityId, userMessage, ...(request.maxMemories === undefined ? {} : { maxItems: request.maxMemories }) })),
    ]);
    if (recalled.authority !== "PERSONALIZATION_ONLY") {
      throw new LongTermMemoryError("INTEGRITY_FAILURE", "memory recall authority boundary is invalid");
    }
    if (recalled.scopeDigest !== this.scopeDigest) {
      throw new LongTermMemoryError("INTEGRITY_FAILURE", "memory recall scope does not match the coordinator scope");
    }

    const core = {
      guardrails: guarded,
      memory: recalled,
      businessEntityId,
      customerEntityId,
      userMessageDigest: hash("ltmmessage", userMessage),
      scopeDigest: this.scopeDigest,
    };
    const context: PreparedMemoryAwareGuardrailContext = Object.freeze({ ...core, digest: hash("ltmguardctx", {
      guardrailsDigest: guarded.digest,
      memoryDigest: recalled.digest,
      businessEntityId,
      customerEntityId,
      userMessageDigest: core.userMessageDigest,
      scopeDigest: this.scopeDigest,
    }) });
    this.issuedContexts.add(context);
    return context;
  }

  private verifyContext(context: PreparedMemoryAwareGuardrailContext): void {
    if (!this.issuedContexts.has(context)) throw new LongTermMemoryError("INTEGRITY_FAILURE", "memory-aware guardrail context was not issued by this coordinator");
    if (context.memory.authority !== "PERSONALIZATION_ONLY") throw new LongTermMemoryError("INTEGRITY_FAILURE", "memory recall authority boundary is invalid");
    if (context.memory.subjectId !== context.customerEntityId) throw new LongTermMemoryError("INTEGRITY_FAILURE", "memory subject does not match customer entity");
    if (context.memory.scopeDigest !== this.scopeDigest || context.scopeDigest !== this.scopeDigest) {
      throw new LongTermMemoryError("INTEGRITY_FAILURE", "memory-aware guardrail context scope mismatch");
    }
    const expected = hash("ltmguardctx", {
      guardrailsDigest: context.guardrails.digest,
      memoryDigest: context.memory.digest,
      businessEntityId: context.businessEntityId,
      customerEntityId: context.customerEntityId,
      userMessageDigest: context.userMessageDigest,
      scopeDigest: context.scopeDigest,
    });
    if (context.digest !== expected) throw new LongTermMemoryError("INTEGRITY_FAILURE", "memory-aware guardrail context digest mismatch");
  }

  render(plan: GuardrailResponsePlan, context: PreparedMemoryAwareGuardrailContext): RenderedGuardrailResponse {
    this.verifyContext(context);
    return this.guardrails.render(plan, context.guardrails);
  }

  verifyOutbound(response: RenderedGuardrailResponse, context: PreparedMemoryAwareGuardrailContext): void {
    this.verifyContext(context);
    this.guardrails.verifyOutbound(response, context.guardrails);
  }
}
