import { describe, expect, it } from "vitest";
import { validateSchema, type SchemaVersion } from "./index";
import { InMemoryAuditTrail } from "./auth-audit";
import { ControlledAIBoundary, type AIProviderPort } from "./ai-boundary";
import { InMemoryActionEffectRegistry, InMemoryActionPolicyRegistry, OntologyActionExecutor } from "./action-executor";
import { InMemoryOntologyTransactionStore } from "./transaction";

function schema() {
  const input: SchemaVersion = {
    version: "10.0.0",
    scope: { tenantId: "tenant-a", organizationId: "org-a" },
    properties: [{ id: "prop.name", name: "name", valueKind: "STRING", cardinality: "REQUIRED", unique: false, immutable: false }],
    interfaces: [],
    objects: [{ id: "obj.customer", name: "Customer", propertyIds: ["prop.name"], interfaceIds: [] }],
    relationships: [],
    actions: [{
      id: "action.customer.create",
      name: "CreateCustomer",
      targetTypeId: "obj.customer",
      inputPropertyIds: ["prop.name"],
      permission: "customer:create",
      preconditionRefs: [],
      effectRefs: ["effect.customer.create"],
      emittedEventTypeIds: [],
    }],
    functions: [],
    events: [],
  };
  return validateSchema(input);
}

describe("AI proposal to Action execution boundary", () => {
  it("never lets an AI proposal bypass policy-owned risk or human approval", async () => {
    const active = schema();
    const principal = { principalId: "agent-user", scope: active.scope, permissions: ["customer:create"] };
    const provider: AIProviderPort = {
      providerId: "fake-ai",
      propose: async () => ({
        actionId: "action.customer.create",
        targetId: "customer-ai",
        rationale: "create the requested customer",
        risk: "LOW",
      }),
    };
    const boundary = new ControlledAIBoundary(provider);
    const proposal = await boundary.propose({
      requestId: "ai-e2e-1",
      principal,
      scope: active.scope,
      schema: active,
      intent: "Create Ada",
      allowedActionIds: ["action.customer.create"],
      maxInputChars: 100,
    });
    expect(proposal.executable).toBe(false);
    expect(proposal.risk).toBe("LOW");

    const transactions = new InMemoryOntologyTransactionStore();
    const audit = new InMemoryAuditTrail();
    const policies = new InMemoryActionPolicyRegistry();
    policies.register({
      actionId: proposal.action.id,
      risk: "HIGH",
      requiresHumanApproval: true,
      separationOfDuties: true,
      policyVersion: "policy-v1",
    });
    const effects = new InMemoryActionEffectRegistry();
    effects.register("effect.customer.create", { kind: "CREATE_TARGET" });
    const executor = new OntologyActionExecutor(transactions, audit, policies, effects);

    const result = executor.execute({
      requestId: proposal.requestId,
      occurredAt: "2026-08-16T07:00:00.000Z",
      principal,
      scope: active.scope,
      schema: active,
      actionId: proposal.action.id,
      targetId: proposal.targetId!,
      inputs: { "prop.name": "Ada" },
    });

    expect(result.status).toBe("DENIED");
    expect(result.reason).toContain("approval");
    expect(transactions.getObject(active.scope, "customer-ai")).toBeUndefined();
    expect(audit.list(active.scope)[0]?.risk).toBe("HIGH");
  });
});
