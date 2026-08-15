import { ontologyId, type ActionType, type OntologyScope } from "./index";

export type AuthorizationDecision = "ALLOW" | "DENY";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface PrincipalContext {
  readonly principalId: string;
  readonly scope: OntologyScope;
  readonly permissions: readonly string[];
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface AuthorizationRequest {
  readonly principal: PrincipalContext;
  readonly action: ActionType;
  readonly targetScope: OntologyScope;
  readonly targetId?: string;
  readonly risk: RiskLevel;
  readonly requiresHumanApproval?: boolean;
  readonly humanApprovalId?: string;
}

export interface AuthorizationResult {
  readonly decision: AuthorizationDecision;
  readonly reason: string;
  readonly evaluatedPermission: string;
}

export interface AuditRecord {
  readonly auditId: string;
  readonly occurredAt: string;
  readonly principalId: string;
  readonly scope: OntologyScope;
  readonly actionId: string;
  readonly targetId?: string;
  readonly decision: AuthorizationDecision;
  readonly reason: string;
  readonly risk: RiskLevel;
  readonly humanApprovalId?: string;
  readonly previousAuditId?: string;
}

export interface AuditTrailPort {
  append(input: Omit<AuditRecord, "auditId" | "previousAuditId">): AuditRecord;
  list(scope: OntologyScope): readonly AuditRecord[];
  verify(scope: OntologyScope): boolean;
}

function sameScope(a: OntologyScope, b: OntologyScope): boolean {
  return a.tenantId === b.tenantId && a.organizationId === b.organizationId && a.brandId === b.brandId;
}

function scopeKey(scope: OntologyScope): string {
  return `${scope.tenantId}\u0000${scope.organizationId}\u0000${scope.brandId ?? ""}`;
}

function assertCanonicalUtcTimestamp(value: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error("occurredAt must be a canonical ISO-8601 UTC timestamp");
}

export function authorize(request: AuthorizationRequest): AuthorizationResult {
  if (!sameScope(request.principal.scope, request.targetScope)) {
    return { decision: "DENY", reason: "principal scope does not match target scope", evaluatedPermission: request.action.permission };
  }
  if (!request.action.permission.trim()) {
    return { decision: "DENY", reason: "action has no explicit permission", evaluatedPermission: request.action.permission };
  }
  if (!request.principal.permissions.includes(request.action.permission)) {
    return { decision: "DENY", reason: "required permission is missing", evaluatedPermission: request.action.permission };
  }
  if ((request.risk === "HIGH" || request.risk === "CRITICAL" || request.requiresHumanApproval === true) && !request.humanApprovalId?.trim()) {
    return { decision: "DENY", reason: "human approval is required for this action", evaluatedPermission: request.action.permission };
  }
  return { decision: "ALLOW", reason: "explicit permission and contextual checks satisfied", evaluatedPermission: request.action.permission };
}

export class InMemoryAuditTrail implements AuditTrailPort {
  private readonly histories = new Map<string, AuditRecord[]>();

  append(input: Omit<AuditRecord, "auditId" | "previousAuditId">): AuditRecord {
    assertCanonicalUtcTimestamp(input.occurredAt);
    if (!input.principalId.trim()) throw new Error("principalId must be non-empty");
    if (!input.actionId.trim()) throw new Error("actionId must be non-empty");
    const key = scopeKey(input.scope);
    const history = this.histories.get(key) ?? [];
    const previousAuditId = history.at(-1)?.auditId;
    const body = { ...input, previousAuditId };
    const record: AuditRecord = { ...body, auditId: ontologyId("audit", body) };
    this.histories.set(key, [...history, record]);
    return record;
  }

  list(scope: OntologyScope): readonly AuditRecord[] {
    return [...(this.histories.get(scopeKey(scope)) ?? [])];
  }

  verify(scope: OntologyScope): boolean {
    const history = this.histories.get(scopeKey(scope)) ?? [];
    let previousAuditId: string | undefined;
    for (const record of history) {
      const { auditId, ...body } = record;
      if (body.previousAuditId !== previousAuditId) return false;
      if (ontologyId("audit", body) !== auditId) return false;
      previousAuditId = auditId;
    }
    return true;
  }
}
