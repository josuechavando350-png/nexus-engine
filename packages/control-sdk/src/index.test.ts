import { describe, expect, it } from "vitest";
import { FleetControlError, InMemoryFleetControlPlane, type ControlPrincipal } from "./index";

const revision = "0123456789abcdef0123456789abcdef01234567";
const now = "2026-08-17T07:20:00.000Z";
const operator: ControlPrincipal = {
  principalId: "operator-a",
  tenantId: "tenant-a",
  permissions: ["fleet:deploy", "fleet:read", "fleet:rollout"],
};

describe("fleet control plane", () => {
  it("creates immutable exact-revision deployments and is idempotent", () => {
    const control = new InMemoryFleetControlPlane();
    const request = { tenantId: "tenant-a", projectId: "project-a", sourceRevision: revision, targetIds: ["edge-b", "edge-a"], idempotencyKey: "deploy-1" };
    const first = control.createDeployment(operator, request, now);
    const second = control.createDeployment(operator, { ...request, targetIds: ["edge-a", "edge-b"] }, now);
    expect(second).toBe(first);
    expect(first.sourceRevision).toBe(revision);
    expect(first.targetIds).toEqual(["edge-a", "edge-b"]);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("keeps idempotency tenant-wide across authorized principals", () => {
    const control = new InMemoryFleetControlPlane();
    const request = { tenantId: "tenant-a", projectId: "project-a", sourceRevision: revision, targetIds: ["edge-a"], idempotencyKey: "deploy-1" };
    const first = control.createDeployment(operator, request, now);
    const secondOperator: ControlPrincipal = {
      principalId: "operator-b",
      tenantId: "tenant-a",
      permissions: ["fleet:deploy", "fleet:read"],
    };
    const retry = control.createDeployment(secondOperator, request, "2026-08-17T07:21:00.000Z");
    expect(retry).toBe(first);
    const audit = control.listAuditEvents(operator, "tenant-a");
    expect(audit.filter((event) => event.action === "DEPLOYMENT_CREATED")).toHaveLength(1);
  });

  it("rejects reuse of an idempotency key for a different payload", () => {
    const control = new InMemoryFleetControlPlane();
    control.createDeployment(operator, { tenantId: "tenant-a", projectId: "project-a", sourceRevision: revision, targetIds: ["edge-a"], idempotencyKey: "deploy-1" }, now);
    expect(() => control.createDeployment(operator, { tenantId: "tenant-a", projectId: "project-b", sourceRevision: revision, targetIds: ["edge-a"], idempotencyKey: "deploy-1" }, now)).toThrowError(FleetControlError);
  });

  it("fails closed across tenant boundaries without revealing deployment existence", () => {
    const control = new InMemoryFleetControlPlane(() => "2026-08-17T07:20:30.000Z");
    const deployment = control.createDeployment(operator, { tenantId: "tenant-a", projectId: "project-a", sourceRevision: revision, targetIds: ["edge-a"], idempotencyKey: "deploy-1" }, now);
    const otherTenant: ControlPrincipal = { principalId: "operator-b", tenantId: "tenant-b", permissions: ["fleet:read", "fleet:rollout"] };
    expect(() => control.getDeployment(otherTenant, "tenant-a", deployment.deploymentId)).toThrow(/not authorized/);
    expect(() => control.getDeployment(otherTenant, "tenant-b", deployment.deploymentId)).toThrow(/not found/);
    const audit = control.listAuditEvents(operator, "tenant-a");
    expect(audit.at(-1)).toMatchObject({
      action: "AUTHORIZATION_DENIED",
      principalId: "operator-b",
      occurredAt: "2026-08-17T07:20:30.000Z",
    });
  });

  it("enforces monotonic rollout transitions and records audit history", () => {
    const control = new InMemoryFleetControlPlane();
    const deployment = control.createDeployment(operator, { tenantId: "tenant-a", projectId: "project-a", sourceRevision: revision, targetIds: ["edge-a"], idempotencyKey: "deploy-1" }, now);
    const deploying = control.transitionRollout(operator, "tenant-a", deployment.deploymentId, "DEPLOYING", "2026-08-17T07:21:00.000Z");
    const succeeded = control.transitionRollout(operator, "tenant-a", deployment.deploymentId, "SUCCEEDED", "2026-08-17T07:22:00.000Z");
    expect(deploying.state).toBe("DEPLOYING");
    expect(succeeded.state).toBe("SUCCEEDED");
    expect(() => control.transitionRollout(operator, "tenant-a", deployment.deploymentId, "DEPLOYING", "2026-08-17T07:23:00.000Z")).toThrow(/cannot transition/);
    const audit = control.listAuditEvents(operator, "tenant-a");
    expect(audit.map((event) => event.action)).toEqual(["DEPLOYMENT_CREATED", "ROLLOUT_STATE_CHANGED", "ROLLOUT_STATE_CHANGED"]);
  });

  it("denies deploy without explicit permission and records the denial", () => {
    const control = new InMemoryFleetControlPlane();
    const reader: ControlPrincipal = { principalId: "reader-a", tenantId: "tenant-a", permissions: ["fleet:read"] };
    expect(() => control.createDeployment(reader, { tenantId: "tenant-a", projectId: "project-a", sourceRevision: revision, targetIds: ["edge-a"], idempotencyKey: "deploy-1" }, now)).toThrow(/not authorized/);
    const audit = control.listAuditEvents(reader, "tenant-a");
    expect(audit.at(-1)?.action).toBe("AUTHORIZATION_DENIED");
  });

  it("audits denied audit-log reads with an injected deterministic clock", () => {
    const control = new InMemoryFleetControlPlane(() => "2026-08-17T07:25:00.000Z");
    control.createDeployment(operator, { tenantId: "tenant-a", projectId: "project-a", sourceRevision: revision, targetIds: ["edge-a"], idempotencyKey: "deploy-1" }, now);
    const noRead: ControlPrincipal = { principalId: "deployer-a", tenantId: "tenant-a", permissions: ["fleet:deploy"] };
    expect(() => control.listAuditEvents(noRead, "tenant-a")).toThrow(/not authorized/);
    const audit = control.listAuditEvents(operator, "tenant-a");
    expect(audit.at(-1)).toMatchObject({
      action: "AUTHORIZATION_DENIED",
      principalId: "deployer-a",
      occurredAt: "2026-08-17T07:25:00.000Z",
    });
  });
});
