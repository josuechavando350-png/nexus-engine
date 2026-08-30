import { hash, type GroundingRequest } from "./chatbot-knowledge-types.js";
import { FormalGuardrailEngine } from "./chatbot-guardrails-engine.js";
import type { GuardedGenerationContext, GuardrailResponsePlan, RenderedGuardrailResponse } from "./chatbot-guardrails-types.js";
import { LongTermMemoryReader } from "./chatbot-memory-reader.js";
import { LongTermMemoryError, type MemoryAwareGuardrailRequest, type MemoryRecallContext } from "./chatbot-memory-types.js";

export interface PreparedMemoryAwareGuardrailContext {
  readonly guardrails: GuardedGenerationContext;
  readonly memory: MemoryRecallContext;
  readonly businessEntityId: string;
  readonly customerEntityId: string;
  readonly userMessageDigest: string;
  readonly digest: string;
}

/**
 * Couples personalization memory to the exact guarded response path without
 * promoting remembered customer context into commercial/business truth.
 *
 * Memory may influence which approved FACT/COPY IDs a planner selects, but the
 * final outbound response still has to be rendered and verified by the formal
 * guardrail engine from capability 2.
 */
export class MemoryAwareGuardrailCoordinator {
  private readonly issuedContexts = new WeakSet<object>();

  constructor(
    private readonly guardrails: FormalGuardrailEngine,
    private readonly memory: LongTermMemoryReader,
  ) {}

  async prepare(request: MemoryAwareGuardrailRequest): Promise<PreparedMemoryAwareGuardrailContext> {
    const businessEntityId = request.businessEntityId.trim();
    const customerEntityId = request.customerEntityId.trim();
    const userMessage = request.userMessage.trim();
    if (!businessEntityId || !customerEntityId || !userMessage) {
      throw new LongTermMemoryError("INVALID_INPUT", "businessEntityId, customerEntityId, and userMessage must be non-empty");
    }

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

    const core = {
      guardrails: guarded,
      memory: recalled,
      businessEntityId,
      customerEntityId,
      userMessageDigest: hash("ltmmessage", userMessage),
    };
    const context: PreparedMemoryAwareGuardrailContext = Object.freeze({ ...core, digest: hash("ltmguardctx", {
      guardrailsDigest: guarded.digest,
      memoryDigest: recalled.digest,
      businessEntityId,
      customerEntityId,
      userMessageDigest: core.userMessageDigest,
    }) });
    this.issuedContexts.add(context);
    return context;
  }

  private verifyContext(context: PreparedMemoryAwareGuardrailContext): void {
    if (!this.issuedContexts.has(context)) throw new LongTermMemoryError("INTEGRITY_FAILURE", "memory-aware guardrail context was not issued by this coordinator");
    if (context.memory.subjectId !== context.customerEntityId) throw new LongTermMemoryError("INTEGRITY_FAILURE", "memory subject does not match customer entity");
    const expected = hash("ltmguardctx", {
      guardrailsDigest: context.guardrails.digest,
      memoryDigest: context.memory.digest,
      businessEntityId: context.businessEntityId,
      customerEntityId: context.customerEntityId,
      userMessageDigest: context.userMessageDigest,
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
