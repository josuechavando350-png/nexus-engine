import { createHash } from "node:crypto";

export type CommercePermission = "commerce:prepare" | "commerce:approve" | "commerce:execute" | "commerce:read";
export type CommerceActionKind = "CREATE_ORDER" | "CONFIRM_ORDER" | "CANCEL_ORDER";
export type CommerceTransactionState = "AWAITING_APPROVAL" | "APPROVED" | "DENIED" | "EXECUTING" | "COMMITTED" | "REJECTED" | "UNAVAILABLE" | "OUTCOME_UNKNOWN";

export interface CommerceScope {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly brandId: string;
}

export interface CommercePrincipal {
  readonly principalId: string;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly brandId: string;
  readonly permissions: readonly CommercePermission[];
}

export interface CommerceActionRequest {
  readonly scope: CommerceScope;
  readonly action: CommerceActionKind;
  readonly idempotencyKey: string;
  readonly orderRef: string;
  readonly currency: string;
  readonly amountMinor: number;
  readonly payloadDigest: string;
}

export interface CommerceApproval {
  readonly approvalId: `commerce_approval_${string}`;
  readonly transactionId: `commerce_tx_${string}`;
  readonly scope: CommerceScope;
  readonly actionDigest: string;
  readonly approverId: string;
  readonly decision: "GRANTED" | "DENIED";
  readonly decidedAt: string;
  readonly expiresAt: string;
  readonly approvalDigest: string;
}

export interface CommerceTransaction {
  readonly transactionId: `commerce_tx_${string}`;
  readonly scope: CommerceScope;
  readonly action: CommerceActionKind;
  readonly actionDigest: string;
  readonly idempotencyKey: string;
  readonly orderRef: string;
  readonly currency: string;
  readonly amountMinor: number;
  readonly payloadDigest: string;
  readonly state: CommerceTransactionState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly approval?: CommerceApproval;
  readonly externalReference?: string;
  readonly failureCode?: string;
}

export interface CommerceAuditEvent {
  readonly eventId: `commerce_audit_${string}`;
  readonly tenantId: string;
  readonly transactionId?: string;
  readonly principalId: string;
  readonly action: "TRANSACTION_PREPARED" | "APPROVAL_GRANTED" | "APPROVAL_DENIED" | "EXECUTION_STARTED" | "EXECUTION_COMMITTED" | "EXECUTION_REJECTED" | "EXECUTOR_UNAVAILABLE" | "OUTCOME_UNKNOWN" | "AUTHORIZATION_DENIED";
  readonly occurredAt: string;
  readonly detail: string;
  readonly previousDigest: string | null;
  readonly eventDigest: string;
}

export interface CommerceExecutorRequest {
  readonly transactionId: string;
  readonly scope: CommerceScope;
  readonly action: CommerceActionKind;
  readonly orderRef: string;
  readonly currency: string;
  readonly amountMinor: number;
  readonly payloadDigest: string;
  readonly idempotencyKey: string;
  readonly actionDigest: string;
  readonly approvalDigest: string;
}

export interface CommerceExecutorResult {
  readonly outcome: "COMMITTED" | "REJECTED";
  readonly externalReference?: string;
  readonly rejectionCode?: string;
}

export interface CommerceExecutor {
  availability(): "AVAILABLE" | "UNAVAILABLE";
  execute(request: CommerceExecutorRequest, signal: AbortSignal): Promise<CommerceExecutorResult>;
}

export class CommerceControlError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "FORBIDDEN" | "NOT_FOUND" | "IDEMPOTENCY_CONFLICT" | "INVALID_TRANSITION" | "APPROVAL_REQUIRED" | "APPROVAL_EXPIRED" | "UNAVAILABLE" | "OUTCOME_UNKNOWN",
    message: string,
  ) {
    super(message);
    this.name = "CommerceControlError";
  }
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function canonicalTimestamp(value: string, field: string): string {
  if (typeof value !== "string") throw new CommerceControlError("INVALID_INPUT", `${field} must be a string`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new CommerceControlError("INVALID_INPUT", `${field} must be canonical ISO-8601 UTC`);
  return value;
}

function identifier(value: string, field: string, max = 200): string {
  if (typeof value !== "string") throw new CommerceControlError("INVALID_INPUT", `${field} must be a string`);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > max || !/^[\p{L}\p{N}._:@/-]+$/u.test(normalized)) throw new CommerceControlError("INVALID_INPUT", `${field} is invalid`);
  return normalized;
}

