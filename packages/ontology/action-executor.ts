import type { ActionType, OntologyScope, ValidatedSchema } from "./index";
import { authorize, type AuditTrailPort, type PrincipalContext, type RiskLevel } from "./auth-audit";
import type { OntologyTransactionPort, TransactionOperation, TransactionResult } from "./transaction";

export interface ActionExecutionRequest {
  readonly requestId: string;
  readonly occurredAt: string;
  readonly principal: PrincipalContext;
  readonly scope: OntologyScope;
  readonly schema: ValidatedSchema;
  readonly action: ActionType;
  readonly targetId?: string;
  readonly risk: RiskLevel;
  readonly humanApprovalId?: string;
  readonly operations: readonly TransactionOperation[];
}

export interface ActionExecutionResult {
  readonly status: "COMMITTED" | "DENIED" | "FAILED";
  readonly requestId: string;
  readonly transaction?: TransactionResult;
  readonly reason?: string;
  readonly auditId: string;
}

export class ActionExecutionError extends Error {
  constructor(public readonly code: "INVALID_REQUEST" | "ACTION_MISMATCH" | "EXECUTION_FAILED", message: string) {
    super(message);
    this.name = "ActionExecutionError";
  }
}

function sameScope(a: OntologyScope, b: OntologyScope): boolean {
  return a.tenantId === b.tenantId && a.organizationId === b.organizationId && a.brandId === b.brandId;
}

function canonicalUtc(value: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new ActionExecutionError("INVALID_REQUEST", "occurredAt must be canonical ISO-8601 UTC");
}

export class OntologyActionExecutor {
  private readonly completed = new Map<string, ActionExecutionResult>();

  constructor(private readonly transactions: OntologyTransactionPort, private readonly audit: AuditTrailPort) {}

  execute(request: ActionExecutionRequest): ActionExecutionResult {
    if (!request.requestId.trim()) throw new ActionExecutionError("INVALID_REQUEST", "requestId must be non-empty");
    canonicalUtc(request.occurredAt);
    if (!sameScope(request.scope, request.schema.scope)) throw new ActionExecutionError("INVALID_REQUEST", "execution scope must match schema scope");

    const previous = this.completed.get(request.requestId);
    if (previous) return previous;

    const declaredAction = request.schema.actions.find((item) => item.id === request.action.id);
    if (!declaredAction) throw new ActionExecutionError("ACTION_MISMATCH", `action ${request.action.id} is not declared in active schema`);
    if (declaredAction.permission !== request.action.permission) throw new ActionExecutionError("ACTION_MISMATCH", "action permission differs from active schema");

    const authorization = authorize({
      principal: request.principal,
      action: declaredAction,
      targetScope: request.scope,
      targetId: request.targetId,
      risk: request.risk,
      humanApprovalId: request.humanApprovalId
    });

    if (authorization.decision === "DENY") {
      const record = this.audit.append({
        occurredAt: request.occurredAt,
        principalId: request.principal.principalId,
        scope: request.scope,
        actionId: declaredAction.id,
        targetId: request.targetId,
        decision: "DENY",
        reason: authorization.reason,
        risk: request.risk,
        humanApprovalId: request.humanApprovalId
      });
      const result: ActionExecutionResult = { status: "DENIED", requestId: request.requestId, reason: authorization.reason, auditId: record.auditId };
      this.completed.set(request.requestId, result);
      return result;
    }

    try {
      const transaction = this.transactions.transact(request.scope, request.schema, request.operations);
      const record = this.audit.append({
        occurredAt: request.occurredAt,
        principalId: request.principal.principalId,
        scope: request.scope,
        actionId: declaredAction.id,
        targetId: request.targetId,
        decision: "ALLOW",
        reason: "authorized action committed atomically",
        risk: request.risk,
        humanApprovalId: request.humanApprovalId
      });
      const result: ActionExecutionResult = { status: "COMMITTED", requestId: request.requestId, transaction, auditId: record.auditId };
      this.completed.set(request.requestId, result);
      return result;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown execution failure";
      const record = this.audit.append({
        occurredAt: request.occurredAt,
        principalId: request.principal.principalId,
        scope: request.scope,
        actionId: declaredAction.id,
        targetId: request.targetId,
        decision: "DENY",
        reason: `execution failed: ${reason}`,
        risk: request.risk,
        humanApprovalId: request.humanApprovalId
      });
      const result: ActionExecutionResult = { status: "FAILED", requestId: request.requestId, reason, auditId: record.auditId };
      this.completed.set(request.requestId, result);
      return result;
    }
  }
}
