import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson, ontologyId, type ActionType, type OntologyScope } from "./index";

export type AuthorizationDecision = "ALLOW" | "DENY";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type ApprovalDecision = "GRANTED" | "DENIED";

export interface PrincipalContext {
  readonly principalId: string;
  readonly scope: OntologyScope;
  readonly permissions: readonly string[];
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface ActionAuthorizationPolicy {
  readonly actionId: string;
  readonly actionDefinitionId?: string;
  readonly risk: RiskLevel;
  readonly requiresHumanApproval: boolean;
  readonly separationOfDuties: boolean;
  readonly policyVersion: string;
}

export function actionDefinitionId(action: ActionType): string {
  return ontologyId("action-definition", action);
}

export interface ApprovalArtifact {
  readonly approvalId: string;
  readonly requestId: string;
  readonly scope: OntologyScope;
  readonly actionId: string;
  readonly targetId?: string;
  readonly requesterPrincipalId: string;
  readonly approverPrincipalId: string;
  readonly decision: ApprovalDecision;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly policyVersion: string;
  readonly signature: string;
}

export interface ApprovalVerificationRequest {
  readonly approvalId: string;
  readonly requestId: string;
  readonly occurredAt: string;
  readonly scope: OntologyScope;
  readonly actionId: string;
  readonly targetId?: string;
  readonly requesterPrincipalId: string;
  readonly policyVersion: string;
  readonly requireSeparationOfDuties: boolean;
}

export interface ApprovalVerificationResult {
  readonly valid: boolean;
  readonly reason: string;
  readonly artifact?: ApprovalArtifact;
}

export interface ApprovalPort {
  verify(request: ApprovalVerificationRequest): ApprovalVerificationResult;
}

export interface AuthorizationRequest {
  readonly requestId: string;
  readonly occurredAt: string;
  readonly principal: PrincipalContext;
  readonly action: ActionType;
  readonly targetScope: OntologyScope;
  readonly targetId?: string;
  readonly policy: ActionAuthorizationPolicy;
  readonly approvalId?: string;
}

export interface AuthorizationResult {
  readonly decision: AuthorizationDecision;
  readonly reason: string;
  readonly evaluatedPermission: string;
  readonly risk: RiskLevel;
  readonly policyVersion: string;
  readonly approvalId?: string;
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
  readonly policyVersion?: string;
  readonly humanApprovalId?: string;
  readonly previousAuditId?: string;
}

export type AuditInput = Omit<AuditRecord, "auditId" | "previousAuditId">;

export interface AuditTrailPort {
  append(input: AuditInput): AuditRecord;
  list(scope: OntologyScope): readonly AuditRecord[];
  verify(scope: OntologyScope): boolean;
}

export interface AuditTrailCheckpoint {
  readonly histories: readonly (readonly [string, readonly AuditRecord[]])[];
}

export interface RecoverableAuditTrailPort extends AuditTrailPort {
  checkpoint(): AuditTrailCheckpoint;
  restore(checkpoint: AuditTrailCheckpoint): void;
}

function sameScope(a: OntologyScope, b: OntologyScope): boolean {
  return a.tenantId === b.tenantId && a.organizationId === b.organizationId && a.brandId === b.brandId;
}

function scopeKey(scope: OntologyScope): string {
  return `${scope.tenantId}\u0000${scope.organizationId}\u0000${scope.brandId ?? ""}`;
}

function assertCanonicalUtcTimestamp(value: string, field = "occurredAt"): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error(`${field} must be a canonical ISO-8601 UTC timestamp`);
}

function approvalPayload(artifact: Omit<ApprovalArtifact, "signature">): string {
  return canonicalJson(artifact);
}

function approvalSignature(secret: string, artifact: Omit<ApprovalArtifact, "signature">): string {
  return `hmac-sha256:${createHmac("sha256", secret).update(approvalPayload(artifact), "utf8").digest("hex")}`;
}

function safeSignatureEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function cloneAuditRecord(record: AuditRecord): AuditRecord {
  return { ...record, scope: { ...record.scope } };
}

export class InMemoryApprovalRegistry implements ApprovalPort {
  private readonly artifacts = new Map<string, ApprovalArtifact>();
  private readonly revoked = new Set<string>();

  constructor(private readonly signingSecret: string) {
    if (signingSecret.length < 16) throw new Error("approval signing secret must be at least 16 characters");
  }

  issue(input: Omit<ApprovalArtifact, "approvalId" | "signature">): ApprovalArtifact {
    assertCanonicalUtcTimestamp(input.issuedAt, "approval issuedAt");
    assertCanonicalUtcTimestamp(input.expiresAt, "approval expiresAt");
    if (new Date(input.expiresAt).getTime() <= new Date(input.issuedAt).getTime()) throw new Error("approval expiresAt must be after issuedAt");
    if (!input.requestId.trim() || !input.actionId.trim() || !input.requesterPrincipalId.trim() || !input.approverPrincipalId.trim() || !input.nonce.trim() || !input.policyVersion.trim()) {
      throw new Error("approval binding fields must be non-empty");
    }
    const approvalId = ontologyId("approval", input);
    if (this.artifacts.has(approvalId)) throw new Error(`approval ${approvalId} already exists`);
    const unsigned = { ...input, scope: { ...input.scope }, approvalId };
    const artifact: ApprovalArtifact = { ...unsigned, signature: approvalSignature(this.signingSecret, unsigned) };
    this.artifacts.set(approvalId, artifact);
    return { ...artifact, scope: { ...artifact.scope } };
  }

  revoke(approvalId: string): void {
    if (!this.artifacts.has(approvalId)) throw new Error(`approval ${approvalId} not found`);
    this.revoked.add(approvalId);
  }

