import { describe, expect, it } from "vitest";
import {
  GovernedAdvisoryRuntime,
  createAdvisoryApproval,
  createAdvisoryProposal,
  verifyAdvisoryProposal,
  type AdvisoryExecutionOutcome,
  type AdvisoryExecutionRequest,
  type AdvisoryGovernanceDecision,
  type AdvisoryProposalSource,
  type AdvisoryProvider,
  type NexusAdvisoryExecutor,
  type NexusAdvisoryGovernancePort,
} from "./provider-boundary.js";
import { digestValue } from "./index.js";

const scope = { tenantId: "tenant-a", organizationId: "org-a", brandId: "brand-a" } as const;
const now = "2026-08-31T14:35:30.000Z";

function proposal(provider: AdvisoryProvider = "ANTHROPIC_CLAUDE") {
  return createAdvisoryProposal({ scope, provider, instruction: "Recommend a structured content improvement.", createdAt: "2026-08-31T14:35:00.000Z" });
}
function approval(item = proposal()) {
  return createAdvisoryApproval({ status: "APPROVED", proposalDigest: item.proposalDigest, scope, approvedAt: "2026-08-31T14:35:10.000Z", expiresAt: "2026-08-31T14:40:00.000Z" });
}
function allowDecision(request: AdvisoryExecutionRequest): AdvisoryGovernanceDecision {
  return { decision: "ALLOW", requestDigest: request.requestDigest, authorization: "VERIFIED", capability: "ADVISORY_EXECUTION", budget: "WITHIN_LIMIT", approval: "VERIFIED", evidenceDigest: digestValue({ governed: request.requestDigest }) };
}
function governance(fn?: (request: AdvisoryExecutionRequest, now: string, signal: AbortSignal) => Promise<AdvisoryGovernanceDecision>): NexusAdvisoryGovernancePort {
  return { async authorize(request, instant, signal) { return fn ? await fn(request, instant, signal) : allowDecision(request); } };
}
function executor(fn?: (request: AdvisoryExecutionRequest, signal: AbortSignal) => Promise<AdvisoryExecutionOutcome>): NexusAdvisoryExecutor {
  return { async execute(request, signal) { return fn ? await fn(request, signal) : { status: "COMMITTED", requestDigest: request.requestDigest, evidenceDigest: digestValue({ committed: request.requestDigest }) }; } };
}
function runtime(gov = governance(), exec = executor(), providers: readonly AdvisoryProvider[] = ["ANTHROPIC_CLAUDE", "OPENAI_CHATGPT", "OTHER"]) {
  return new GovernedAdvisoryRuntime({ scope, allowedProviders: providers, maxProposalAgeMs: 60_000, timeoutMs: 30 }, gov, exec);
}

