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
    objects: [
      { id: "object.order", name: "Order", propertyIds: [], interfaceIds: [] }
    ],
    relationships: [],
    actions: [
      {
        id: "action.order.cancel",
        name: "CancelOrder",
        targetTypeId: "object.order",
        inputPropertyIds: [],
        permission: "orders.cancel",
        preconditionRefs: [],
        effectRefs: [],
        emittedEventTypeIds: []
      },
      {
        id: "action.order.refund",
        name: "RefundOrder",
        targetTypeId: "object.order",
        inputPropertyIds: [],
        permission: "orders.refund",
        preconditionRefs: [],
        effectRefs: [],
        emittedEventTypeIds: []
      }
    ],
    functions: [],
    events: []
  };
  return validateSchema(value);
}

function principal(scope = { tenantId: "tenant-a", organizationId: "org-a" }) {
  return { principalId: "agent-user", scope, permissions: ["orders.cancel"] };
}

function request(id: string) {
  return {
    requestId: id,
    principal: principal(),
    scope: schema().scope,
    schema: schema(),
    intent: "Cancel the order",
    allowedActionIds: ["action.order.cancel"],
    maxInputChars: 1000,
  };
}

describe("controlled AI boundary", () => {
  it("returns a non-executable proposal and escalates critical risk to human approval", async () => {
    const provider: AIProviderPort = {
      providerId: "fake-ai",
      propose: async () => ({ actionId: "action.order.cancel", rationale: "customer requested cancellation", risk: "CRITICAL" })
    };
    const boundary = new ControlledAIBoundary(provider);
    const result = await boundary.propose(request("ai-1"));
    expect(result.executable).toBe(false);
    expect(result.requiresHumanApproval).toBe(true);
    expect(result.proposalId).toMatch(/^ai-proposal_[a-f0-9]{64}$/);
  });

  it("rejects actions the provider was not allowed to select", async () => {
    const provider: AIProviderPort = {
      providerId: "fake-ai",
      propose: async () => ({ actionId: "action.order.refund", rationale: "try refund", risk: "LOW" })
    };
    const boundary = new ControlledAIBoundary(provider);
    await expect(boundary.propose(request("ai-2"))).rejects.toThrow(AIBoundaryError);
  });

  it("rejects cross-scope requests before calling the provider", async () => {
    let calls = 0;
    const provider: AIProviderPort = {
      providerId: "fake-ai",
      propose: async () => {
        calls += 1;
        return { actionId: "action.order.cancel", rationale: "cancel", risk: "LOW" };
      }
    };
    const boundary = new ControlledAIBoundary(provider);
    await expect(boundary.propose({
      requestId: "ai-3",
      principal: principal({ tenantId: "tenant-b", organizationId: "org-a" }),
      scope: schema().scope,
      schema: schema(),
      intent: "Cancel",
      allowedActionIds: ["action.order.cancel"],
      maxInputChars: 1000
    })).rejects.toThrow("scopes must match");
    expect(calls).toBe(0);
  });

  it("enforces input budgets and fails closed on provider failure", async () => {
    const provider: AIProviderPort = {
      providerId: "broken-ai",
      propose: async () => { throw new Error("offline"); }
    };
    const boundary = new ControlledAIBoundary(provider);
    await expect(boundary.propose({ ...request("ai-4"), intent: "too long", maxInputChars: 3 })).rejects.toThrow("input budget");
    await expect(boundary.propose({ ...request("ai-5"), intent: "cancel", maxInputChars: 100 })).rejects.toThrow("provider failed");
  });

  it("times out and aborts a slow provider", async () => {
    let observedAbort = false;
    const provider: AIProviderPort = {
      providerId: "slow-ai",
      propose: ({ signal }) => new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          observedAbort = true;
          reject(new Error("aborted"));
        }, { once: true });
      }),
    };
    const boundary = new ControlledAIBoundary(provider, {
      timeoutMs: 5,
      maxRationaleChars: 100,
      maxConsecutiveFailures: 3,
      circuitCooldownMs: 100,
    });
    await expect(boundary.propose(request("ai-timeout"))).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    expect(observedAbort).toBe(true);
  });

  it("honors caller cancellation before invoking the provider", async () => {
    let calls = 0;
    const provider: AIProviderPort = {
      providerId: "fake-ai",
      propose: async () => {
        calls += 1;
        return { actionId: "action.order.cancel", rationale: "cancel", risk: "LOW" };
      },
    };
    const controller = new AbortController();
    controller.abort();
    const boundary = new ControlledAIBoundary(provider);
    await expect(boundary.propose({ ...request("ai-cancel"), signal: controller.signal })).rejects.toMatchObject({ code: "CANCELLED" });
    expect(calls).toBe(0);
  });

  it("opens a circuit after repeated provider failures and recovers after cooldown", async () => {
    let calls = 0;
    let currentTime = 1_000;
    let fail = true;
    const provider: AIProviderPort = {
      providerId: "flaky-ai",
      propose: async () => {
        calls += 1;
        if (fail) throw new Error("offline");
        return { actionId: "action.order.cancel", rationale: "cancel", risk: "LOW" };
      },
    };
    const boundary = new ControlledAIBoundary(provider, {
      timeoutMs: 100,
      maxRationaleChars: 100,
      maxConsecutiveFailures: 2,
      circuitCooldownMs: 50,
    }, () => currentTime);

    await expect(boundary.propose(request("ai-fail-1"))).rejects.toMatchObject({ code: "PROVIDER_FAILURE" });
    await expect(boundary.propose(request("ai-fail-2"))).rejects.toMatchObject({ code: "PROVIDER_FAILURE" });
    await expect(boundary.propose(request("ai-circuit"))).rejects.toMatchObject({ code: "CIRCUIT_OPEN" });
    expect(calls).toBe(2);

    currentTime += 51;
    fail = false;
    await expect(boundary.propose(request("ai-recovered"))).resolves.toMatchObject({ executable: false });
    expect(calls).toBe(3);
  });

  it("rejects oversized provider output", async () => {
    const provider: AIProviderPort = {
      providerId: "verbose-ai",
      propose: async () => ({ actionId: "action.order.cancel", rationale: "x".repeat(11), risk: "LOW" }),
    };
    const boundary = new ControlledAIBoundary(provider, {
      timeoutMs: 100,
      maxRationaleChars: 10,
      maxConsecutiveFailures: 3,
      circuitCooldownMs: 100,
    });
    await expect(boundary.propose(request("ai-output"))).rejects.toMatchObject({ code: "OUTPUT_BUDGET_EXCEEDED" });
  });
});
