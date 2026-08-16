import { describe, expect, it } from "vitest";
import type { ActionType, OntologyScope } from "./index";
import { actionDefinitionId, InMemoryApprovalRegistry, InMemoryAuditTrail, authorize, type ActionAuthorizationPolicy, type ApprovalArtifact } from "./auth-audit";

const scope: OntologyScope = { tenantId: "tenant-a", organizationId: "org-a", brandId: "brand-a" };
const action: ActionType = {
  id: "action.customer.delete",
  name: "DeleteCustomer",
  targetTypeId: "obj.customer",
  inputPropertyIds: [],
  permission: "customer.delete",
  preconditionRefs: [],
  effectRefs: ["effect.customer.delete"],
  emittedEventTypeIds: []
};
const lowPolicy: ActionAuthorizationPolicy = { actionId: action.id, actionDefinitionId: actionDefinitionId(action), risk: "LOW", requiresHumanApproval: false, separationOfDuties: false, policyVersion: "policy-v1" };
const highPolicy: ActionAuthorizationPolicy = { actionId: action.id, actionDefinitionId: actionDefinitionId(action), risk: "HIGH", requiresHumanApproval: true, separationOfDuties: true, policyVersion: "policy-v1" };
const occurredAt = "2026-08-15T22:30:00.000Z";

function principal(overrides: Partial<{ principalId: string; permissions: readonly string[]; scope: OntologyScope }> = {}) {
  return { principalId: overrides.principalId ?? "user-1", scope: overrides.scope ?? scope, permissions: overrides.permissions ?? ["customer.delete"] };
}

function request(policy: ActionAuthorizationPolicy = lowPolicy, overrides: Partial<Parameters<typeof authorize>[0]> = {}): Parameters<typeof authorize>[0] {
  return {
    requestId: "req-1",
    occurredAt,
    principal: principal(),
    action,
    targetScope: scope,
    targetId: "customer-1",
    policy,
    ...overrides
  };
}

function issue(
  approvals: InMemoryApprovalRegistry,
  overrides: Partial<Omit<ApprovalArtifact, "approvalId" | "signature">> = {}
): ApprovalArtifact {
  return approvals.issue({
    requestId: "req-1",
    scope,
    actionId: action.id,
    targetId: "customer-1",
    requesterPrincipalId: "user-1",
    approverPrincipalId: "approver-1",
    decision: "GRANTED",
    issuedAt: "2026-08-15T22:00:00.000Z",
    expiresAt: "2026-08-15T23:00:00.000Z",
    nonce: `nonce-${Math.random()}`,
    policyVersion: "policy-v1",
    ...overrides
  });
}

