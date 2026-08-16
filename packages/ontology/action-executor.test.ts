import { describe, expect, it } from "vitest";
import { validateSchema, type SchemaVersion } from "./index";
import { actionDefinitionId, InMemoryApprovalRegistry, InMemoryAuditTrail } from "./auth-audit";
import {
  ActionExecutionError,
  InMemoryActionEffectRegistry,
  InMemoryActionPolicyRegistry,
  InMemoryAtomicActionCommitter,
  OntologyActionExecutor,
} from "./action-executor";
import { InMemoryOntologyTransactionStore } from "./transaction";

function schema(scope = { tenantId: "tenant-a", organizationId: "org-a" }): ReturnType<typeof validateSchema> {
  const input: SchemaVersion = {
    version: "10.0.0",
    scope,
    properties: [
      { id: "prop.name", name: "name", valueKind: "STRING", cardinality: "REQUIRED", unique: false, immutable: false },
      { id: "prop.secret", name: "secret", valueKind: "STRING", cardinality: "OPTIONAL", unique: false, immutable: false },
    ],
    interfaces: [],
    objects: [
      { id: "obj.customer", name: "Customer", propertyIds: ["prop.name", "prop.secret"], interfaceIds: [] },
      { id: "obj.admin", name: "Admin", propertyIds: ["prop.name"], interfaceIds: [] },
    ],
    relationships: [],
    actions: [{ id: "action.customer.create", name: "CreateCustomer", targetTypeId: "obj.customer", inputPropertyIds: ["prop.name"], permission: "customer:create", preconditionRefs: [], effectRefs: ["effect.customer.create"], emittedEventTypeIds: [] }],
    functions: [],
    events: [],
  };
  return validateSchema(input);
}

function runtime(risk: "LOW" | "HIGH" | "CRITICAL" = "LOW") {
  const active = schema();
  const transactions = new InMemoryOntologyTransactionStore();
  const audit = new InMemoryAuditTrail();
  const policies = new InMemoryActionPolicyRegistry();
  const declared = active.actions[0]!;
  policies.register({ actionId: declared.id, actionDefinitionId: actionDefinitionId(declared), risk, requiresHumanApproval: risk === "HIGH" || risk === "CRITICAL", separationOfDuties: true, policyVersion: "policy-v1" });
  const effects = new InMemoryActionEffectRegistry();
  effects.register("effect.customer.create", { kind: "CREATE_TARGET" });
  return { active, transactions, audit, policies, effects };
}

function request(active: ReturnType<typeof schema>, overrides: Record<string, unknown> = {}) {
  return {
    requestId: "req-1",
    occurredAt: "2026-08-15T22:30:00.000Z",
    principal: { principalId: "user-1", scope: active.scope, permissions: ["customer:create"] },
    scope: active.scope,
    schema: active,
    actionId: "action.customer.create",
    targetId: "customer-1",
    inputs: { "prop.name": "Ada" },
    ...overrides,
  };
}

