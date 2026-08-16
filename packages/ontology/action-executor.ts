import { canonicalJson, type ActionType, type OntologyScope, type ValidatedSchema } from "./index";
import {
  authorize,
  InMemoryAuditTrail,
  type ActionAuthorizationPolicy,
  type ApprovalPort,
  type AuditInput,
  type AuditRecord,
  type AuditTrailPort,
  type PrincipalContext,
  type RiskLevel,
} from "./auth-audit";
import {
  InMemoryEventStream,
  type DomainEvent,
  type EventStreamPort,
} from "./events-workflows";
import {
  InMemoryOntologyTransactionStore,
  type ObjectRecord,
  type OntologyTransactionPort,
  type PropertyValue,
  type TransactionOperation,
  type TransactionResult,
} from "./transaction";

function scopeKey(scope: OntologyScope): string {
  return `${scope.tenantId}\u0000${scope.organizationId}\u0000${scope.brandId ?? ""}`;
}

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

export interface ActionPreconditionContext {
  readonly scope: OntologyScope;
  readonly schema: ValidatedSchema;
  readonly principal: PrincipalContext;
  readonly action: ActionType;
  readonly targetId: string;
  readonly inputs: Readonly<Record<string, PropertyValue>>;
  readonly expectedRevision?: number;
  readonly currentTarget?: ObjectRecord;
}

export interface ActionPreconditionResult {
  readonly satisfied: boolean;
  readonly reason?: string;
}

export interface ActionPreconditionPort {
  evaluate(preconditionRef: string, context: ActionPreconditionContext): ActionPreconditionResult;
}

export type ActionPreconditionEvaluator = (context: ActionPreconditionContext) => ActionPreconditionResult;

export class InMemoryActionPolicyRegistry implements ActionPolicyPort {
  private readonly policies = new Map<string, ActionAuthorizationPolicy>();

  register(scope: OntologyScope, policy: ActionAuthorizationPolicy): void {
    if (!policy.actionId.trim() || !policy.policyVersion.trim()) throw new Error("action policy identifiers must be non-empty");
    const key = `${scopeKey(scope)}\u0000${policy.actionId}`;
    if (this.policies.has(key)) throw new Error(`action policy ${policy.actionId} already registered for scope`);
    this.policies.set(key, { ...policy });
  }

