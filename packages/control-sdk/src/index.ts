import { createHash } from "node:crypto";

export type OrganizationId = string & { readonly __brand: "OrganizationId" };
export type ResourceKind = "user" | "agent" | "dataset" | "graph" | "model" | "version" | "workflow" | "simulation" | "edge-device" | "policy" | "alert" | "secret-ref";
export interface ResourceRef { organization: OrganizationId; kind: ResourceKind; id: string }
export interface RequestMeta { requestId: string; idempotencyKey?: string; apiVersion: "v1" }
export interface NexusControlTransport { command(meta: RequestMeta, command: unknown): Promise<unknown>; query(meta: RequestMeta, query: unknown): Promise<unknown> }
export class NexusControlClient {
  constructor(private readonly transport: NexusControlTransport) {}
  command(meta: RequestMeta, command: unknown) { return this.transport.command(meta, command); }
  query(meta: RequestMeta, query: unknown) { return this.transport.query(meta, query); }
}

export type FleetPermission = "fleet:deploy" | "fleet:read" | "fleet:rollout";
export type FleetRolloutState = "PLANNED" | "DEPLOYING" | "SUCCEEDED" | "FAILED";

export interface ControlPrincipal {
  principalId: string;
  tenantId: string;
  permissions: readonly FleetPermission[];
}

export interface FleetDeploymentRequest {
  tenantId: string;
  projectId: string;
  sourceRevision: string;
  targetIds: readonly string[];
  idempotencyKey: string;
}

export interface FleetDeployment {
  deploymentId: `deployment_${string}`;
  tenantId: string;
  projectId: string;
  sourceRevision: string;
  targetIds: readonly string[];
  state: FleetRolloutState;
  createdAt: string;
  updatedAt: string;
}

export interface FleetAuditEvent {
  eventId: `audit_${string}`;
  tenantId: string;
  principalId: string;
  action: "DEPLOYMENT_CREATED" | "ROLLOUT_STATE_CHANGED" | "AUTHORIZATION_DENIED";
  deploymentId?: string;
  sourceRevision?: string;
  occurredAt: string;
  detail: string;
}

export class FleetControlError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "FORBIDDEN" | "IDEMPOTENCY_CONFLICT" | "NOT_FOUND" | "INVALID_TRANSITION", message: string) {
    super(message);
    this.name = "FleetControlError";
  }
}

function canonicalTimestamp(value: string): boolean {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new FleetControlError("INVALID_INPUT", `${field} is required`);
  return normalized;
}

function canonicalTargets(values: readonly string[]): readonly string[] {
  if (!values.length) throw new FleetControlError("INVALID_INPUT", "targetIds cannot be empty");
  const normalized = values.map((value) => nonEmpty(value, "targetId"));
  if (new Set(normalized).size !== normalized.length) throw new FleetControlError("INVALID_INPUT", "targetIds must be unique");
  return Object.freeze([...normalized].sort());
}

