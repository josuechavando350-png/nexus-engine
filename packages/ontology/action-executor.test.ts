import { describe, expect, it } from "vitest";
import { validateSchema, type SchemaVersion } from "./index";
import { InMemoryAuditTrail } from "./auth-audit";
import { OntologyActionExecutor } from "./action-executor";
import { InMemoryOntologyTransactionStore } from "./transaction";

function schema(): ReturnType<typeof validateSchema> {
  const input: SchemaVersion = {
    version: "10.0.0",
    scope: { tenantId: "tenant-a", organizationId: "org-a" },
    properties: [{ id: "prop.name", name: "name", valueKind: "STRING", cardinality: "REQUIRED", unique: false, immutable: false }],
    interfaces: [],
    objects: [{ id: "obj.customer", name: "Customer", propertyIds: ["prop.name"], interfaceIds: [] }],
    relationships: [],
    actions: [{ id: "action.customer.create", name: "CreateCustomer", targetTypeId: "obj.customer", inputPropertyIds: ["prop.name"], permission: "customer:create", preconditionRefs: [], effectRefs: [], emittedEventTypeIds: [] }],
    functions: [],
    events: []
  };
  return validateSchema(input);
}

describe("ontology action executor", () => {
  it("commits an authorized action and records audit evidence", () => {
    const active = schema();
    const transactions = new InMemoryOntologyTransactionStore();
    const audit = new InMemoryAuditTrail();
    const executor = new OntologyActionExecutor(transactions, audit);
    const action = active.actions[0]!;
    const result = executor.execute({
      requestId: "req-1",
      occurredAt: "2026-08-15T22:30:00.000Z",
      principal: { principalId: "user-1", scope: active.scope, permissions: ["customer:create"] },
      scope: active.scope,
      schema: active,
      action,
      risk: "LOW",
      operations: [{ kind: "CREATE_OBJECT", record: { id: "customer-1", typeId: "obj.customer", scope: active.scope, properties: { "prop.name": "Ada" } } }]
    });
    expect(result.status).toBe("COMMITTED");
    expect(transactions.getObject(active.scope, "customer-1")?.properties["prop.name"]).toBe("Ada");
    expect(audit.verify(active.scope)).toBe(true);
  });

  it("denies missing permission without mutating state", () => {
    const active = schema();
    const transactions = new InMemoryOntologyTransactionStore();
    const audit = new InMemoryAuditTrail();
    const executor = new OntologyActionExecutor(transactions, audit);
    const result = executor.execute({
      requestId: "req-2",
      occurredAt: "2026-08-15T22:31:00.000Z",
      principal: { principalId: "user-2", scope: active.scope, permissions: [] },
      scope: active.scope,
      schema: active,
      action: active.actions[0]!,
      risk: "LOW",
      operations: [{ kind: "CREATE_OBJECT", record: { id: "customer-2", typeId: "obj.customer", scope: active.scope, properties: { "prop.name": "Grace" } } }]
    });
    expect(result.status).toBe("DENIED");
    expect(transactions.getObject(active.scope, "customer-2")).toBeUndefined();
  });

  it("is idempotent by requestId and does not execute twice", () => {
    const active = schema();
    const transactions = new InMemoryOntologyTransactionStore();
    const audit = new InMemoryAuditTrail();
    const executor = new OntologyActionExecutor(transactions, audit);
    const request = {
      requestId: "req-3",
      occurredAt: "2026-08-15T22:32:00.000Z",
      principal: { principalId: "user-3", scope: active.scope, permissions: ["customer:create"] },
      scope: active.scope,
      schema: active,
      action: active.actions[0]!,
      risk: "LOW" as const,
      operations: [{ kind: "CREATE_OBJECT" as const, record: { id: "customer-3", typeId: "obj.customer", scope: active.scope, properties: { "prop.name": "Lin" } } }]
    };
    const first = executor.execute(request);
    const second = executor.execute(request);
    expect(second).toEqual(first);
    expect(audit.list(active.scope)).toHaveLength(1);
  });

  it("requires human approval for critical actions", () => {
    const active = schema();
    const transactions = new InMemoryOntologyTransactionStore();
    const audit = new InMemoryAuditTrail();
    const executor = new OntologyActionExecutor(transactions, audit);
    const result = executor.execute({
      requestId: "req-4",
      occurredAt: "2026-08-15T22:33:00.000Z",
      principal: { principalId: "user-4", scope: active.scope, permissions: ["customer:create"] },
      scope: active.scope,
      schema: active,
      action: active.actions[0]!,
      risk: "CRITICAL",
      operations: [{ kind: "CREATE_OBJECT", record: { id: "customer-4", typeId: "obj.customer", scope: active.scope, properties: { "prop.name": "Nope" } } }]
    });
    expect(result.status).toBe("DENIED");
    expect(result.reason).toContain("human approval");
  });
});
