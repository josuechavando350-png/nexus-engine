import { describe, expect, it } from "vitest";
import { validateSchema, type OntologyScope, type SchemaVersion } from "./index";
import { actionDefinitionId, InMemoryApprovalRegistry, InMemoryAuditTrail } from "./auth-audit";
import {
  ActionExecutionError,
  InMemoryActionEffectRegistry,
  InMemoryActionPolicyRegistry,
  InMemoryActionPreconditionRegistry,
  InMemoryAtomicActionCommitter,
  OntologyActionExecutor,
} from "./action-executor";
import { InMemoryEventStream } from "./events-workflows";
import { InMemoryOntologyTransactionStore } from "./transaction";

interface SchemaSemantics {
  readonly preconditionRefs?: readonly string[];
  readonly emittedEventTypeIds?: readonly string[];
}

function schema(
  scope: OntologyScope = { tenantId: "tenant-a", organizationId: "org-a" },
  semantics: SchemaSemantics = {},
): ReturnType<typeof validateSchema> {
  const emittedEventTypeIds = semantics.emittedEventTypeIds ?? [];
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
    actions: [{
      id: "action.customer.create",
      name: "CreateCustomer",
      targetTypeId: "obj.customer",
      inputPropertyIds: ["prop.name"],
      permission: "customer:create",
      preconditionRefs: semantics.preconditionRefs ?? [],
      effectRefs: ["effect.customer.create"],
      emittedEventTypeIds,
    }],
    functions: [],
    events: emittedEventTypeIds.map((id) => ({ id, name: "CustomerCreated", propertyIds: [] })),
  };
  return validateSchema(input);
}

function registerPolicy(policies: InMemoryActionPolicyRegistry, active: ReturnType<typeof schema>, risk: "LOW" | "HIGH" | "CRITICAL" = "LOW", version = "policy-v1") {
  const declared = active.actions[0]!;
  policies.register(active.scope, {
    actionId: declared.id,
    actionDefinitionId: actionDefinitionId(declared),
    risk,
    requiresHumanApproval: risk === "HIGH" || risk === "CRITICAL",
    separationOfDuties: true,
    policyVersion: version,
  });
}

