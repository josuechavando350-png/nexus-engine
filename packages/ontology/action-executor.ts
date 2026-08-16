import { canonicalJson, type ActionType, type OntologyScope, type ValidatedSchema } from "./index";
import { authorize, type ActionAuthorizationPolicy, type ApprovalPort, type AuditTrailPort, type PrincipalContext, type RiskLevel } from "./auth-audit";
import type { ObjectRecord, OntologyTransactionPort, PropertyValue, TransactionOperation, TransactionResult } from "./transaction";

export interface ActionPolicyPort {
  resolve(actionId: string, scope: OntologyScope): ActionAuthorizationPolicy | undefined;
}

export type ActionEffectDescriptor =
  | { readonly kind: "CREATE_TARGET" }
  | { readonly kind: "UPDATE_TARGET" }
  | { readonly kind: "DELETE_TARGET" };

export interface ActionEffectPort {
  resolve(effectRef: string): ActionEffectDescriptor | undefined;
}

export class InMemoryActionPolicyRegistry implements ActionPolicyPort {
  private readonly policies = new Map<string, ActionAuthorizationPolicy>();

  register(policy: ActionAuthorizationPolicy): void {
    if (!policy.actionId.trim() || !policy.policyVersion.trim()) throw new Error("action policy identifiers must be non-empty");
    this.policies.set(policy.actionId, { ...policy });
  }

  resolve(actionId: string): ActionAuthorizationPolicy | undefined {
    const policy = this.policies.get(actionId);
    return policy ? { ...policy } : undefined;
  }
}

export class InMemoryActionEffectRegistry implements ActionEffectPort {
  private readonly effects = new Map<string, ActionEffectDescriptor>();

  register(effectRef: string, descriptor: ActionEffectDescriptor): void {
    if (!effectRef.trim()) throw new Error("effectRef must be non-empty");
    if (this.effects.has(effectRef)) throw new Error(`effect ${effectRef} already registered`);
    this.effects.set(effectRef, { ...descriptor });
  }

  resolve(effectRef: string): ActionEffectDescriptor | undefined {
    const descriptor = this.effects.get(effectRef);
    return descriptor ? { ...descriptor } : undefined;
  }
}

export interface ActionExecutionRequest {
  readonly requestId: string;
  readonly occurredAt: string;
  readonly principal: PrincipalContext;
  readonly scope: OntologyScope;
  readonly schema: ValidatedSchema;
  readonly actionId: string;
  readonly targetId: string;
  readonly inputs: Readonly<Record<string, PropertyValue>>;
  readonly expectedRevision?: number;
  readonly approvalId?: string;
}

export interface ActionExecutionResult {
  readonly status: "COMMITTED" | "DENIED" | "FAILED";
  readonly requestId: string;
  readonly transaction?: TransactionResult;
  readonly reason?: string;
  readonly auditId: string;
}

interface CompletedExecution {
  readonly fingerprint: string;
  readonly result: ActionExecutionResult;
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

function scopeKey(scope: OntologyScope): string {
  return `${scope.tenantId}\u0000${scope.organizationId}\u0000${scope.brandId ?? ""}`;
}

function idempotencyKey(request: ActionExecutionRequest): string {
  return `${scopeKey(request.scope)}\u0000${request.principal.principalId}\u0000${request.actionId}\u0000${request.requestId}`;
}

function requestFingerprint(request: ActionExecutionRequest): string {
  return canonicalJson({
    occurredAt: request.occurredAt,
    scope: request.scope,
    principalId: request.principal.principalId,
    actionId: request.actionId,
    targetId: request.targetId,
    inputs: request.inputs,
    expectedRevision: request.expectedRevision,
    approvalId: request.approvalId,
    schemaVersion: request.schema.version
  });
}

function assertInputs(action: ActionType, inputs: Readonly<Record<string, PropertyValue>>): void {
  for (const propertyId of Object.keys(inputs)) {
    if (!action.inputPropertyIds.includes(propertyId)) throw new ActionExecutionError("INVALID_REQUEST", `input property ${propertyId} is not declared by action ${action.id}`);
  }
}

function targetImplementsAction(schema: ValidatedSchema, action: ActionType, record: ObjectRecord): boolean {
  if (action.targetTypeId && record.typeId !== action.targetTypeId) return false;
  if (action.targetInterfaceId) {
    const type = schema.objects.find((item) => item.id === record.typeId);
    if (!type?.interfaceIds.includes(action.targetInterfaceId)) return false;
  }
  return true;
}

function compileClosedMutationPlan(
  transactions: OntologyTransactionPort,
  effects: ActionEffectPort,
  request: ActionExecutionRequest,
  action: ActionType
): readonly TransactionOperation[] {
  if (action.effectRefs.length !== 1) throw new ActionExecutionError("ACTION_MISMATCH", `action ${action.id} must declare exactly one registered mutation effect`);
  const effectRef = action.effectRefs[0]!;
  const descriptor = effects.resolve(effectRef);
  if (!descriptor) throw new ActionExecutionError("ACTION_MISMATCH", `effect ${effectRef} is not registered`);

  assertInputs(action, request.inputs);
  switch (descriptor.kind) {
    case "CREATE_TARGET": {
      if (!action.targetTypeId) throw new ActionExecutionError("ACTION_MISMATCH", "CREATE_TARGET requires a concrete targetTypeId");
      return [{ kind: "CREATE_OBJECT", record: { id: request.targetId, typeId: action.targetTypeId, scope: request.scope, properties: { ...request.inputs } } }];
    }
    case "UPDATE_TARGET": {
      const current = transactions.getObject(request.scope, request.targetId);
      if (!current) throw new ActionExecutionError("INVALID_REQUEST", `target ${request.targetId} not found`);
      if (!targetImplementsAction(request.schema, action, current)) throw new ActionExecutionError("ACTION_MISMATCH", "target does not satisfy the declared action target contract");
      if (!Number.isInteger(request.expectedRevision) || (request.expectedRevision ?? 0) <= 0) throw new ActionExecutionError("INVALID_REQUEST", "UPDATE_TARGET requires a positive expectedRevision");
      return [{ kind: "UPDATE_OBJECT", id: request.targetId, expectedRevision: request.expectedRevision!, properties: { ...request.inputs } }];
    }
    case "DELETE_TARGET": {
      const current = transactions.getObject(request.scope, request.targetId);
      if (!current) throw new ActionExecutionError("INVALID_REQUEST", `target ${request.targetId} not found`);
      if (!targetImplementsAction(request.schema, action, current)) throw new ActionExecutionError("ACTION_MISMATCH", "target does not satisfy the declared action target contract");
      if (Object.keys(request.inputs).length > 0) throw new ActionExecutionError("INVALID_REQUEST", "DELETE_TARGET does not accept mutation inputs");
      if (!Number.isInteger(request.expectedRevision) || (request.expectedRevision ?? 0) <= 0) throw new ActionExecutionError("INVALID_REQUEST", "DELETE_TARGET requires a positive expectedRevision");
      return [{ kind: "DELETE_OBJECT", id: request.targetId, expectedRevision: request.expectedRevision! }];
    }
  }
}

export class OntologyActionExecutor {
  private readonly completed = new Map<string, CompletedExecution>();

