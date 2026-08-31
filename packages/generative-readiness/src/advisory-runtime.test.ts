import { describe, expect, it } from "vitest";
import { createGovernedAdvisoryRuntime, executeGovernedAdvisory } from "./advisory-runtime.js";
import {
  createAdvisoryApproval,
  createAdvisoryProposal,
  type AdvisoryExecutionRequest,
} from "./provider-boundary.js";
import { digestValue } from "./index.js";

const scope = { tenantId: "tenant-a", organizationId: "org-a", brandId: "brand-a" } as const;
const now = "2026-08-31T14:35:30.000Z";

function makeProposal(instruction = "Recommend a structured content improvement.") {
  return createAdvisoryProposal({
    scope,
    provider: "ANTHROPIC_CLAUDE",
    instruction,
    createdAt: "2026-08-31T14:35:00.000Z",
  });
}

function makeApproval(proposal: ReturnType<typeof makeProposal>) {
  return createAdvisoryApproval({
    status: "APPROVED",
    proposalDigest: proposal.proposalDigest,
    scope,
    approvedAt: "2026-08-31T14:35:10.000Z",
    expiresAt: "2026-08-31T14:40:00.000Z",
  });
}

function allow(request: AdvisoryExecutionRequest) {
  return {
    decision: "ALLOW" as const,
    requestDigest: request.requestDigest,
    authorization: "VERIFIED" as const,
    capability: "ADVISORY_EXECUTION" as const,
    budget: "WITHIN_LIMIT" as const,
    approval: "VERIFIED" as const,
    evidenceDigest: digestValue({ governed: request.requestDigest }),
  };
}

describe("production advisory runtime", () => {
  it("preserves idempotency, terminal outcomes and audit state across entry-point calls", async () => {
    let executorCalls = 0;
    const runtime = createGovernedAdvisoryRuntime({
      policy: { scope, allowedProviders: ["ANTHROPIC_CLAUDE"], maxProposalAgeMs: 60_000, timeoutMs: 100 },
      governance: { async authorize(request) { return allow(request); } },
      executor: {
        async execute(request) {
          executorCalls += 1;
          return {
            status: "COMMITTED" as const,
            requestDigest: request.requestDigest,
            evidenceDigest: digestValue({ committed: request.requestDigest }),
          };
        },
      },
    });

    const proposal = makeProposal();
    const input = { proposal, approval: makeApproval(proposal), idempotencyKey: "persistent-idem", now } as const;
    const first = await executeGovernedAdvisory(runtime, input);
    const second = await executeGovernedAdvisory(runtime, input);

    expect(first).toEqual(second);
    expect(first.status).toBe("COMMITTED");
    expect(executorCalls).toBe(1);
    expect(runtime.auditTrail.length).toBeGreaterThan(0);
    runtime.verifyAuditTrail();

    const changed = makeProposal("A different advisory proposal.");
    await expect(executeGovernedAdvisory(runtime, {
      proposal: changed,
      approval: makeApproval(changed),
      idempotencyKey: "persistent-idem",
      now,
    })).rejects.toThrow(/idempotency key conflict/u);
    expect(executorCalls).toBe(1);
  });

  it("rejects dependency smuggling before constructing the server-side runtime", () => {
    expect(() => createGovernedAdvisoryRuntime({
      policy: { scope, allowedProviders: ["ANTHROPIC_CLAUDE"], maxProposalAgeMs: 60_000, timeoutMs: 100 },
      governance: { async authorize(request: AdvisoryExecutionRequest) { return allow(request); } },
      executor: { async execute(request: AdvisoryExecutionRequest) { return { status: "COMMITTED" as const, requestDigest: request.requestDigest, evidenceDigest: digestValue(request.requestDigest) }; } },
      extraAuthority: true,
    } as never)).toThrow(/unknown or missing fields/u);
  });
});