function validateScope(input: CommerceScope): CommerceScope {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new CommerceControlError("INVALID_INPUT", "commerce scope must be an object");
  const allowed = new Set(["tenantId", "organizationId", "brandId"]);
  for (const key of Object.keys(input as object)) if (!allowed.has(key)) throw new CommerceControlError("INVALID_INPUT", `unknown commerce scope field: ${key}`);
  return Object.freeze({
    tenantId: identifier(input.tenantId, "tenantId"),
    organizationId: identifier(input.organizationId, "organizationId"),
    brandId: identifier(input.brandId, "brandId"),
  });
}

const PERMISSIONS = new Set<CommercePermission>(["commerce:prepare", "commerce:approve", "commerce:execute", "commerce:read"]);

function validatePrincipalIdentity(principal: CommercePrincipal, tenantId: string, permission: CommercePermission): CommercePrincipal {
  if (!principal || typeof principal !== "object" || Array.isArray(principal)) throw new CommerceControlError("INVALID_INPUT", "principal must be an object");
  const allowed = new Set(["principalId", "tenantId", "organizationId", "brandId", "permissions"]);
  for (const key of Object.keys(principal as object)) if (!allowed.has(key)) throw new CommerceControlError("INVALID_INPUT", `unknown commerce principal field: ${key}`);
  if (!Array.isArray(principal.permissions) || principal.permissions.length > 16 || new Set(principal.permissions).size !== principal.permissions.length || principal.permissions.some((entry) => !PERMISSIONS.has(entry))) {
    throw new CommerceControlError("INVALID_INPUT", "principal permissions are invalid or exceed the supported bound");
  }
  const normalized = Object.freeze({
    principalId: identifier(principal.principalId, "principalId"),
    tenantId: identifier(principal.tenantId, "principal.tenantId"),
    organizationId: identifier(principal.organizationId, "principal.organizationId"),
    brandId: identifier(principal.brandId, "principal.brandId"),
    permissions: Object.freeze([...principal.permissions]),
  });
  if (normalized.tenantId !== tenantId || !normalized.permissions.includes(permission)) throw new CommerceControlError("FORBIDDEN", `principal is not authorized for ${permission} in tenant ${tenantId}`);
  return normalized;
}

function requirePrincipalScope(principal: CommercePrincipal, scope: CommerceScope, permission: CommercePermission): CommercePrincipal {
  const normalized = validatePrincipalIdentity(principal, scope.tenantId, permission);
  if (normalized.organizationId !== scope.organizationId || normalized.brandId !== scope.brandId) throw new CommerceControlError("FORBIDDEN", "principal is outside the commerce organization/brand scope");
  return normalized;
}

function validateRequest(input: CommerceActionRequest): Omit<CommerceActionRequest, "scope"> & { scope: CommerceScope } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new CommerceControlError("INVALID_INPUT", "commerce request must be an object");
  const allowed = new Set(["scope", "action", "idempotencyKey", "orderRef", "currency", "amountMinor", "payloadDigest"]);
  for (const key of Object.keys(input as object)) if (!allowed.has(key)) throw new CommerceControlError("INVALID_INPUT", `unknown commerce request field: ${key}`);
  if (!(["CREATE_ORDER", "CONFIRM_ORDER", "CANCEL_ORDER"] as const).includes(input.action)) throw new CommerceControlError("INVALID_INPUT", "unsupported commerce action");
  if (typeof input.currency !== "string") throw new CommerceControlError("INVALID_INPUT", "currency must be a string");
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new CommerceControlError("INVALID_INPUT", "currency must be a three-letter code");
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0 || input.amountMinor > 9_000_000_000_000) throw new CommerceControlError("INVALID_INPUT", "amountMinor is outside the supported bound");
  if (typeof input.payloadDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.payloadDigest)) throw new CommerceControlError("INVALID_INPUT", "payloadDigest must be a lowercase SHA-256 digest");
  return Object.freeze({
    scope: validateScope(input.scope),
    action: input.action,
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey"),
    orderRef: identifier(input.orderRef, "orderRef"),
    currency,
    amountMinor: input.amountMinor,
    payloadDigest: input.payloadDigest,
  });
}

function sameScope(left: CommerceScope, right: CommerceScope): boolean {
  return left.tenantId === right.tenantId && left.organizationId === right.organizationId && left.brandId === right.brandId;
}

export class GovernedCommerceEngine {
  readonly #transactions = new Map<string, CommerceTransaction>();
  readonly #idempotency = new Map<string, { actionDigest: string; transactionId: string }>();
  readonly #auditEvents: CommerceAuditEvent[] = [];
  readonly #inFlight = new Map<string, Promise<CommerceTransaction>>();

