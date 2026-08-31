import { describe, expect, it } from "vitest";
import { createAdvisoryProposal, verifyAdvisoryProposal } from "./provider-boundary.js";

const scope = { tenantId: "tenant-a", organizationId: "org-a", brandId: "brand-a" } as const;

describe("advisory provider boundary", () => {
  it("binds Claude instructions as advisory data, not execution authority", () => {
    const proposal = createAdvisoryProposal({
      scope,
      provider: "ANTHROPIC_CLAUDE",
      instruction: "Recommend a structured content improvement for this page.",
      createdAt: "2026-08-31T14:35:00.000Z",
    });
    expect(proposal.provider).toBe("ANTHROPIC_CLAUDE");
    expect(verifyAdvisoryProposal(proposal)).toBe(true);
    expect("execute" in proposal).toBe(false);
  });

  it("rejects cross-scope or content tampering", () => {
    const proposal = createAdvisoryProposal({
      scope,
      provider: "OPENAI_CHATGPT",
      instruction: "Inspect the proposed change before execution.",
      createdAt: "2026-08-31T14:35:00.000Z",
    });
    expect(verifyAdvisoryProposal({ ...proposal, instruction: "tampered" })).toBe(false);
    expect(verifyAdvisoryProposal({ ...proposal, scope: { ...scope, tenantId: "tenant-b" } })).toBe(false);
  });

  it("fails closed on unsupported provider or non-canonical timestamps", () => {
    expect(() => createAdvisoryProposal({ scope, provider: "OTHER", instruction: "x", createdAt: "2026-08-31T14:35:00Z" })).toThrow(/canonical ISO-8601/u);
    expect(() => createAdvisoryProposal({ scope, provider: "UNKNOWN" as "OTHER", instruction: "x", createdAt: "2026-08-31T14:35:00.000Z" })).toThrow(/unsupported advisory provider/u);
  });
});