  constructor(
    private readonly transactions: OntologyTransactionPort,
    private readonly audit: AuditTrailPort,
    private readonly policies: ActionPolicyPort,
    private readonly effects: ActionEffectPort,
    private readonly approvals?: ApprovalPort
  ) {}

  execute(request: ActionExecutionRequest): ActionExecutionResult {
    if (!request.requestId.trim()) throw new ActionExecutionError("INVALID_REQUEST", "requestId must be non-empty");
    if (!request.actionId.trim() || !request.targetId.trim()) throw new ActionExecutionError("INVALID_REQUEST", "actionId and targetId must be non-empty");
    canonicalUtc(request.occurredAt);
    if (!sameScope(request.scope, request.schema.scope)) throw new ActionExecutionError("INVALID_REQUEST", "execution scope must match schema scope");

    const replayKey = idempotencyKey(request);
    const fingerprint = requestFingerprint(request);
    const previous = this.completed.get(replayKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new ActionExecutionError("INVALID_REQUEST", "idempotency key was reused with a different request payload");
      return previous.result;
    }

    const declaredAction = request.schema.actions.find((item) => item.id === request.actionId);
    if (!declaredAction) throw new ActionExecutionError("ACTION_MISMATCH", `action ${request.actionId} is not declared in active schema`);
    const policy = this.policies.resolve(declaredAction.id, request.scope);
    if (!policy) return this.deny(request, declaredAction, "no active action policy is available", "CRITICAL", "unavailable", undefined, replayKey, fingerprint);

    const authorization = authorize({
      requestId: request.requestId,
      occurredAt: request.occurredAt,
      principal: request.principal,
      action: declaredAction,
      targetScope: request.scope,
      targetId: request.targetId,
      policy,
      approvalId: request.approvalId
    }, this.approvals);

    if (authorization.decision === "DENY") {
      return this.deny(request, declaredAction, authorization.reason, authorization.risk, authorization.policyVersion, authorization.approvalId, replayKey, fingerprint);
    }

    try {
      const operations = compileClosedMutationPlan(this.transactions, this.effects, request, declaredAction);
      const transaction = this.transactions.transact(request.scope, request.schema, operations);
      const record = this.audit.append({
        occurredAt: request.occurredAt,
        principalId: request.principal.principalId,
        scope: request.scope,
        actionId: declaredAction.id,
        targetId: request.targetId,
        decision: "ALLOW",
        reason: "authorized action committed from registered declared effect",
        risk: policy.risk,
        policyVersion: policy.policyVersion,
        humanApprovalId: request.approvalId
      });
      const result: ActionExecutionResult = { status: "COMMITTED", requestId: request.requestId, transaction, auditId: record.auditId };
      this.completed.set(replayKey, { fingerprint, result });
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
        risk: policy.risk,
        policyVersion: policy.policyVersion,
        humanApprovalId: request.approvalId
      });
      const result: ActionExecutionResult = { status: "FAILED", requestId: request.requestId, reason, auditId: record.auditId };
      this.completed.set(replayKey, { fingerprint, result });
      return result;
    }
  }

  private deny(
    request: ActionExecutionRequest,
    action: ActionType,
    reason: string,
    risk: RiskLevel,
    policyVersion: string,
    approvalId: string | undefined,
    replayKey: string,
    fingerprint: string
  ): ActionExecutionResult {
    const record = this.audit.append({ occurredAt: request.occurredAt, principalId: request.principal.principalId, scope: request.scope, actionId: action.id, targetId: request.targetId, decision: "DENY", reason, risk, policyVersion, humanApprovalId: approvalId });
    const result: ActionExecutionResult = { status: "DENIED", requestId: request.requestId, reason, auditId: record.auditId };
    this.completed.set(replayKey, { fingerprint, result });
    return result;
  }
}
