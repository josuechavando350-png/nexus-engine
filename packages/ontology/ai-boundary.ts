import { ontologyId, type ActionType, type OntologyScope, type ValidatedSchema } from "./index";
import type { PrincipalContext, RiskLevel } from "./auth-audit";

export interface AIIntentRequest {
  readonly requestId: string;
  readonly principal: PrincipalContext;
  readonly scope: OntologyScope;
  readonly schema: ValidatedSchema;
  readonly intent: string;
  readonly allowedActionIds: readonly string[];
  readonly maxInputChars: number;
  readonly signal?: AbortSignal;
}

export interface AIProviderProposal {
  readonly actionId: string;
  readonly targetId?: string;
  readonly rationale: string;
  readonly risk: RiskLevel;
  readonly requiresHumanApproval?: boolean;
}

export interface AIProviderRequest {
  readonly requestId: string;
  readonly intent: string;
  readonly scope: OntologyScope;
  readonly availableActions: readonly Pick<ActionType, "id" | "name" | "permission">[];
  readonly signal: AbortSignal;
}

export interface AIProviderPort {
  readonly providerId: string;
  propose(input: AIProviderRequest): Promise<AIProviderProposal>;
}

export interface AIBoundaryRuntimePolicy {
  readonly timeoutMs: number;
  readonly maxRationaleChars: number;
  readonly maxConsecutiveFailures: number;
  readonly circuitCooldownMs: number;
}

export interface ControlledAIProposal {
  readonly proposalId: string;
  readonly requestId: string;
  readonly providerId: string;
  readonly scope: OntologyScope;
  readonly action: ActionType;
  readonly targetId?: string;
  readonly rationale: string;
  readonly risk: RiskLevel;
  readonly requiresHumanApproval: boolean;
  readonly executable: false;
}

export class AIBoundaryError extends Error {
  constructor(
    public readonly code:
      | "INVALID_REQUEST"
      | "SCOPE_MISMATCH"
      | "PROVIDER_FAILURE"
      | "PROVIDER_TIMEOUT"
      | "CANCELLED"
      | "CIRCUIT_OPEN"
      | "ACTION_NOT_ALLOWED"
      | "OUTPUT_BUDGET_EXCEEDED",
    message: string,
  ) {
    super(message);
    this.name = "AIBoundaryError";
  }
}

const DEFAULT_RUNTIME_POLICY: AIBoundaryRuntimePolicy = {
  timeoutMs: 5_000,
  maxRationaleChars: 4_000,
  maxConsecutiveFailures: 3,
  circuitCooldownMs: 30_000,
};