  constructor(
    private readonly executor: CommerceExecutor,
    private readonly executionTimeoutMs = 15_000,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {
    if (!Number.isSafeInteger(executionTimeoutMs) || executionTimeoutMs < 1 || executionTimeoutMs > 120_000) throw new CommerceControlError("INVALID_INPUT", "execution timeout must be between 1 and 120000ms");
  }

  prepare(principal: CommercePrincipal, requestInput: CommerceActionRequest, nowInput: string): CommerceTransaction {
    const request = validateRequest(requestInput);
    const now = canonicalTimestamp(nowInput, "now");
    try {
      requirePrincipalScope(principal, request.scope, "commerce:prepare");
    } catch (error) {
      this.auditDenied(principal, request.scope.tenantId, now, error instanceof Error ? error.message : "authorization denied");
      throw error;
    }
    const actionCore = { scope: request.scope, action: request.action, orderRef: request.orderRef, currency: request.currency, amountMinor: request.amountMinor, payloadDigest: request.payloadDigest };
    const actionDigest = digest(actionCore);
    const idempotencyScope = `${request.scope.tenantId}\u0000${request.scope.organizationId}\u0000${request.scope.brandId}\u0000${request.idempotencyKey}`;
    const existing = this.#idempotency.get(idempotencyScope);
    if (existing) {
      if (existing.actionDigest !== actionDigest) throw new CommerceControlError("IDEMPOTENCY_CONFLICT", "idempotency key was already used for a different commerce action");
      return this.requireScopedTransaction(principal, request.scope.tenantId, existing.transactionId, "commerce:prepare");
    }
    const transactionId = `commerce_tx_${digest({ actionDigest, idempotencyKey: request.idempotencyKey })}` as const;
    const transaction = Object.freeze({ transactionId, scope: request.scope, action: request.action, actionDigest, idempotencyKey: request.idempotencyKey, orderRef: request.orderRef, currency: request.currency, amountMinor: request.amountMinor, payloadDigest: request.payloadDigest, state: "AWAITING_APPROVAL" as const, createdAt: now, updatedAt: now });
    this.#transactions.set(transactionId, transaction);
    this.#idempotency.set(idempotencyScope, { actionDigest, transactionId });
    this.audit(principal.principalId, request.scope.tenantId, now, "TRANSACTION_PREPARED", "commerce action prepared and awaiting explicit approval", transactionId);
    return transaction;
  }

  decideApproval(principal: CommercePrincipal, tenantIdInput: string, transactionId: string, decision: "GRANTED" | "DENIED", nowInput: string, expiresAtInput: string): CommerceTransaction {
    const tenantId = identifier(tenantIdInput, "tenantId");
    const now = canonicalTimestamp(nowInput, "now");
    const expiresAt = canonicalTimestamp(expiresAtInput, "expiresAt");
    let current: CommerceTransaction;
    try {
      current = this.requireScopedTransaction(principal, tenantId, transactionId, "commerce:approve");
    } catch (error) {
      this.auditDenied(principal, tenantId, now, error instanceof Error ? error.message : "authorization denied", transactionId);
      throw error;
    }
    if (current.state !== "AWAITING_APPROVAL") throw new CommerceControlError("INVALID_TRANSITION", `cannot decide approval from ${current.state}`);
    if (decision !== "GRANTED" && decision !== "DENIED") throw new CommerceControlError("INVALID_INPUT", "invalid approval decision");
    if (new Date(expiresAt).getTime() <= new Date(now).getTime()) throw new CommerceControlError("INVALID_INPUT", "approval expiry must be in the future");
    const core = { transactionId: current.transactionId, scope: current.scope, actionDigest: current.actionDigest, approverId: principal.principalId, decision, decidedAt: now, expiresAt };
    const approval = Object.freeze({ approvalId: `commerce_approval_${digest(core)}` as const, ...core, approvalDigest: digest(core) });
    const updated = Object.freeze({ ...current, approval, state: decision === "GRANTED" ? "APPROVED" as const : "DENIED" as const, updatedAt: now });
    this.#transactions.set(transactionId, updated);
    this.audit(principal.principalId, tenantId, now, decision === "GRANTED" ? "APPROVAL_GRANTED" : "APPROVAL_DENIED", `approval ${decision.toLowerCase()} for exact action digest`, transactionId);
    return updated;
  }

  execute(principal: CommercePrincipal, tenantIdInput: string, transactionId: string, signal?: AbortSignal): Promise<CommerceTransaction> {
    const tenantId = identifier(tenantIdInput, "tenantId");
    const now = this.trustedNow();
    let current: CommerceTransaction;
    try {
      current = this.requireScopedTransaction(principal, tenantId, transactionId, "commerce:execute");
    } catch (error) {
      this.auditDenied(principal, tenantId, now, error instanceof Error ? error.message : "authorization denied", transactionId);
      return Promise.reject(error);
    }
    if (current.state === "COMMITTED" || current.state === "REJECTED" || current.state === "UNAVAILABLE") return Promise.resolve(current);
    if (current.state === "OUTCOME_UNKNOWN") return Promise.reject(new CommerceControlError("OUTCOME_UNKNOWN", "transaction outcome is unknown and must be reconciled before retry"));
    const existing = this.#inFlight.get(transactionId);
    if (existing) return existing;
    const run = this.executeOnce(principal, current, now, signal).finally(() => this.#inFlight.delete(transactionId));
    this.#inFlight.set(transactionId, run);
    return run;
  }

  getTransaction(principal: CommercePrincipal, tenantIdInput: string, transactionId: string): CommerceTransaction {
    return this.requireScopedTransaction(principal, identifier(tenantIdInput, "tenantId"), transactionId, "commerce:read");
  }

  listAuditEvents(principal: CommercePrincipal, tenantIdInput: string): readonly CommerceAuditEvent[] {
    const tenantId = identifier(tenantIdInput, "tenantId");
    const normalized = validatePrincipalIdentity(principal, tenantId, "commerce:read");
    return Object.freeze(this.#auditEvents.filter((event) => event.tenantId === tenantId && event.principalId === normalized.principalId || false).map((event) => Object.freeze({ ...event })));
  }

  verifyAuditChain(tenantIdInput: string): boolean {
    try {
      const tenantId = identifier(tenantIdInput, "tenantId");
      let previous: string | null = null;
      for (const event of this.#auditEvents.filter((entry) => entry.tenantId === tenantId)) {
        if (event.previousDigest !== previous) return false;
        const { eventDigest, ...core } = event;
        if (digest(core) !== eventDigest) return false;
        previous = eventDigest;
      }
      return true;
    } catch {
      return false;
    }
  }

  private trustedNow(): string {
    return canonicalTimestamp(this.clock(), "trusted clock");
  }

  private async executeOnce(principal: CommercePrincipal, current: CommerceTransaction, now: string, signal?: AbortSignal): Promise<CommerceTransaction> {
    if (current.state !== "APPROVED" || !current.approval || current.approval.decision !== "GRANTED") throw new CommerceControlError("APPROVAL_REQUIRED", "exact action approval is required before commerce execution");
    if (!sameScope(current.scope, current.approval.scope) || current.approval.actionDigest !== current.actionDigest) throw new CommerceControlError("APPROVAL_REQUIRED", "approval is not bound to this exact scoped action");
    if (new Date(current.approval.expiresAt).getTime() <= new Date(now).getTime()) throw new CommerceControlError("APPROVAL_EXPIRED", "commerce approval expired before execution");
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("commerce execution cancelled");
    if (this.executor.availability() !== "AVAILABLE") {
      const unavailable = Object.freeze({ ...current, state: "UNAVAILABLE" as const, updatedAt: now, failureCode: "EXECUTOR_UNAVAILABLE" });
      this.#transactions.set(current.transactionId, unavailable);
      this.audit(principal.principalId, current.scope.tenantId, now, "EXECUTOR_UNAVAILABLE", "commerce executor is unavailable; no external execution was attempted", current.transactionId);
      return unavailable;
    }
    const executing = Object.freeze({ ...current, state: "EXECUTING" as const, updatedAt: now });
    this.#transactions.set(current.transactionId, executing);
    this.audit(principal.principalId, current.scope.tenantId, now, "EXECUTION_STARTED", "approved commerce action handed to executor", current.transactionId);
    const executorRequest = Object.freeze({ transactionId: current.transactionId, scope: current.scope, action: current.action, orderRef: current.orderRef, currency: current.currency, amountMinor: current.amountMinor, payloadDigest: current.payloadDigest, idempotencyKey: current.idempotencyKey, actionDigest: current.actionDigest, approvalDigest: current.approval.approvalDigest });
    try {
      const result = await this.executeBounded(executorRequest, signal);
      if (result.outcome !== "COMMITTED" && result.outcome !== "REJECTED") throw new Error("commerce executor returned an invalid outcome");
      const externalReference = result.externalReference === undefined ? undefined : identifier(result.externalReference, "externalReference", 500);
      const failureCode = result.outcome === "REJECTED" ? identifier(result.rejectionCode ?? "REJECTED", "rejectionCode") : undefined;
      const completed = Object.freeze({ ...executing, state: result.outcome, updatedAt: now, externalReference, failureCode });
      this.#transactions.set(current.transactionId, completed);
      this.audit(principal.principalId, current.scope.tenantId, now, result.outcome === "COMMITTED" ? "EXECUTION_COMMITTED" : "EXECUTION_REJECTED", result.outcome === "COMMITTED" ? "executor confirmed committed outcome" : `executor rejected action: ${failureCode}`, current.transactionId);
      return completed;
    } catch (error) {
      const unknown = Object.freeze({ ...executing, state: "OUTCOME_UNKNOWN" as const, updatedAt: now, failureCode: "EXECUTOR_TRANSPORT_OR_CANCELLATION_FAILURE" });
      this.#transactions.set(current.transactionId, unknown);
      this.audit(principal.principalId, current.scope.tenantId, now, "OUTCOME_UNKNOWN", "executor failed after execution began; automatic replay is blocked pending reconciliation", current.transactionId);
      throw new CommerceControlError("OUTCOME_UNKNOWN", error instanceof Error ? error.message : "commerce executor failed after execution began");
    }
  }

  private async executeBounded(request: CommerceExecutorRequest, signal?: AbortSignal): Promise<CommerceExecutorResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const boundary = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error("commerce execution timeout");
        controller.abort(error);
        reject(error);
      }, this.executionTimeoutMs);
      if (signal) {
        onAbort = () => {
          const reason = signal.reason instanceof Error ? signal.reason : new Error("commerce execution cancelled");
          controller.abort(reason);
          reject(reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    try {
      const execution = Promise.resolve().then(() => this.executor.execute(request, controller.signal));
      return await Promise.race([execution, boundary]);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  private requireScopedTransaction(principal: CommercePrincipal, tenantId: string, transactionIdInput: string, permission: CommercePermission): CommerceTransaction {
    const normalized = validatePrincipalIdentity(principal, tenantId, permission);
    const transactionId = identifier(transactionIdInput, "transactionId", 200);
    const transaction = this.#transactions.get(transactionId);
    if (!transaction || transaction.scope.tenantId !== tenantId || transaction.scope.organizationId !== normalized.organizationId || transaction.scope.brandId !== normalized.brandId) throw new CommerceControlError("NOT_FOUND", "commerce transaction not found");
    return transaction;
  }

  private auditDenied(principal: CommercePrincipal, tenantId: string, now: string, detail: string, transactionId?: string): void {
    this.audit(typeof principal?.principalId === "string" ? principal.principalId : "UNKNOWN", tenantId, now, "AUTHORIZATION_DENIED", detail, transactionId);
  }

  private audit(principalId: string, tenantId: string, occurredAt: string, action: CommerceAuditEvent["action"], detail: string, transactionId?: string): void {
    const tenantEvents = this.#auditEvents.filter((event) => event.tenantId === tenantId);
    const previousDigest = tenantEvents.at(-1)?.eventDigest ?? null;
    const core = { eventId: `commerce_audit_${digest({ tenantId, transactionId: transactionId ?? null, principalId, action, occurredAt, detail, previousDigest, sequence: tenantEvents.length })}` as const, tenantId, transactionId, principalId, action, occurredAt, detail, previousDigest };
    this.#auditEvents.push(Object.freeze({ ...core, eventDigest: digest(core) }));
  }
}

export class GovernedCommerceRuntime {
  constructor(private readonly engine: GovernedCommerceEngine) {}
  prepare(principal: CommercePrincipal, request: CommerceActionRequest, now: string): CommerceTransaction { return this.engine.prepare(principal, request, now); }
  approve(principal: CommercePrincipal, tenantId: string, transactionId: string, now: string, expiresAt: string): CommerceTransaction { return this.engine.decideApproval(principal, tenantId, transactionId, "GRANTED", now, expiresAt); }
  deny(principal: CommercePrincipal, tenantId: string, transactionId: string, now: string, expiresAt: string): CommerceTransaction { return this.engine.decideApproval(principal, tenantId, transactionId, "DENIED", now, expiresAt); }
  execute(principal: CommercePrincipal, tenantId: string, transactionId: string, signal?: AbortSignal): Promise<CommerceTransaction> { return this.engine.execute(principal, tenantId, transactionId, signal); }
}
