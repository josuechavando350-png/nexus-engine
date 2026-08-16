import { describe, expect, it } from "vitest";
import { validateSchema, type SchemaVersion } from "./index";
import { InMemoryAuditTrail } from "./auth-audit";
import { InMemoryActionEffectRegistry, InMemoryActionPolicyRegistry, OntologyActionExecutor } from "./action-executor";
import { InMemoryObservability, InMemoryDisasterRecovery } from "./observability-dr";
import { InMemoryOntologyPersistence } from "./persistence-query";
import { InMemoryOntologyTransactionStore } from "./transaction";

const scope = { tenantId: "tenant-a", organizationId: "org-a" };

function activeSchema() {
  const input: SchemaVersion = {
    version: "10.0.0",
    scope,
    properties: [{ id: "prop.name", name: "name", valueKind: "STRING", cardinality: "REQUIRED", unique: false, immutable: false }],
    interfaces: [],
    objects: [{ id: "obj.customer", name: "Customer", propertyIds: ["prop.name"], interfaceIds: [] }],
    relationships: [],
    actions: [{ id: "action.customer.create", name: "CreateCustomer", targetTypeId: "obj.customer", inputPropertyIds: ["prop.name"], permission: "customer:create", preconditionRefs: [], effectRefs: ["effect.customer.create"], emittedEventTypeIds: [] }],
    functions: [],
    events: [],
  };
  return validateSchema(input);
}

describe("M-08 remaining retention ceilings", () => {
  it("fails closed before growing the completed execution cache beyond its ceiling", () => {
    const schema = activeSchema();
    const audit = new InMemoryAuditTrail();
    const executor = new OntologyActionExecutor(
      new InMemoryOntologyTransactionStore(),
      audit,
      new InMemoryActionPolicyRegistry(),
      new InMemoryActionEffectRegistry(),
      undefined,
      undefined,
      1,
    );
    const request = (requestId: string, targetId: string) => ({
      requestId,
      occurredAt: "2026-08-16T14:00:00.000Z",
      principal: { principalId: "user-a", scope, permissions: ["customer:create"] },
      scope,
      schema,
      actionId: "action.customer.create",
      targetId,
      inputs: { "prop.name": "Ada" },
    });
    expect(executor.execute(request("req-1", "customer-1")).status).toBe("DENIED");
    expect(() => executor.execute(request("req-2", "customer-2"))).toThrow("completed execution retention capacity exceeded");
    expect(audit.list(scope)).toHaveLength(1);
  });

  it("applies backpressure to observability signals per scope", () => {
    const observability = new InMemoryObservability({ requiredComponents: ["ontology"], maxComponentAgeMs: 30_000 }, 1);
    observability.emit({ occurredAt: "2026-08-16T14:00:00.000Z", scope, level: "INFO", name: "first" });
    expect(() => observability.emit({ occurredAt: "2026-08-16T14:00:01.000Z", scope, level: "WARN", name: "second" })).toThrow("observability signal capacity exceeded");
    expect(observability.list(scope)).toHaveLength(1);
  });

  it("bounds backup retention per scope without overwriting existing backups", () => {
    const recovery = new InMemoryDisasterRecovery(new InMemoryOntologyPersistence(), 1);
    const first = recovery.backup(scope, "2026-08-16T14:00:00.000Z");
    expect(() => recovery.backup(scope, "2026-08-16T14:00:01.000Z")).toThrow("backup retention capacity exceeded");
    expect(recovery.listBackups(scope)).toHaveLength(1);
    expect(recovery.listBackups(scope)[0]?.backupId).toBe(first.backupId);
  });
});
