import { describe, expect, it } from "vitest";
import type { ActionType, OntologyScope } from "./index";
import { InMemoryAuditTrail, authorize } from "./auth-audit";

const scope: OntologyScope = { tenantId: "tenant-a", organizationId: "org-a", brandId: "brand-a" };
const action: ActionType = {
  id: "action.customer.delete",
  name: "DeleteCustomer",
  targetTypeId: "obj.customer",
  inputPropertyIds: [],
  permission: "customer.delete",
  preconditionRefs: [],
  effectRefs: [],
  emittedEventTypeIds: []
};

function principal(overrides: Partial<{ permissions: readonly string[]; scope: OntologyScope }> = {}) {
  return { principalId: "user-1", scope: overrides.scope ?? scope, permissions: overrides.permissions ?? ["customer.delete"] };
}

describe("contextual authorization", () => {
  it("allows only explicit permission in the same scope", () => {
    const result = authorize({ principal: principal(), action, targetScope: scope, targetId: "customer-1", risk: "LOW" });
    expect(result.decision).toBe("ALLOW");
  });

  it("fails closed on scope mismatch and missing permission", () => {
    expect(authorize({ principal: principal({ scope: { ...scope, tenantId: "tenant-b" } }), action, targetScope: scope, risk: "LOW" }).decision).toBe("DENY");
    expect(authorize({ principal: principal({ permissions: [] }), action, targetScope: scope, risk: "LOW" }).decision).toBe("DENY");
  });

  it("requires human approval for high-risk actions", () => {
    expect(authorize({ principal: principal(), action, targetScope: scope, risk: "HIGH" }).decision).toBe("DENY");
    expect(authorize({ principal: principal(), action, targetScope: scope, risk: "HIGH", humanApprovalId: "approval-1" }).decision).toBe("ALLOW");
  });
});

describe("audit trail", () => {
  it("creates a deterministic hash chain per scope", () => {
    const audit = new InMemoryAuditTrail();
    const first = audit.append({ occurredAt: "2026-08-15T22:30:00.000Z", principalId: "user-1", scope, actionId: action.id, targetId: "customer-1", decision: "ALLOW", reason: "ok", risk: "LOW" });
    const second = audit.append({ occurredAt: "2026-08-15T22:31:00.000Z", principalId: "user-1", scope, actionId: action.id, targetId: "customer-1", decision: "DENY", reason: "blocked", risk: "HIGH" });
    expect(first.auditId).toMatch(/^audit_[a-f0-9]{64}$/);
    expect(second.previousAuditId).toBe(first.auditId);
    expect(audit.verify(scope)).toBe(true);
  });

  it("isolates audit histories by scope and rejects non-canonical timestamps", () => {
    const audit = new InMemoryAuditTrail();
    audit.append({ occurredAt: "2026-08-15T22:30:00.000Z", principalId: "user-1", scope, actionId: action.id, decision: "ALLOW", reason: "ok", risk: "LOW" });
    expect(audit.list({ ...scope, tenantId: "tenant-b" })).toHaveLength(0);
    expect(() => audit.append({ occurredAt: "2026-08-15T16:30:00-06:00", principalId: "user-1", scope, actionId: action.id, decision: "ALLOW", reason: "ok", risk: "LOW" })).toThrow("canonical ISO-8601 UTC");
  });
});
