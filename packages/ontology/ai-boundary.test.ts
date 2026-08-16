import { describe, expect, it } from "vitest";
import type { SchemaVersion } from "./index";
import { validateSchema } from "./index";
import { AIBoundaryError, ControlledAIBoundary, type AIProviderPort } from "./ai-boundary";

function schema() {
  const value: SchemaVersion = {
    version: "10.3.0",
    scope: { tenantId: "tenant-a", organizationId: "org-a" },
    properties: [],
    interfaces: [],
    objects: [],
    relationships: [],
    actions: [
      { id: "action.order.cancel", name: "Cancel order", inputPropertyIds: [], permission: "orders.cancel", preconditionRefs: [], effects: [], eventTypeIds: [] },
      { id: "action.order.refund", name: "Refund order", inputPropertyIds: [], permission: "orders.refund", preconditionRefs: [], effects: [], eventTypeIds: [] }
    ],
    functions: [],
    events: []
  };
  return validateSchema(value);
}

function principal(scope = { tenantId: "tenant-a", organizationId: "org-a" }) {
  return { principalId: "agent-user", scope, permissions: ["orders.cancel"] };
}

describe("controlled AI boundary", () => {
  it("returns a non-executable proposal and escalates critical risk to human approval", () => {
    const provider: AIProviderPort = {
      providerId: "fake-ai",
      propose: () => ({ actionId: "action.order.cancel", rationale: "customer requested cancellation", risk: "CRITICAL" })
    };
    const boundary = new ControlledAIBoundary(provider);
    const result = boundary.propose({
      requestId: "ai-1",
      principal: principal(),
      scope: schema().scope,
      schema: schema(),
      intent: "Cancel the order",
      allowedActionIds: ["action.order.cancel"],
      maxInputChars: 1000
    });
    expect(result.executable).toBe(false);
    expect(result.requiresHumanApproval).toBe(true);
    expect(result.proposalId).toMatch(/^ai-proposal_[a-f0-9]{64}$/);
  });

  it("rejects actions the provider was not allowed to select", () => {
    const provider: AIProviderPort = {
      providerId: "fake-ai",
      propose: () => ({ actionId: "action.order.refund", rationale: "try refund", risk: "LOW" })
    };
    const boundary = new ControlledAIBoundary(provider);
    expect(() => boundary.propose({
      requestId: "ai-2",
      principal: principal(),
      scope: schema().scope,
      schema: schema(),
      intent: "Cancel the order",
      allowedActionIds: ["action.order.cancel"],
      maxInputChars: 1000
    })).toThrow(AIBoundaryError);
  });

  it("rejects cross-scope requests before calling the provider", () => {
    let calls = 0;
    const provider: AIProviderPort = {
      providerId: "fake-ai",
      propose: () => {
        calls += 1;
        return { actionId: "action.order.cancel", rationale: "cancel", risk: "LOW" };
      }
    };
    const boundary = new ControlledAIBoundary(provider);
    expect(() => boundary.propose({
      requestId: "ai-3",
      principal: principal({ tenantId: "tenant-b", organizationId: "org-a" }),
      scope: schema().scope,
      schema: schema(),
      intent: "Cancel",
      allowedActionIds: ["action.order.cancel"],
      maxInputChars: 1000
    })).toThrow("scopes must match");
    expect(calls).toBe(0);
  });

  it("enforces input budgets and fails closed on provider failure", () => {
    const provider: AIProviderPort = {
      providerId: "broken-ai",
      propose: () => { throw new Error("offline"); }
    };
    const boundary = new ControlledAIBoundary(provider);
    expect(() => boundary.propose({
      requestId: "ai-4",
      principal: principal(),
      scope: schema().scope,
      schema: schema(),
      intent: "too long",
      allowedActionIds: ["action.order.cancel"],
      maxInputChars: 3
    })).toThrow("input budget");

    expect(() => boundary.propose({
      requestId: "ai-5",
      principal: principal(),
      scope: schema().scope,
      schema: schema(),
      intent: "cancel",
      allowedActionIds: ["action.order.cancel"],
      maxInputChars: 100
    })).toThrow("provider failed");
  });
});