function runtime(risk: "LOW" | "HIGH" | "CRITICAL" = "LOW", semantics: SchemaSemantics = {}) {
  const active = schema(undefined, semantics);
  const transactions = new InMemoryOntologyTransactionStore();
  const audit = new InMemoryAuditTrail();
  const policies = new InMemoryActionPolicyRegistry();
  registerPolicy(policies, active, risk);
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

  it("enforces declared preconditions before mutation", () => {
    const { active, transactions, audit, policies, effects } = runtime("LOW", { preconditionRefs: ["customer.balance.zero"] });
    const preconditions = new InMemoryActionPreconditionRegistry();
    preconditions.register("customer.balance.zero", () => ({ satisfied: false, reason: "customer balance must be zero" }));
    const executor = new OntologyActionExecutor(transactions, audit, policies, effects, undefined, undefined, 100_000, preconditions);
    const result = executor.execute(request(active));
    expect(result.status).toBe("DENIED");
    expect(result.reason).toContain("balance must be zero");
    expect(transactions.getObject(active.scope, "customer-1")).toBeUndefined();
    expect(audit.list(active.scope)[0]?.decision).toBe("DENY");
  });

  it("fails closed when a declared precondition is unknown or backend is unavailable", () => {
    const { active, transactions, audit, policies, effects } = runtime("LOW", { preconditionRefs: ["known.only"] });
    const missingBackend = new OntologyActionExecutor(transactions, audit, policies, effects);
    expect(missingBackend.execute(request(active, { requestId: "missing-backend" })).reason).toContain("precondition backend is unavailable");

    const preconditions = new InMemoryActionPreconditionRegistry();
    const unknown = new OntologyActionExecutor(transactions, audit, policies, effects, undefined, undefined, 100_000, preconditions);
    const result = unknown.execute(request(active, { requestId: "unknown-precondition", targetId: "customer-2" }));
    expect(result.status).toBe("DENIED");
    expect(result.reason).toContain("not registered");
    expect(transactions.getObject(active.scope, "customer-2")).toBeUndefined();
  });

  it("publishes every declared event in the same atomic commit", () => {
    const { active, transactions, audit, policies, effects } = runtime("LOW", { emittedEventTypeIds: ["event.customer.created"] });
    const events = new InMemoryEventStream();
    const executor = new OntologyActionExecutor(transactions, audit, policies, effects, undefined, undefined, 100_000, undefined, events);
    const result = executor.execute(request(active));
    expect(result.status).toBe("COMMITTED");
    expect(result.emittedEventIds).toHaveLength(1);
    const published = events.list(active.scope, "req-1");
    expect(published).toHaveLength(1);
    expect(published[0]?.eventTypeId).toBe("event.customer.created");
    expect(published[0]?.payload.actionId).toBe("action.customer.create");
  });

  it("rolls back mutation and event publication when atomic commit fails after events", () => {
    const { active, transactions, audit, policies, effects } = runtime("LOW", { emittedEventTypeIds: ["event.customer.created"] });
    const events = new InMemoryEventStream();
    const atomic = new InMemoryAtomicActionCommitter(transactions, audit, events);
    atomic.injectFailureAfterEventsOnce();
    const executor = new OntologyActionExecutor(transactions, audit, policies, effects, undefined, atomic, 100_000, undefined, events);
    const result = executor.execute(request(active, { requestId: "event-atomic-failure" }));
    expect(result.status).toBe("FAILED");
    expect(transactions.getObject(active.scope, "customer-1")).toBeUndefined();
    expect(events.list(active.scope)).toHaveLength(0);
    expect(audit.list(active.scope).filter((record) => record.decision === "ALLOW")).toHaveLength(0);
  });

  it("isolates policies by tenant organization and brand even when actionId is identical", () => {
    const scopeA = { tenantId: "tenant-a", organizationId: "org-a", brandId: "brand-a" };
    const scopeB = { tenantId: "tenant-b", organizationId: "org-b", brandId: "brand-b" };
    const activeA = schema(scopeA);
    const activeB = schema(scopeB);
    const transactions = new InMemoryOntologyTransactionStore();
    const audit = new InMemoryAuditTrail();
    const policies = new InMemoryActionPolicyRegistry();
    registerPolicy(policies, activeA, "LOW", "tenant-a-policy");
    registerPolicy(policies, activeB, "HIGH", "tenant-b-policy");
    const effects = new InMemoryActionEffectRegistry();
    effects.register("effect.customer.create", { kind: "CREATE_TARGET" });
    const executor = new OntologyActionExecutor(transactions, audit, policies, effects);

    const allowed = executor.execute(request(activeA, { requestId: "a", targetId: "a-1" }));
    const denied = executor.execute(request(activeB, {
      requestId: "b",
      targetId: "b-1",
      principal: { principalId: "user-b", scope: activeB.scope, permissions: ["customer:create"] },
    }));
    expect(allowed.status).toBe("COMMITTED");
    expect(denied.status).toBe("DENIED");
    expect(denied.reason).toContain("approval");
    expect(audit.list(activeA.scope)[0]?.policyVersion).toBe("tenant-a-policy");
    expect(audit.list(activeB.scope)[0]?.policyVersion).toBe("tenant-b-policy");
  });

  it("rejects duplicate policy registration in one scope instead of silently overwriting", () => {
    const active = schema();
    const policies = new InMemoryActionPolicyRegistry();
    registerPolicy(policies, active);
    expect(() => registerPolicy(policies, active, "HIGH", "replacement")).toThrow(/already registered/);
  });

  it("rejects a stale policy when the active action keeps its id but changes definition", () => {
    const original = schema();
    const changed = validateSchema({
      ...original,
      version: "10.1.0",
      actions: [{ ...original.actions[0]!, permission: "customer:create:admin" }],
    });
    const transactions = new InMemoryOntologyTransactionStore();
    const audit = new InMemoryAuditTrail();
    const policies = new InMemoryActionPolicyRegistry();
    registerPolicy(policies, original);
    const effects = new InMemoryActionEffectRegistry();
    effects.register("effect.customer.create", { kind: "CREATE_TARGET" });
    const executor = new OntologyActionExecutor(transactions, audit, policies, effects);
    const result = executor.execute(request(changed, { principal: { principalId: "user-1", scope: changed.scope, permissions: ["customer:create", "customer:create:admin"] } }));
    expect(result.status).toBe("DENIED");
    expect(result.reason).toContain("not bound to the declared action definition");
  });

  it("rejects undeclared input properties instead of allowing foreign writes", () => {
    const { active, transactions, audit, policies, effects } = runtime();
    const executor = new OntologyActionExecutor(transactions, audit, policies, effects);
    const result = executor.execute(request(active, { inputs: { "prop.name": "Ada", "prop.secret": "smuggle" } }));
    expect(result.status).toBe("FAILED");
    expect(result.reason).toContain("not declared by action");
    expect(transactions.getObject(active.scope, "customer-1")).toBeUndefined();
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

  it("rejects reuse of a scoped idempotency key with a different payload", () => {
    const { active, transactions, audit, policies, effects } = runtime();
    const executor = new OntologyActionExecutor(transactions, audit, policies, effects);
    executor.execute(request(active, { requestId: "same-key", targetId: "customer-1" }));
    expect(() => executor.execute(request(active, { requestId: "same-key", targetId: "customer-2" }))).toThrow(ActionExecutionError);
    expect(transactions.getObject(active.scope, "customer-2")).toBeUndefined();
  });

  it("rolls back the mutation if failure is injected after mutation and before ALLOW audit", () => {
    const { active, transactions, audit, policies, effects } = runtime();
    const atomic = new InMemoryAtomicActionCommitter(transactions, audit);
    atomic.injectFailureAfterMutationOnce();
    const executor = new OntologyActionExecutor(transactions, audit, policies, effects, undefined, atomic);
    const result = executor.execute(request(active, { requestId: "atomic-failure" }));
    expect(result.status).toBe("FAILED");
    expect(transactions.getObject(active.scope, "customer-1")).toBeUndefined();
    expect(audit.list(active.scope).filter((record) => record.decision === "ALLOW")).toHaveLength(0);
  });

  it("fails closed when action policy is missing for the exact scope", () => {
    const { active, transactions, audit, effects } = runtime();
    const executor = new OntologyActionExecutor(transactions, audit, new InMemoryActionPolicyRegistry(), effects);
    const result = executor.execute(request(active));
    expect(result.status).toBe("DENIED");
    expect(result.reason).toContain("for this scope");
  });
});