describe("contextual authorization", () => {
  it("allows only explicit permission in the same scope under active policy", () => {
    expect(authorize(request()).decision).toBe("ALLOW");
    expect(authorize(request(lowPolicy, { principal: principal({ permissions: [] }) })).decision).toBe("DENY");
    expect(authorize(request(lowPolicy, { principal: principal({ scope: { ...scope, tenantId: "tenant-b" } }) })).decision).toBe("DENY");
  });

  it("fails closed when a policy reuses the same action id for a changed definition", () => {
    const changed: ActionType = { ...action, permission: "customer.delete.admin" };
    const result = authorize(request(lowPolicy, {
      action: changed,
      principal: principal({ permissions: ["customer.delete", "customer.delete.admin"] }),
    }));
    expect(result.decision).toBe("DENY");
    expect(result.reason).toContain("not bound to the declared action definition");
  });

  it("fails closed when high-risk approval backend or artifact is absent", () => {
    expect(authorize(request(highPolicy)).decision).toBe("DENY");
    expect(authorize(request(highPolicy, { approvalId: "invented" })).reason).toContain("backend");
    const approvals = new InMemoryApprovalRegistry("approval-secret-123456789");
    expect(authorize(request(highPolicy, { approvalId: "invented" }), approvals).reason).toContain("does not exist");
  });

  it("accepts only a signed, live, GRANTED, correctly bound approval", () => {
    const approvals = new InMemoryApprovalRegistry("approval-secret-123456789");
    const artifact = issue(approvals);
    const result = authorize(request(highPolicy, { approvalId: artifact.approvalId }), approvals);
    expect(result.decision).toBe("ALLOW");
    expect(result.approvalId).toBe(artifact.approvalId);
  });

  it("rejects expired, denied and revoked approvals", () => {
    const expiredRegistry = new InMemoryApprovalRegistry("approval-secret-123456789");
    const expired = issue(expiredRegistry, { expiresAt: "2026-08-15T22:15:00.000Z" });
    expect(authorize(request(highPolicy, { approvalId: expired.approvalId }), expiredRegistry).reason).toContain("expired");

    const deniedRegistry = new InMemoryApprovalRegistry("approval-secret-123456789");
    const denied = issue(deniedRegistry, { decision: "DENIED" });
    expect(authorize(request(highPolicy, { approvalId: denied.approvalId }), deniedRegistry).reason).toContain("GRANTED");

    const revokedRegistry = new InMemoryApprovalRegistry("approval-secret-123456789");
    const revoked = issue(revokedRegistry);
    revokedRegistry.revoke(revoked.approvalId);
    expect(authorize(request(highPolicy, { approvalId: revoked.approvalId }), revokedRegistry).reason).toContain("revoked");
  });

  it("rejects approval bound to another action, target, scope, requester, request or policy", () => {
    const cases: Array<[string, Partial<Omit<ApprovalArtifact, "approvalId" | "signature">>, Partial<Parameters<typeof authorize>[0]>]> = [
      ["action", { actionId: "action.customer.other" }, {}],
      ["target", { targetId: "customer-2" }, {}],
      ["scope", { scope: { ...scope, tenantId: "tenant-b" } }, {}],
      ["requester", { requesterPrincipalId: "user-2" }, {}],
      ["requestId", { requestId: "req-other" }, {}],
      ["policy", { policyVersion: "policy-v0" }, {}]
    ];

    for (const [label, overrides] of cases) {
      const approvals = new InMemoryApprovalRegistry(`approval-secret-${label}-123456789`);
      const artifact = issue(approvals, overrides);
      expect(authorize(request(highPolicy, { approvalId: artifact.approvalId }), approvals).decision, label).toBe("DENY");
    }
  });

  it("rejects self-approval when separation of duties is required", () => {
    const approvals = new InMemoryApprovalRegistry("approval-secret-123456789");
    const artifact = issue(approvals, { approverPrincipalId: "user-1" });
    expect(authorize(request(highPolicy, { approvalId: artifact.approvalId }), approvals).reason).toContain("self-approval");
  });
});

describe("audit trail", () => {
  it("creates a deterministic hash chain per scope", () => {
    const audit = new InMemoryAuditTrail();
    const first = audit.append({ occurredAt, principalId: "user-1", scope, actionId: action.id, targetId: "customer-1", decision: "ALLOW", reason: "ok", risk: "LOW", policyVersion: "policy-v1" });
    const second = audit.append({ occurredAt: "2026-08-15T22:31:00.000Z", principalId: "user-1", scope, actionId: action.id, targetId: "customer-1", decision: "DENY", reason: "blocked", risk: "HIGH", policyVersion: "policy-v1" });
    expect(first.auditId).toMatch(/^audit_[a-f0-9]{64}$/);
    expect(second.previousAuditId).toBe(first.auditId);
    expect(audit.verify(scope)).toBe(true);
  });

  it("isolates audit histories by scope and rejects non-canonical timestamps", () => {
    const audit = new InMemoryAuditTrail();
    audit.append({ occurredAt, principalId: "user-1", scope, actionId: action.id, decision: "ALLOW", reason: "ok", risk: "LOW", policyVersion: "policy-v1" });
    expect(audit.list({ ...scope, tenantId: "tenant-b" })).toHaveLength(0);
    expect(() => audit.append({ occurredAt: "2026-08-15T16:30:00-06:00", principalId: "user-1", scope, actionId: action.id, decision: "ALLOW", reason: "ok", risk: "LOW", policyVersion: "policy-v1" })).toThrow("canonical ISO-8601 UTC");
  });
});