describe("provider-neutral advisory boundary", () => {
  it("keeps every model advisory-only while NEXUS remains the sole writer", async () => {
    const authorities: string[] = [];
    const rt = runtime(governance(), executor(async (request) => {
      authorities.push(request.writerAuthority);
      return { status: "COMMITTED", requestDigest: request.requestDigest, evidenceDigest: digestValue(request.requestDigest) };
    }));
    for (const provider of ["ANTHROPIC_CLAUDE", "OPENAI_CHATGPT", "OTHER"] as const) {
      const item = proposal(provider);
      expect("execute" in item).toBe(false);
      expect((await rt.execute({ proposal: item, approval: approval(item), idempotencyKey: `provider-${provider}`, now })).status).toBe("COMMITTED");
    }
    expect(authorities).toEqual(["NEXUS_OPENAI_OPERATOR", "NEXUS_OPENAI_OPERATOR", "NEXUS_OPENAI_OPERATOR"]);
    rt.verifyAuditTrail();
  });

  it("rejects tamper, cross-tenant, stale and provider-bypass attempts", async () => {
    const item = proposal();
    expect(verifyAdvisoryProposal(scope, { ...item, instruction: "tampered" })).toBe(false);
    expect(verifyAdvisoryProposal({ ...scope, tenantId: "tenant-b" }, item)).toBe(false);
    const rt = runtime(governance(), executor(), ["ANTHROPIC_CLAUDE"]);
    const cross = createAdvisoryProposal({ scope: { ...scope, tenantId: "tenant-b" }, provider: item.provider, instruction: item.instruction, createdAt: item.createdAt });
    await expect(rt.execute({ proposal: cross, approval: approval(cross), idempotencyKey: "cross", now })).rejects.toThrow(/scope\/integrity/u);
    const stale = createAdvisoryProposal({ scope, provider: "ANTHROPIC_CLAUDE", instruction: "old", createdAt: "2026-08-31T14:00:00.000Z" });
    await expect(rt.execute({ proposal: stale, approval: approval(stale), idempotencyKey: "stale", now })).rejects.toThrow(/stale/u);
    const blocked = proposal("OPENAI_CHATGPT");
    await expect(rt.execute({ proposal: blocked, approval: approval(blocked), idempotencyKey: "blocked", now })).rejects.toThrow(/not allowed/u);
  });

  it("fails closed before governance when preliminary approval is denied or replayed", async () => {
    let governanceCalls = 0;
    let executorCalls = 0;
    const item = proposal();
    const rt = runtime(governance(async (request) => { governanceCalls += 1; return allowDecision(request); }), executor(async (request) => { executorCalls += 1; return { status: "COMMITTED", requestDigest: request.requestDigest, evidenceDigest: digestValue("unexpected") }; }));
    const denied = createAdvisoryApproval({ status: "DENIED", proposalDigest: item.proposalDigest, scope, approvedAt: "2026-08-31T14:35:10.000Z", expiresAt: "2026-08-31T14:40:00.000Z" });
    expect((await rt.execute({ proposal: item, approval: denied, idempotencyKey: "denied", now })).status).toBe("REJECTED");
    const replay = createAdvisoryApproval({ status: "APPROVED", proposalDigest: digestValue("other"), scope, approvedAt: "2026-08-31T14:35:10.000Z", expiresAt: "2026-08-31T14:40:00.000Z" });
    expect((await rt.execute({ proposal: item, approval: replay, idempotencyKey: "replay", now })).status).toBe("REJECTED");
    expect(governanceCalls).toBe(0);
    expect(executorCalls).toBe(0);
  });

  it("requires authorization, capability, budget and authoritative approval before dispatch", async () => {
    const denied: AdvisoryGovernanceDecision[] = [
      { decision: "DENY", requestDigest: "", authorization: "DENIED", capability: "ADVISORY_EXECUTION", budget: "WITHIN_LIMIT", approval: "VERIFIED", evidenceDigest: digestValue("auth") },
      { decision: "DENY", requestDigest: "", authorization: "VERIFIED", capability: "DENIED", budget: "WITHIN_LIMIT", approval: "VERIFIED", evidenceDigest: digestValue("cap") },
      { decision: "DENY", requestDigest: "", authorization: "VERIFIED", capability: "ADVISORY_EXECUTION", budget: "EXCEEDED", approval: "VERIFIED", evidenceDigest: digestValue("budget") },
      { decision: "DENY", requestDigest: "", authorization: "VERIFIED", capability: "ADVISORY_EXECUTION", budget: "WITHIN_LIMIT", approval: "DENIED", evidenceDigest: digestValue("approval") },
    ];
    for (const [index, template] of denied.entries()) {
      let calls = 0;
      const item = proposal();
      const rt = runtime(governance(async (request) => ({ ...template, requestDigest: request.requestDigest })), executor(async (request) => { calls += 1; return { status: "COMMITTED", requestDigest: request.requestDigest, evidenceDigest: digestValue("bad") }; }));
      expect((await rt.execute({ proposal: item, approval: approval(item), idempotencyKey: `governance-${index}`, now })).status).toBe("REJECTED");
      expect(calls).toBe(0);
    }
  });

  it("treats governance transport, malformed binding, timeout and cancellation as non-executable", async () => {
    const item = proposal();
    let executorCalls = 0;
    const exec = executor(async (request) => { executorCalls += 1; return { status: "COMMITTED", requestDigest: request.requestDigest, evidenceDigest: digestValue("bad") }; });
    expect((await runtime(governance(async () => { throw new Error("transport"); }), exec).execute({ proposal: item, approval: approval(item), idempotencyKey: "gov-transport", now })).status).toBe("UNAVAILABLE");
    expect((await runtime(governance(async (request) => ({ ...allowDecision(request), requestDigest: digestValue("wrong") })), exec).execute({ proposal: item, approval: approval(item), idempotencyKey: "gov-malformed", now })).status).toBe("UNAVAILABLE");
    expect((await runtime(governance(async (request, _instant, signal) => { await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); return allowDecision(request); }), exec).execute({ proposal: item, approval: approval(item), idempotencyKey: "gov-timeout", now })).status).toBe("TIMEOUT");
    const controller = new AbortController();
    controller.abort();
    expect((await runtime(governance(), exec).execute({ proposal: item, approval: approval(item), idempotencyKey: "gov-cancel", now, signal: controller.signal })).status).toBe("CANCELLED");
    expect(executorCalls).toBe(0);
  });

  it("coalesces concurrent duplicates and rejects idempotency conflicts", async () => {
    let calls = 0;
    const item = proposal();
    const rt = runtime(governance(), executor(async (request) => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return { status: "COMMITTED", requestDigest: request.requestDigest, evidenceDigest: digestValue("once") }; }));
    const input = { proposal: item, approval: approval(item), idempotencyKey: "idem", now } as const;
    const [a, b] = await Promise.all([rt.execute(input), rt.execute(input)]);
    expect(a).toEqual(b);
    expect(calls).toBe(1);
    const changed = createAdvisoryProposal({ scope, provider: "ANTHROPIC_CLAUDE", instruction: "different", createdAt: "2026-08-31T14:35:00.000Z" });
    await expect(rt.execute({ proposal: changed, approval: approval(changed), idempotencyKey: "idem", now })).rejects.toThrow(/idempotency key conflict/u);
  });

  it("reports post-dispatch transport/partial/timeout/cancellation failures as outcome unknown", async () => {
    const item = proposal();
    expect((await runtime(governance(), executor(async () => { throw new Error("transport after dispatch"); })).execute({ proposal: item, approval: approval(item), idempotencyKey: "transport", now })).status).toBe("OUTCOME_UNKNOWN");
    expect((await runtime(governance(), executor(async (request) => ({ status: "COMMITTED", requestDigest: digestValue(request.requestDigest), evidenceDigest: digestValue("bad") }))).execute({ proposal: item, approval: approval(item), idempotencyKey: "partial", now })).status).toBe("OUTCOME_UNKNOWN");
    expect((await runtime(governance(), executor(async (request, signal) => { await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); return { status: "CANCELLED", requestDigest: request.requestDigest, evidenceDigest: digestValue("late") }; })).execute({ proposal: item, approval: approval(item), idempotencyKey: "timeout-after-dispatch", now })).status).toBe("OUTCOME_UNKNOWN");
    const controller = new AbortController();
    const rt = runtime(governance(), executor(async (request, signal) => { await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); return { status: "CANCELLED", requestDigest: request.requestDigest, evidenceDigest: digestValue("cancel") }; }));
    const pending = rt.execute({ proposal: item, approval: approval(item), idempotencyKey: "cancel", now, signal: controller.signal });
    setTimeout(() => controller.abort(), 0);
    expect((await pending).status).toBe("OUTCOME_UNKNOWN");
  });

  it("keeps source adapters read-only and rejects provider impersonation", async () => {
    const item = proposal("ANTHROPIC_CLAUDE");
    const source: AdvisoryProposalSource = { provider: "OPENAI_CHATGPT", async read() { return item; } };
    await expect(runtime().ingest(source, approval(item), "source", now)).rejects.toThrow(/source\/provider mismatch/u);
    expect("execute" in source).toBe(false);
    expect("authorize" in source).toBe(false);
    expect("write" in source).toBe(false);
  });
});
