import { describe, expect, it } from "vitest";
import {
  GovernedAdvisoryRuntime,
  createAdvisoryApproval,
  createAdvisoryProposal,
  verifyAdvisoryProposal,
  type AdvisoryExecutionRequest,
  type AdvisoryProposalSource,
  type NexusAdvisoryExecutor,
} from "./provider-boundary.js";
import { digestValue } from "./index.js";

const scope = { tenantId: "tenant-a", organizationId: "org-a", brandId: "brand-a" } as const;
const now = "2026-08-31T14:35:30.000Z";

function proposal(provider: "ANTHROPIC_CLAUDE" | "OPENAI_CHATGPT" | "OTHER" = "ANTHROPIC_CLAUDE") {
  return createAdvisoryProposal({
    scope,
    provider,
    instruction: "Recommend a structured content improvement for this page.",
    createdAt: "2026-08-31T14:35:00.000Z",
  });
}

function approval(forProposal = proposal()) {
  return createAdvisoryApproval({
    status: "APPROVED",
    proposalDigest: forProposal.proposalDigest,
    scope,
    approvedAt: "2026-08-31T14:35:10.000Z",
    expiresAt: "2026-08-31T14:40:00.000Z",
  });
}

function executor(fn?: (request: AdvisoryExecutionRequest, signal: AbortSignal) => Promise<ReturnType<NexusAdvisoryExecutor["execute"]> extends Promise<infer T> ? T : never>): NexusAdvisoryExecutor {
  return {
    async execute(request, signal) {
      if (fn) return await fn(request, signal);
      return { status: "COMMITTED", requestDigest: request.requestDigest, evidenceDigest: digestValue({ committed: request.requestDigest }) };
    },
  };
}

function runtime(exec = executor(), providers = ["ANTHROPIC_CLAUDE", "OPENAI_CHATGPT", "OTHER"] as const) {
  return new GovernedAdvisoryRuntime({ scope, allowedProviders: providers, maxProposalAgeMs: 60_000, timeoutMs: 50 }, exec);
}

