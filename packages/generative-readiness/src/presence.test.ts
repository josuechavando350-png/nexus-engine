import { describe, expect, it } from "vitest";
import { createPage, type GenerativePageInput } from "./index.js";
import { assessGenerativePresence, verifyGenerativePresence } from "./presence.js";
import { runGenerativePresence } from "./presence-runtime.js";

const scope = { tenantId: "tenant-a", organizationId: "org-a", brandId: "brand-a" } as const;

function pageInput(): GenerativePageInput {
  return {
    url: "https://example.com/guide",
    title: "Evidence-led guide",
    description: "A useful page grounded in explicit evidence and first-party experience.",
    language: "es-MX",
    modifiedDate: "2026-08-29T00:00:00.000Z",
    indexable: true,
    crawlAllowed: true,
    snippet: "FULL",
    sections: [{ id: "overview", heading: "Overview", text: "Documented findings in context.", claimIds: ["claim-1"], dataNoSnippet: false }],
    entities: [{ id: "entity-1", name: "NEXUS", type: "SoftwareApplication", description: "A deterministic web engineering and evidence system." }],
    evidence: [{ id: "e-first", kind: "FIRST_PARTY_DATA", source: "internal analytics export" }],
    claims: [{ id: "claim-1", text: "The measurement comes from first-party data.", kind: "FACT", evidenceIds: ["e-first"], volatile: false }],
    questions: ["What evidence supports the claim?", "Who produced the source?", "When was the page updated?", "What is original here?"],
    originalContributions: [
      { id: "o1", description: "A reproducible comparison built from first-party measurements and documented methodology.", evidenceIds: ["e-first"] },
      { id: "o2", description: "A second evidence-linked contribution documenting a distinct first-party finding in detail.", evidenceIds: ["e-first"] },
    ],
    media: [{ url: "https://example.com/chart.png", context: "Chart showing the measured first-party comparison described in the page." }],
  };
}

describe("generative presence", () => {
  it("binds readiness to tenant scope without claiming provider visibility", () => {
    const page = createPage(pageInput());
    const report = assessGenerativePresence(scope, page, "2026-08-30T00:00:00.000Z");
    expect(report.externalVisibilityState).toBe("NOT_VERIFIED");
    expect(report.nonClaim).toBe("READINESS_NOT_PROVIDER_VISIBILITY_CITATION_RANKING_OR_TRAFFIC");
    expect(verifyGenerativePresence(scope, page, report)).toBe(true);
  });

  it("fails cross-tenant replay and report tampering", () => {
    const page = createPage(pageInput());
    const report = assessGenerativePresence(scope, page, "2026-08-30T00:00:00.000Z");
    expect(verifyGenerativePresence({ ...scope, tenantId: "tenant-b" }, page, report)).toBe(false);
    expect(verifyGenerativePresence(scope, page, { ...report, pageDigest: "a".repeat(64) })).toBe(false);
  });

  it("supports honest unavailable external visibility state", () => {
    const report = runGenerativePresence({ scope, page: pageInput(), observedAt: "2026-08-30T00:00:00.000Z", externalVisibilityState: "UNAVAILABLE" });
    expect(report.externalVisibilityState).toBe("UNAVAILABLE");
  });

  it("rejects unknown scope fields and non-canonical observation timestamps", () => {
    const page = createPage(pageInput());
    expect(() => assessGenerativePresence({ ...scope, extra: "x" } as typeof scope, page, "2026-08-30T00:00:00.000Z")).toThrow(/unknown presence scope field/u);
    expect(() => assessGenerativePresence(scope, page, "2026-08-30T00:00:00Z")).toThrow(/canonical ISO-8601/u);
  });

  it("honors cancellation before evaluation", () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    expect(() => runGenerativePresence({ scope, page: pageInput(), observedAt: "2026-08-30T00:00:00.000Z" }, controller.signal)).toThrow(/cancelled/u);
  });
});