describe("ontology action executor", () => {
  it("commits only the mutation derived from the registered declared effect", () => {
    const { active, transactions, audit, policies, effects } = runtime();
    transactions.transact(active.scope, active, [{ kind: "CREATE_OBJECT", record: { id: "victim", typeId: "obj.admin", scope: active.scope, properties: { "prop.name": "Keep" } } }]);
    const executor = new OntologyActionExecutor(transactions, audit, policies, effects);
    const result = executor.execute(request(active));
    expect(result.status).toBe("COMMITTED");
    expect(transactions.getObject(active.scope, "customer-1")?.properties["prop.name"]).toBe("Ada");
    expect(transactions.getObject(active.scope, "victim")?.properties["prop.name"]).toBe("Keep");
    expect(audit.verify(active.scope)).toBe(true);
  });

  it("rejects a stale policy when the active action keeps its id but changes definition", () => {
    const original = schema();
    const changedInput: SchemaVersion = {
      version: "10.1.0",
      scope: original.scope,
      properties: [...original.properties],
      interfaces: [...original.interfaces],
      objects: [...original.objects],
      relationships: [...original.relationships],
      actions: [{ ...original.actions[0]!, permission: "customer:create:admin" }],
      functions: [...original.functions],
      events: [...original.events],
    };
    const changed = validateSchema(changedInput);
    const transactions = new InMemoryOntologyTransactionStore();
    const audit = new InMemoryAuditTrail();
    const policies = new InMemoryActionPolicyRegistry();
    policies.register({ actionId: original.actions[0]!.id, actionDefinitionId: actionDefinitionId(original.actions[0]!), risk: "LOW", requiresHumanApproval: false, separationOfDuties: false, policyVersion: "policy-v1" });
    const effects = new InMemoryActionEffectRegistry();
    effects.register("effect.customer.create", { kind: "CREATE_TARGET" });
    const executor = new OntologyActionExecutor(transactions, audit, policies, effects);
    const result = executor.execute(request(changed, { principal: { principalId: "user-1", scope: changed.scope, permissions: ["customer:create", "customer:create:admin"] } }));
    expect(result.status).toBe("DENIED");
    expect(result.reason).toContain("not bound to the declared action definition");
    expect(transactions.getObject(changed.scope, "customer-1")).toBeUndefined();
  });

  it("rejects undeclared input properties instead of allowing foreign writes", () => {
    const { active, transactions, audit, policies, effects } = runtime();
    const executor = new OntologyActionExecutor(transactions, audit, policies, effects);
    const result = executor.execute(request(active, { inputs: { "prop.name": "Ada", "prop.secret": "smuggle" } }));
    expect(result.status).toBe("FAILED");
    expect(result.reason).toContain("not declared by action");
    expect(transactions.getObject(active.scope, "customer-1")).toBeUndefined();
  });

  it("fails closed when an action effect is not registered", () => {
    const { active, transactions, audit, policies } = runtime();
    const executor = new OntologyActionExecutor(transactions, audit, policies, new InMemoryActionEffectRegistry());
    const result = executor.execute(request(active));
    expect(result.status).toBe("FAILED");
    expect(result.reason).toContain("not registered");
  });

  it("denies missing permission without compiling or mutating", () => {
    const { active, transactions, audit, policies, effects } = runtime();
    const executor = new OntologyActionExecutor(transactions, audit, policies, effects);
    const result = executor.execute(request(active, { principal: { principalId: "user-2", scope: active.scope, permissions: [] } }));
    expect(result.status).toBe("DENIED");
    expect(transactions.getObject(active.scope, "customer-1")).toBeUndefined();
  });

  it("ignores caller attempts to downgrade risk because risk comes only from policy", () => {
    const { active, transactions, audit, policies, effects } = runtime("HIGH");
    const executor = new OntologyActionExecutor(transactions, audit, policies, effects);
    const forged = { ...request(active), risk: "LOW" } as Parameters<typeof executor.execute>[0] & { risk: string };
    const result = executor.execute(forged);
    expect(result.status).toBe("DENIED");
    expect(result.reason).toContain("approval");
    expect(audit.list(active.scope)[0]?.risk).toBe("HIGH");
  });

  it("requires a verified approval artifact for policy-owned high risk", () => {
    const { active, transactions, audit, policies, effects } = runtime("HIGH");
    const approvals = new InMemoryApprovalRegistry("approval-secret-123456789");
    const artifact = approvals.issue({ requestId: "req-1", scope: active.scope, actionId: "action.customer.create", targetId: "customer-1", requesterPrincipalId: "user-1", approverPrincipalId: "approver-1", decision: "GRANTED", issuedAt: "2026-08-15T22:00:00.000Z", expiresAt: "2026-08-15T23:00:00.000Z", nonce: "nonce-1", policyVersion: "policy-v1" });
    const executor = new OntologyActionExecutor(transactions, audit, policies, effects, approvals);
    const result = executor.execute(request(active, { approvalId: artifact.approvalId }));
    expect(result.status).toBe("COMMITTED");
    expect(audit.list(active.scope)[0]?.humanApprovalId).toBe(artifact.approvalId);
  });

  it("replays an identical request exactly once", () => {
    const { active, transactions, audit, policies, effects } = runtime();
    const executor = new OntologyActionExecutor(transactions, audit, policies, effects);
    const value = request(active);
    const first = executor.execute(value);
    const second = executor.execute(value);
    expect(second).toEqual(first);
    expect(audit.list(active.scope)).toHaveLength(1);
  });

  it("does not collide when the same requestId is used in another scope", () => {
    const activeA = schema({ tenantId: "tenant-a", organizationId: "org-a" });
    const activeB = schema({ tenantId: "tenant-b", organizationId: "org-b" });
    const transactions = new InMemoryOntologyTransactionStore();
    const audit = new InMemoryAuditTrail();
    const policies = new InMemoryActionPolicyRegistry();
    const definition = activeA.actions[0]!;
    policies.register({ actionId: definition.id, actionDefinitionId: actionDefinitionId(definition), risk: "LOW", requiresHumanApproval: false, separationOfDuties: false, policyVersion: "policy-v1" });
    const effects = new InMemoryActionEffectRegistry();
    effects.register("effect.customer.create", { kind: "CREATE_TARGET" });
    const executor = new OntologyActionExecutor(transactions, audit, policies, effects);

    const first = executor.execute(request(activeA, { requestId: "shared-id", targetId: "a-1" }));
    const second = executor.execute(request(activeB, { requestId: "shared-id", targetId: "b-1", principal: { principalId: "user-1", scope: activeB.scope, permissions: ["customer:create"] } }));
    expect(first.status).toBe("COMMITTED");
    expect(second.status).toBe("COMMITTED");
    expect(transactions.getObject(activeA.scope, "a-1")?.id).toBe("a-1");
    expect(transactions.getObject(activeB.scope, "b-1")?.id).toBe("b-1");
  });

  it("rejects reuse of a scoped idempotency key with a different payload", () => {
    const { active, transactions, audit, policies, effects } = runtime();
    const executor = new OntologyActionExecutor(transactions, audit, policies, effects);
    executor.execute(request(active, { requestId: "same-key", targetId: "customer-1" }));
    expect(() => executor.execute(request(active, { requestId: "same-key", targetId: "customer-2" }))).toThrow(ActionExecutionError);
    expect(transactions.getObject(active.scope, "customer-2")).toBeUndefined();
    expect(audit.list(active.scope)).toHaveLength(1);
  });

  it("rolls back the mutation if failure is injected after mutation and before ALLOW audit", () => {
    const { active, transactions, audit, policies, effects } = runtime();
    const atomic = new InMemoryAtomicActionCommitter(transactions, audit);
    atomic.injectFailureAfterMutationOnce();
    const executor = new OntologyActionExecutor(transactions, audit, policies, effects, undefined, atomic);

    const result = executor.execute(request(active, { requestId: "atomic-failure" }));
    expect(result.status).toBe("FAILED");
    expect(result.reason).toContain("injected failure");
    expect(transactions.getObject(active.scope, "customer-1")).toBeUndefined();
    expect(audit.list(active.scope).filter((record) => record.decision === "ALLOW")).toHaveLength(0);
    expect(audit.verify(active.scope)).toBe(true);
  });

  it("retries an atomic infrastructure failure into exactly one mutation and one success audit", () => {
    const { active, transactions, audit, policies, effects } = runtime();
    const atomic = new InMemoryAtomicActionCommitter(transactions, audit);
    atomic.injectFailureAfterMutationOnce();
    const executor = new OntologyActionExecutor(transactions, audit, policies, effects, undefined, atomic);
    const value = request(active, { requestId: "atomic-retry" });

    expect(executor.execute(value).status).toBe("FAILED");
    const committed = executor.execute(value);
    expect(committed.status).toBe("COMMITTED");
    expect(executor.execute(value)).toEqual(committed);
    expect(transactions.getObject(active.scope, "customer-1")?.revision).toBe(1);
    expect(audit.list(active.scope).filter((record) => record.decision === "ALLOW")).toHaveLength(1);
    expect(audit.verify(active.scope)).toBe(true);
  });

  it("fails closed when action policy is missing", () => {
    const { active, transactions, audit, effects } = runtime();
    const executor = new OntologyActionExecutor(transactions, audit, new InMemoryActionPolicyRegistry(), effects);
    const result = executor.execute(request(active));
    expect(result.status).toBe("DENIED");
    expect(result.reason).toContain("no active action policy");
  });
});