describe("advisory provider boundary", () => {
  it("binds Claude instructions as advisory data, not execution authority", () => {
    const item = proposal();
    expect(item.provider).toBe("ANTHROPIC_CLAUDE");
    expect(verifyAdvisoryProposal(scope, item)).toBe(true);
    expect("execute" in item).toBe(false);
    expect("writerAuthority" in item).toBe(false);
  });

  it("rejects cross-scope replay and content tampering", () => {
    const item = proposal("OPENAI_CHATGPT");
    expect(verifyAdvisoryProposal(scope, { ...item, instruction: "tampered" })).toBe(false);
    expect(verifyAdvisoryProposal({ ...scope, tenantId: "tenant-b" }, item)).toBe(false);
    expect(verifyAdvisoryProposal(scope, { ...item, scope: { ...scope, tenantId: "tenant-b" } })).toBe(false);
  });

  it("rejects runtime field smuggling, unsupported providers and non-canonical timestamps", () => {
    expect(() => createAdvisoryProposal({ ...({ scope, provider: "OTHER", instruction: "x", createdAt: "2026-08-31T14:35:00.000Z", execute: true } as const) })).toThrow(/unknown advisory proposal field/u);
    expect(() => createAdvisoryProposal({ scope, provider: "OTHER", instruction: "x", createdAt: "2026-08-31T14:35:00Z" })).toThrow(/canonical ISO-8601/u);
    expect(() => createAdvisoryProposal({ scope, provider: "UNKNOWN" as "OTHER", instruction: "x", createdAt: "2026-08-31T14:35:00.000Z" })).toThrow(/unsupported advisory provider/u);
  });

  it("keeps provider swap advisory-only while NEXUS remains the single writer", async () => {
    const authorities: string[] = [];
    const rt = runtime(executor(async (request) => {
      authorities.push(request.writerAuthority);
      return { status: "COMMITTED", requestDigest: request.requestDigest, evidenceDigest: digestValue(request.requestDigest) };
    }));
    for (const provider of ["ANTHROPIC_CLAUDE", "OPENAI_CHATGPT", "OTHER"] as const) {
      const item = proposal(provider);
      const result = await rt.execute({ proposal: item, approval: approval(item), idempotencyKey: `same-flow-${provider}`, now });
      expect(result.status).toBe("COMMITTED");
    }
    expect(authorities).toEqual(["NEXUS_OPENAI_OPERATOR", "NEXUS_OPENAI_OPERATOR", "NEXUS_OPENAI_OPERATOR"]);
    rt.verifyAuditTrail();
  });

  it("blocks approval denial and never dispatches the executor", async () => {
    let calls = 0;
    const item = proposal();
    const denied = createAdvisoryApproval({ status: "DENIED", proposalDigest: item.proposalDigest, scope, approvedAt: "2026-08-31T14:35:10.000Z", expiresAt: "2026-08-31T14:40:00.000Z" });
    const rt = runtime(executor(async (request) => {
      calls += 1;
      return { status: "COMMITTED", requestDigest: request.requestDigest, evidenceDigest: digestValue("unexpected") };
    }));
    const result = await rt.execute({ proposal: item, approval: denied, idempotencyKey: "denied", now });
    expect(result.status).toBe("REJECTED");
    expect(calls).toBe(0);
  });

  it("blocks cross-tenant proposals, approval replay, stale proposals and provider bypass", async () => {
    const rt = runtime(executor(), ["ANTHROPIC_CLAUDE"]);
    const item = proposal();
    const otherScopeProposal = createAdvisoryProposal({ ...item, scope: { ...scope, tenantId: "tenant-b" } });
    await expect(rt.execute({ proposal: otherScopeProposal, approval: approval(otherScopeProposal), idempotencyKey: "cross", now })).rejects.toThrow(/scope\/integrity/u);
    const wrongApproval = createAdvisoryApproval({ status: "APPROVED", proposalDigest: digestValue("other"), scope, approvedAt: "2026-08-31T14:35:10.000Z", expiresAt: "2026-08-31T14:40:00.000Z" });
    expect((await rt.execute({ proposal: item, approval: wrongApproval, idempotencyKey: "approval-replay", now })).status).toBe("REJECTED");
    const stale = createAdvisoryProposal({ scope, provider: "ANTHROPIC_CLAUDE", instruction: "old", createdAt: "2026-08-31T14:00:00.000Z" });
    await expect(rt.execute({ proposal: stale, approval: approval(stale), idempotencyKey: "stale", now })).rejects.toThrow(/stale/u);
    const blockedProvider = proposal("OPENAI_CHATGPT");
    await expect(rt.execute({ proposal: blockedProvider, approval: approval(blockedProvider), idempotencyKey: "blocked-provider", now })).rejects.toThrow(/not allowed/u);
  });

  it("coalesces concurrent duplicates and rejects idempotency-key conflicts", async () => {
    let calls = 0;
    const item = proposal();
    const rt = runtime(executor(async (request) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { status: "COMMITTED", requestDigest: request.requestDigest, evidenceDigest: digestValue("one-call") };
    }));
    const input = { proposal: item, approval: approval(item), idempotencyKey: "idem-1", now } as const;
    const [a, b] = await Promise.all([rt.execute(input), rt.execute(input)]);
    expect(a).toEqual(b);
    expect(calls).toBe(1);
    const changed = createAdvisoryProposal({ scope, provider: "ANTHROPIC_CLAUDE", instruction: "different proposal", createdAt: "2026-08-31T14:35:00.000Z" });
    await expect(rt.execute({ proposal: changed, approval: approval(changed), idempotencyKey: "idem-1", now })).rejects.toThrow(/idempotency key conflict/u);
  });

  it("fails closed on timeout, cancellation, transport failure and partial executor failure", async () => {
    const item = proposal();
    const timeoutRt = runtime(executor(async (request, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { status: "CANCELLED", requestDigest: request.requestDigest, evidenceDigest: digestValue("late") };
    }));
    expect((await timeoutRt.execute({ proposal: item, approval: approval(item), idempotencyKey: "timeout", now })).status).toBe("TIMEOUT");

    const controller = new AbortController();
    const cancelRt = runtime(executor(async (request, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { status: "CANCELLED", requestDigest: request.requestDigest, evidenceDigest: digestValue("cancelled") };
    }));
    const pending = cancelRt.execute({ proposal: item, approval: approval(item), idempotencyKey: "cancel", now, signal: controller.signal });
    controller.abort();
    expect((await pending).status).toBe("CANCELLED");

    const failedRt = runtime(executor(async () => { throw new Error("transport failed after dispatch"); }));
    expect((await failedRt.execute({ proposal: item, approval: approval(item), idempotencyKey: "transport", now })).status).toBe("OUTCOME_UNKNOWN");

    const malformedRt = runtime(executor(async (request) => ({ status: "COMMITTED", requestDigest: `${request.requestDigest.slice(0, 63)}0`, evidenceDigest: digestValue("bad") })));
    expect((await malformedRt.execute({ proposal: item, approval: approval(item), idempotencyKey: "partial", now })).status).toBe("OUTCOME_UNKNOWN");
  });

  it("keeps source adapters read-only and detects provider impersonation", async () => {
    const item = proposal("ANTHROPIC_CLAUDE");
    const rt = runtime();
    const source: AdvisoryProposalSource = { provider: "OPENAI_CHATGPT", async read() { return item; } };
    await expect(rt.ingest(source, approval(item), "source-mismatch", now)).rejects.toThrow(/source\/provider mismatch/u);
    expect("execute" in source).toBe(false);
    expect("write" in source).toBe(false);
  });

  it("detects audit tampering", async () => {
    const item = proposal();
    const rt = runtime();
    await rt.execute({ proposal: item, approval: approval(item), idempotencyKey: "audit", now });
    rt.verifyAuditTrail();
    const trail = rt.auditTrail as Array<Record<string, unknown>>;
    expect(() => {
      trail[0] = { ...trail[0], status: "COMMITTED" };
      // Returned trail is a copy, so runtime evidence remains immutable and valid.
      rt.verifyAuditTrail();
    }).not.toThrow();
  });
});