  resolve(actionId: string, scope: OntologyScope): ActionAuthorizationPolicy | undefined {
    const policy = this.policies.get(`${scopeKey(scope)}\u0000${actionId}`);
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

export class InMemoryActionPreconditionRegistry implements ActionPreconditionPort {
  private readonly evaluators = new Map<string, ActionPreconditionEvaluator>();

  register(preconditionRef: string, evaluator: ActionPreconditionEvaluator): void {
    if (!preconditionRef.trim()) throw new Error("preconditionRef must be non-empty");
    if (this.evaluators.has(preconditionRef)) throw new Error(`precondition ${preconditionRef} already registered`);
    this.evaluators.set(preconditionRef, evaluator);
  }

  evaluate(preconditionRef: string, context: ActionPreconditionContext): ActionPreconditionResult {
    const evaluator = this.evaluators.get(preconditionRef);
    if (!evaluator) return { satisfied: false, reason: `precondition ${preconditionRef} is not registered` };
    const result = evaluator(context);
    return result.satisfied ? { satisfied: true } : { satisfied: false, reason: result.reason ?? `precondition ${preconditionRef} was not satisfied` };
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
  readonly emittedEventIds?: readonly string[];
  readonly reason?: string;
  readonly auditId: string;
}

interface CompletedExecution {
  readonly fingerprint: string;
  readonly result: ActionExecutionResult;
}

export interface ActionEventInput {
  readonly eventTypeId: string;
  readonly scope: OntologyScope;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
}

export interface AtomicActionCommitRequest {
  readonly scope: OntologyScope;
  readonly schema: ValidatedSchema;
  readonly operations: readonly TransactionOperation[];
  readonly events: readonly ActionEventInput[];
  readonly audit: AuditInput;
}

export interface AtomicActionCommitResult {
  readonly transaction: TransactionResult;
  readonly events: readonly DomainEvent[];
  readonly audit: AuditRecord;
}

export interface AtomicActionCommitPort {
  commit(request: AtomicActionCommitRequest): AtomicActionCommitResult;
}

export class InMemoryAtomicActionCommitter implements AtomicActionCommitPort {
  private failAfterMutationOnce = false;
  private failAfterEventsOnce = false;

  constructor(
    private readonly transactions: InMemoryOntologyTransactionStore,
    private readonly audit: InMemoryAuditTrail,
    private readonly events?: InMemoryEventStream,
  ) {}

  injectFailureAfterMutationOnce(): void {
    this.failAfterMutationOnce = true;
  }

  injectFailureAfterEventsOnce(): void {
    this.failAfterEventsOnce = true;
  }

  commit(request: AtomicActionCommitRequest): AtomicActionCommitResult {
    if (request.events.length > 0 && !this.events) throw new Error("event stream backend is unavailable");
    const transactionCheckpoint = this.transactions.checkpoint();
    const auditCheckpoint = this.audit.checkpoint();
    const eventCheckpoint = this.events?.checkpoint();

    try {
      const transaction = this.transactions.transact(request.scope, request.schema, request.operations);
      if (this.failAfterMutationOnce) {
        this.failAfterMutationOnce = false;
        throw new Error("injected failure after mutation before event/audit persistence");
      }
      const events = request.events.map((event) => this.events!.append(event));
      if (this.failAfterEventsOnce) {
        this.failAfterEventsOnce = false;
        throw new Error("injected failure after event publication before audit persistence");
      }
      const audit = this.audit.append(request.audit);
      return { transaction, events, audit };
    } catch (error) {
      this.transactions.restore(transactionCheckpoint);
      this.audit.restore(auditCheckpoint);
      if (this.events && eventCheckpoint) this.events.restore(eventCheckpoint);
      throw error;
    }
  }
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
    schemaVersion: request.schema.version,
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
  action: ActionType,
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

function eventPayload(request: ActionExecutionRequest): Readonly<Record<string, string | number | boolean | null>> {
  return {
    actionId: request.actionId,
    targetId: request.targetId,
    principalId: request.principal.principalId,
  };
}

export class OntologyActionExecutor {
  private readonly completed = new Map<string, CompletedExecution>();
  private readonly atomicCommit?: AtomicActionCommitPort;

  constructor(
    private readonly transactions: OntologyTransactionPort,
    private readonly audit: AuditTrailPort,
    private readonly policies: ActionPolicyPort,
    private readonly effects: ActionEffectPort,
    private readonly approvals?: ApprovalPort,
    atomicCommit?: AtomicActionCommitPort,
    private readonly maxCompletedExecutions = 100_000,
    private readonly preconditions?: ActionPreconditionPort,
    private readonly events?: EventStreamPort,
  ) {
    if (!Number.isInteger(maxCompletedExecutions) || maxCompletedExecutions <= 0) throw new Error("maxCompletedExecutions must be a positive integer");
    this.atomicCommit = atomicCommit
      ?? (transactions instanceof InMemoryOntologyTransactionStore && audit instanceof InMemoryAuditTrail && (!events || events instanceof InMemoryEventStream)
        ? new InMemoryAtomicActionCommitter(transactions, audit, events)
        : undefined);
  }

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
    if (this.completed.size >= this.maxCompletedExecutions) {
      throw new ActionExecutionError("EXECUTION_FAILED", "completed execution retention capacity exceeded");
    }

    const declaredAction = request.schema.actions.find((item) => item.id === request.actionId);
    if (!declaredAction) throw new ActionExecutionError("ACTION_MISMATCH", `action ${request.actionId} is not declared in active schema`);
    const policy = this.policies.resolve(declaredAction.id, request.scope);
    if (!policy) return this.deny(request, declaredAction, "no active action policy is available for this scope", "CRITICAL", "unavailable", undefined, replayKey, fingerprint);

    const authorization = authorize({
      requestId: request.requestId,
      occurredAt: request.occurredAt,
      principal: request.principal,
      action: declaredAction,
      targetScope: request.scope,
      targetId: request.targetId,
      policy,
      approvalId: request.approvalId,
    }, this.approvals);

    if (authorization.decision === "DENY") {
      return this.deny(request, declaredAction, authorization.reason, authorization.risk, authorization.policyVersion, authorization.approvalId, replayKey, fingerprint);
    }

    if (declaredAction.preconditionRefs.length > 0 && !this.preconditions) {
      return this.deny(request, declaredAction, "action precondition backend is unavailable", policy.risk, policy.policyVersion, request.approvalId, replayKey, fingerprint);
    }
    for (const preconditionRef of declaredAction.preconditionRefs) {
      let evaluated: ActionPreconditionResult;
      try {
        evaluated = this.preconditions!.evaluate(preconditionRef, {
          scope: request.scope,
          schema: request.schema,
          principal: request.principal,
          action: declaredAction,
          targetId: request.targetId,
          inputs: request.inputs,
          expectedRevision: request.expectedRevision,
          currentTarget: this.transactions.getObject(request.scope, request.targetId),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown precondition failure";
        return this.deny(request, declaredAction, `precondition ${preconditionRef} evaluation failed: ${reason}`, policy.risk, policy.policyVersion, request.approvalId, replayKey, fingerprint);
      }
      if (!evaluated.satisfied) {
        return this.deny(request, declaredAction, evaluated.reason ?? `precondition ${preconditionRef} was not satisfied`, policy.risk, policy.policyVersion, request.approvalId, replayKey, fingerprint);
      }
    }

    if (declaredAction.emittedEventTypeIds.length > 0 && !this.events && !this.atomicCommit) {
      return this.deny(request, declaredAction, "event publication backend is unavailable", policy.risk, policy.policyVersion, request.approvalId, replayKey, fingerprint);
    }

    try {
      const operations = compileClosedMutationPlan(this.transactions, this.effects, request, declaredAction);
      if (!this.atomicCommit) throw new ActionExecutionError("EXECUTION_FAILED", "atomic action commit backend is unavailable");
      const events: readonly ActionEventInput[] = declaredAction.emittedEventTypeIds.map((eventTypeId) => ({
        eventTypeId,
        scope: request.scope,
        occurredAt: request.occurredAt,
        correlationId: request.requestId,
        causationId: request.requestId,
        payload: eventPayload(request),
      }));
      const committed = this.atomicCommit.commit({
        scope: request.scope,
        schema: request.schema,
        operations,
        events,
        audit: {
          occurredAt: request.occurredAt,
          principalId: request.principal.principalId,
          scope: request.scope,
          actionId: declaredAction.id,
          targetId: request.targetId,
          decision: "ALLOW",
          reason: "authorized action committed atomically with declared events and audit evidence",
          risk: policy.risk,
          policyVersion: policy.policyVersion,
          humanApprovalId: request.approvalId,
        },
      });
      if (committed.events.length !== declaredAction.emittedEventTypeIds.length) throw new ActionExecutionError("EXECUTION_FAILED", "atomic commit did not persist all declared events");
      const result: ActionExecutionResult = {
        status: "COMMITTED",
        requestId: request.requestId,
        transaction: committed.transaction,
        emittedEventIds: committed.events.map((event) => event.eventId),
        auditId: committed.audit.auditId,
      };
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
        humanApprovalId: request.approvalId,
      });
      return { status: "FAILED", requestId: request.requestId, reason, auditId: record.auditId };
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
    fingerprint: string,
  ): ActionExecutionResult {
    const record = this.audit.append({
      occurredAt: request.occurredAt,
      principalId: request.principal.principalId,
      scope: request.scope,
      actionId: action.id,
      targetId: request.targetId,
      decision: "DENY",
      reason,
      risk,
      policyVersion,
      humanApprovalId: approvalId,
    });
    const result: ActionExecutionResult = { status: "DENIED", requestId: request.requestId, reason, auditId: record.auditId };
    this.completed.set(replayKey, { fingerprint, result });
    return result;
  }
}