function sameScope(a: OntologyScope, b: OntologyScope): boolean {
  return a.tenantId === b.tenantId && a.organizationId === b.organizationId && a.brandId === b.brandId;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

export class ControlledAIBoundary {
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(
    private readonly provider: AIProviderPort,
    private readonly runtimePolicy: AIBoundaryRuntimePolicy = DEFAULT_RUNTIME_POLICY,
    private readonly now: () => number = Date.now,
  ) {
    assertPositiveInteger(runtimePolicy.timeoutMs, "timeoutMs");
    assertPositiveInteger(runtimePolicy.maxRationaleChars, "maxRationaleChars");
    assertPositiveInteger(runtimePolicy.maxConsecutiveFailures, "maxConsecutiveFailures");
    assertPositiveInteger(runtimePolicy.circuitCooldownMs, "circuitCooldownMs");
  }

  async propose(request: AIIntentRequest): Promise<ControlledAIProposal> {
    if (!request.requestId.trim()) throw new AIBoundaryError("INVALID_REQUEST", "requestId must be non-empty");
    if (!request.intent.trim()) throw new AIBoundaryError("INVALID_REQUEST", "intent must be non-empty");
    if (!Number.isInteger(request.maxInputChars) || request.maxInputChars <= 0) throw new AIBoundaryError("INVALID_REQUEST", "maxInputChars must be a positive integer");
    if (request.intent.length > request.maxInputChars) throw new AIBoundaryError("INVALID_REQUEST", "intent exceeds configured input budget");
    if (!sameScope(request.scope, request.schema.scope) || !sameScope(request.scope, request.principal.scope)) {
      throw new AIBoundaryError("SCOPE_MISMATCH", "AI request, schema and principal scopes must match");
    }
    if (request.signal?.aborted) throw new AIBoundaryError("CANCELLED", "AI request was cancelled before provider invocation");

    const allowed = request.schema.actions.filter((action) => request.allowedActionIds.includes(action.id));
    if (allowed.length === 0) throw new AIBoundaryError("ACTION_NOT_ALLOWED", "no actions are exposed to the AI boundary");

    const now = this.now();
    if (this.circuitOpenUntil > now) {
      throw new AIBoundaryError("CIRCUIT_OPEN", "AI provider circuit breaker is open");
    }

    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let removeExternalAbort: (() => void) | undefined;
    let timeoutTriggered = false;

    const cancellation = new Promise<never>((_, reject) => {
      const rejectCancelled = () => {
        controller.abort();
        reject(new AIBoundaryError("CANCELLED", "AI request was cancelled"));
      };
      if (request.signal) {
        request.signal.addEventListener("abort", rejectCancelled, { once: true });
        removeExternalAbort = () => request.signal?.removeEventListener("abort", rejectCancelled);
      }
    });

    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timeoutTriggered = true;
        reject(new AIBoundaryError("PROVIDER_TIMEOUT", `AI provider exceeded ${this.runtimePolicy.timeoutMs}ms timeout`));
        controller.abort();
      }, this.runtimePolicy.timeoutMs);
    });

    let providerProposal: AIProviderProposal;
    try {
      providerProposal = await Promise.race([
        this.provider.propose({
          requestId: request.requestId,
          intent: request.intent,
          scope: request.scope,
          availableActions: allowed.map(({ id, name, permission }) => ({ id, name, permission })),
          signal: controller.signal,
        }),
        timeout,
        cancellation,
      ]);
      this.consecutiveFailures = 0;
      this.circuitOpenUntil = 0;
    } catch (error) {
      if (error instanceof AIBoundaryError && error.code === "CANCELLED") throw error;
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.runtimePolicy.maxConsecutiveFailures) {
        this.circuitOpenUntil = this.now() + this.runtimePolicy.circuitCooldownMs;
      }
      if (timeoutTriggered) {
        throw new AIBoundaryError("PROVIDER_TIMEOUT", `AI provider exceeded ${this.runtimePolicy.timeoutMs}ms timeout`);
      }
      if (error instanceof AIBoundaryError) throw error;
      const reason = error instanceof Error ? error.message : "unknown provider failure";
      throw new AIBoundaryError("PROVIDER_FAILURE", `AI provider failed: ${reason}`);
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      removeExternalAbort?.();
    }

    const action = allowed.find((candidate) => candidate.id === providerProposal.actionId);
    if (!action) throw new AIBoundaryError("ACTION_NOT_ALLOWED", `AI proposed unavailable action ${providerProposal.actionId}`);
    if (!providerProposal.rationale.trim()) throw new AIBoundaryError("INVALID_REQUEST", "AI proposal rationale must be non-empty");
    if (providerProposal.rationale.length > this.runtimePolicy.maxRationaleChars) {
      throw new AIBoundaryError("OUTPUT_BUDGET_EXCEEDED", "AI proposal rationale exceeds configured output budget");
    }

    const requiresHumanApproval = providerProposal.requiresHumanApproval === true || providerProposal.risk === "HIGH" || providerProposal.risk === "CRITICAL";
    const canonical = {
      requestId: request.requestId,
      providerId: this.provider.providerId,
      scope: request.scope,
      actionId: action.id,
      targetId: providerProposal.targetId,
      rationale: providerProposal.rationale,
      risk: providerProposal.risk,
      requiresHumanApproval
    };

    return {
      proposalId: ontologyId("ai-proposal", canonical),
      requestId: request.requestId,
      providerId: this.provider.providerId,
      scope: request.scope,
      action,
      targetId: providerProposal.targetId,
      rationale: providerProposal.rationale,
      risk: providerProposal.risk,
      requiresHumanApproval,
      executable: false
    };
  }
}
