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
}

export interface AIProviderProposal {
  readonly actionId: string;
  readonly targetId?: string;
  readonly rationale: string;
  readonly risk: RiskLevel;
  readonly requiresHumanApproval?: boolean;
}

export interface AIProviderPort {
  readonly providerId: string;
  propose(input: {
    readonly requestId: string;
    readonly intent: string;
    readonly scope: OntologyScope;
    readonly availableActions: readonly Pick<ActionType, "id" | "name" | "permission">[];
  }): AIProviderProposal;
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
  constructor(public readonly code: "INVALID_REQUEST" | "SCOPE_MISMATCH" | "PROVIDER_FAILURE" | "ACTION_NOT_ALLOWED", message: string) {
    super(message);
    this.name = "AIBoundaryError";
  }
}

function sameScope(a: OntologyScope, b: OntologyScope): boolean {
  return a.tenantId === b.tenantId && a.organizationId === b.organizationId && a.brandId === b.brandId;
}

export class ControlledAIBoundary {
  constructor(private readonly provider: AIProviderPort) {}

  propose(request: AIIntentRequest): ControlledAIProposal {
    if (!request.requestId.trim()) throw new AIBoundaryError("INVALID_REQUEST", "requestId must be non-empty");
    if (!request.intent.trim()) throw new AIBoundaryError("INVALID_REQUEST", "intent must be non-empty");
    if (!Number.isInteger(request.maxInputChars) || request.maxInputChars <= 0) throw new AIBoundaryError("INVALID_REQUEST", "maxInputChars must be a positive integer");
    if (request.intent.length > request.maxInputChars) throw new AIBoundaryError("INVALID_REQUEST", "intent exceeds configured input budget");
    if (!sameScope(request.scope, request.schema.scope) || !sameScope(request.scope, request.principal.scope)) {
      throw new AIBoundaryError("SCOPE_MISMATCH", "AI request, schema and principal scopes must match");
    }

    const allowed = request.schema.actions.filter((action) => request.allowedActionIds.includes(action.id));
    if (allowed.length === 0) throw new AIBoundaryError("ACTION_NOT_ALLOWED", "no actions are exposed to the AI boundary");

    let providerProposal: AIProviderProposal;
    try {
      providerProposal = this.provider.propose({
        requestId: request.requestId,
        intent: request.intent,
        scope: request.scope,
        availableActions: allowed.map(({ id, name, permission }) => ({ id, name, permission }))
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown provider failure";
      throw new AIBoundaryError("PROVIDER_FAILURE", `AI provider failed: ${reason}`);
    }

    const action = allowed.find((candidate) => candidate.id === providerProposal.actionId);
    if (!action) throw new AIBoundaryError("ACTION_NOT_ALLOWED", `AI proposed unavailable action ${providerProposal.actionId}`);
    if (!providerProposal.rationale.trim()) throw new AIBoundaryError("INVALID_REQUEST", "AI proposal rationale must be non-empty");

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