function assertRevision(value: string): string {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new FleetControlError("INVALID_INPUT", "sourceRevision must be a full lowercase git SHA-1");
  return value;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

function hash(prefix: string, value: unknown): string {
  return `${prefix}_${createHash("sha256").update(stable(value)).digest("hex")}`;
}

function requirePermission(principal: ControlPrincipal, tenantId: string, permission: FleetPermission): void {
  if (!principal.principalId.trim() || !principal.tenantId.trim()) throw new FleetControlError("INVALID_INPUT", "principal identity is incomplete");
  if (principal.tenantId !== tenantId || !principal.permissions.includes(permission)) {
    throw new FleetControlError("FORBIDDEN", `principal is not authorized for ${permission} in tenant ${tenantId}`);
  }
}

const TRANSITIONS: Readonly<Record<FleetRolloutState, readonly FleetRolloutState[]>> = Object.freeze({
  PLANNED: Object.freeze(["DEPLOYING"]),
  DEPLOYING: Object.freeze(["SUCCEEDED", "FAILED"]),
  SUCCEEDED: Object.freeze([]),
  FAILED: Object.freeze([]),
});

export class InMemoryFleetControlPlane {
  private readonly deployments = new Map<string, FleetDeployment>();
  private readonly idempotency = new Map<string, { requestDigest: string; deploymentId: string }>();
  private readonly auditEvents: FleetAuditEvent[] = [];

  constructor(private readonly clock: () => string = () => new Date().toISOString()) {}

  createDeployment(principal: ControlPrincipal, request: FleetDeploymentRequest, now: string): FleetDeployment {
    const tenantId = nonEmpty(request.tenantId, "tenantId");
    const projectId = nonEmpty(request.projectId, "projectId");
    const idempotencyKey = nonEmpty(request.idempotencyKey, "idempotencyKey");
    const sourceRevision = assertRevision(request.sourceRevision);
    const targetIds = canonicalTargets(request.targetIds);
    this.assertNow(now);
    try {
      requirePermission(principal, tenantId, "fleet:deploy");
    } catch (error) {
      this.auditDenied(principal, tenantId, now, error instanceof Error ? error.message : "authorization denied");
      throw error;
    }

    const canonicalRequest = { tenantId, projectId, sourceRevision, targetIds };
    const requestDigest = hash("request", canonicalRequest);
    const idempotencyScope = `${tenantId}\u0000${idempotencyKey}`;
    const existing = this.idempotency.get(idempotencyScope);
    if (existing) {
      if (existing.requestDigest !== requestDigest) throw new FleetControlError("IDEMPOTENCY_CONFLICT", "idempotency key was already used for a different deployment request");
      return this.requireDeployment(existing.deploymentId);
    }

    const deploymentId = hash("deployment", { ...canonicalRequest, idempotencyKey }) as `deployment_${string}`;
    const deployment: FleetDeployment = Object.freeze({
      deploymentId,
      tenantId,
      projectId,
      sourceRevision,
      targetIds,
      state: "PLANNED",
      createdAt: now,
      updatedAt: now,
    });
    this.deployments.set(deploymentId, deployment);
    this.idempotency.set(idempotencyScope, { requestDigest, deploymentId });
    this.audit(principal, tenantId, now, "DEPLOYMENT_CREATED", `deployment created for ${targetIds.length} target(s)`, deploymentId, sourceRevision);
    return deployment;
  }

  getDeployment(principal: ControlPrincipal, tenantId: string, deploymentId: string): FleetDeployment {
    const scopedTenant = nonEmpty(tenantId, "tenantId");
    try {
      requirePermission(principal, scopedTenant, "fleet:read");
    } catch (error) {
      this.auditDeniedAtClock(principal, scopedTenant, error instanceof Error ? error.message : "authorization denied");
      throw error;
    }
    const deployment = this.requireDeployment(deploymentId);
    if (deployment.tenantId !== scopedTenant) {
      this.auditDeniedAtClock(principal, scopedTenant, "cross-tenant deployment read denied");
      throw new FleetControlError("NOT_FOUND", "deployment not found");
    }
    return deployment;
  }

  transitionRollout(principal: ControlPrincipal, tenantId: string, deploymentId: string, nextState: FleetRolloutState, now: string): FleetDeployment {
    const scopedTenant = nonEmpty(tenantId, "tenantId");
    this.assertNow(now);
    try {
      requirePermission(principal, scopedTenant, "fleet:rollout");
    } catch (error) {
      this.auditDenied(principal, scopedTenant, now, error instanceof Error ? error.message : "authorization denied");
      throw error;
    }
    const current = this.requireDeployment(deploymentId);
    if (current.tenantId !== scopedTenant) {
      this.auditDenied(principal, scopedTenant, now, "cross-tenant rollout mutation denied");
      throw new FleetControlError("NOT_FOUND", "deployment not found");
    }
    if (!TRANSITIONS[current.state].includes(nextState)) throw new FleetControlError("INVALID_TRANSITION", `cannot transition rollout from ${current.state} to ${nextState}`);
    const updated = Object.freeze({ ...current, state: nextState, updatedAt: now });
    this.deployments.set(deploymentId, updated);
    this.audit(principal, scopedTenant, now, "ROLLOUT_STATE_CHANGED", `${current.state}->${nextState}`, deploymentId, current.sourceRevision);
    return updated;
  }

  listAuditEvents(principal: ControlPrincipal, tenantId: string): readonly FleetAuditEvent[] {
    const scopedTenant = nonEmpty(tenantId, "tenantId");
    try {
      requirePermission(principal, scopedTenant, "fleet:read");
    } catch (error) {
      this.auditDeniedAtClock(principal, scopedTenant, error instanceof Error ? error.message : "authorization denied");
      throw error;
    }
    return Object.freeze(this.auditEvents.filter((event) => event.tenantId === scopedTenant).map((event) => Object.freeze({ ...event })));
  }

  private requireDeployment(deploymentId: string): FleetDeployment {
    const deployment = this.deployments.get(nonEmpty(deploymentId, "deploymentId"));
    if (!deployment) throw new FleetControlError("NOT_FOUND", "deployment not found");
    return deployment;
  }

  private assertNow(now: string): void {
    if (!canonicalTimestamp(now)) throw new FleetControlError("INVALID_INPUT", "timestamp must be canonical ISO-8601 UTC");
  }

  private audit(principal: ControlPrincipal, tenantId: string, occurredAt: string, action: FleetAuditEvent["action"], detail: string, deploymentId?: string, sourceRevision?: string): void {
    const event = Object.freeze({
      eventId: hash("audit", { tenantId, principalId: principal.principalId, action, deploymentId: deploymentId ?? null, sourceRevision: sourceRevision ?? null, occurredAt, detail, sequence: this.auditEvents.length }) as `audit_${string}`,
      tenantId,
      principalId: principal.principalId,
      action,
      deploymentId,
      sourceRevision,
      occurredAt,
      detail,
    });
    this.auditEvents.push(event);
  }

  private auditDeniedAtClock(principal: ControlPrincipal, tenantId: string, detail: string): void {
    const now = this.clock();
    this.assertNow(now);
    this.auditDenied(principal, tenantId, now, detail);
  }

  private auditDenied(principal: ControlPrincipal, tenantId: string, now: string, detail: string): void {
    this.audit(principal, tenantId, now, "AUTHORIZATION_DENIED", detail);
  }
}