  verify(request: ApprovalVerificationRequest): ApprovalVerificationResult {
    const artifact = this.artifacts.get(request.approvalId);
    if (!artifact) return { valid: false, reason: "approval artifact does not exist" };
    if (this.revoked.has(request.approvalId)) return { valid: false, reason: "approval artifact is revoked" };

    const { signature, ...unsigned } = artifact;
    if (!safeSignatureEqual(approvalSignature(this.signingSecret, unsigned), signature)) return { valid: false, reason: "approval signature is invalid" };
    if (artifact.decision !== "GRANTED") return { valid: false, reason: "approval decision is not GRANTED" };
    if (!sameScope(artifact.scope, request.scope)) return { valid: false, reason: "approval scope does not match request scope" };
    if (artifact.actionId !== request.actionId) return { valid: false, reason: "approval action does not match request action" };
    if (artifact.targetId !== request.targetId) return { valid: false, reason: "approval target does not match request target" };
    if (artifact.requestId !== request.requestId) return { valid: false, reason: "approval requestId does not match request" };
    if (artifact.requesterPrincipalId !== request.requesterPrincipalId) return { valid: false, reason: "approval requester does not match principal" };
    if (artifact.policyVersion !== request.policyVersion) return { valid: false, reason: "approval policy version does not match active policy" };
    if (request.requireSeparationOfDuties && artifact.approverPrincipalId === artifact.requesterPrincipalId) return { valid: false, reason: "self-approval violates separation of duties" };

    assertCanonicalUtcTimestamp(request.occurredAt);
    const now = new Date(request.occurredAt).getTime();
    if (new Date(artifact.issuedAt).getTime() > now) return { valid: false, reason: "approval is not active yet" };
    if (new Date(artifact.expiresAt).getTime() <= now) return { valid: false, reason: "approval artifact is expired" };
    return { valid: true, reason: "verified signed approval artifact", artifact: { ...artifact, scope: { ...artifact.scope } } };
  }
}

export function authorize(request: AuthorizationRequest, approvals?: ApprovalPort): AuthorizationResult {
  const deny = (reason: string): AuthorizationResult => ({
    decision: "DENY",
    reason,
    evaluatedPermission: request.action.permission,
    risk: request.policy.risk,
    policyVersion: request.policy.policyVersion,
    approvalId: request.approvalId,
  });

  if (!sameScope(request.principal.scope, request.targetScope)) return deny("principal scope does not match target scope");
  if (request.policy.actionId !== request.action.id || !request.policy.policyVersion.trim()) return deny("active action policy does not match the declared action");
  if (request.policy.actionDefinitionId !== actionDefinitionId(request.action)) return deny("active action policy is not bound to the declared action definition");
  if (!request.action.permission.trim()) return deny("action has no explicit permission");
  if (!request.principal.permissions.includes(request.action.permission)) return deny("required permission is missing");

  const approvalRequired = request.policy.risk === "HIGH" || request.policy.risk === "CRITICAL" || request.policy.requiresHumanApproval;
  if (approvalRequired) {
    if (!request.approvalId?.trim()) return deny("verified human approval is required for this action");
    if (!approvals) return deny("approval backend is unavailable");
    const verification = approvals.verify({
      approvalId: request.approvalId,
      requestId: request.requestId,
      occurredAt: request.occurredAt,
      scope: request.targetScope,
      actionId: request.action.id,
      targetId: request.targetId,
      requesterPrincipalId: request.principal.principalId,
      policyVersion: request.policy.policyVersion,
      requireSeparationOfDuties: request.policy.separationOfDuties,
    });
    if (!verification.valid) return deny(verification.reason);
  }

  return {
    decision: "ALLOW",
    reason: "explicit permission, policy and contextual checks satisfied",
    evaluatedPermission: request.action.permission,
    risk: request.policy.risk,
    policyVersion: request.policy.policyVersion,
    approvalId: request.approvalId,
  };
}

export class InMemoryAuditTrail implements RecoverableAuditTrailPort {
  private histories = new Map<string, AuditRecord[]>();

  constructor(private readonly maxRecordsPerScope = 100_000) {
    if (!Number.isInteger(maxRecordsPerScope) || maxRecordsPerScope <= 0) throw new Error("maxRecordsPerScope must be a positive integer");
  }

  checkpoint(): AuditTrailCheckpoint {
    return {
      histories: [...this.histories.entries()].map(([name, history]) => [name, history.map(cloneAuditRecord)] as const),
    };
  }

  restore(checkpoint: AuditTrailCheckpoint): void {
    for (const [, history] of checkpoint.histories) {
      if (history.length > this.maxRecordsPerScope) throw new Error("audit checkpoint exceeds configured retention capacity");
    }
    this.histories = new Map(
      checkpoint.histories.map(([name, history]) => [name, history.map(cloneAuditRecord)]),
    );
  }

  append(input: AuditInput): AuditRecord {
    assertCanonicalUtcTimestamp(input.occurredAt);
    if (!input.principalId.trim()) throw new Error("principalId must be non-empty");
    if (!input.actionId.trim()) throw new Error("actionId must be non-empty");
    const key = scopeKey(input.scope);
    const history = this.histories.get(key) ?? [];
    if (history.length >= this.maxRecordsPerScope) throw new Error("audit retention capacity exceeded for scope");
    const previousAuditId = history.at(-1)?.auditId;
    const body = { ...input, previousAuditId };
    const record: AuditRecord = { ...body, auditId: ontologyId("audit", body) };
    this.histories.set(key, [...history, record]);
    return cloneAuditRecord(record);
  }

  list(scope: OntologyScope): readonly AuditRecord[] {
    return (this.histories.get(scopeKey(scope)) ?? []).map(cloneAuditRecord);
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
