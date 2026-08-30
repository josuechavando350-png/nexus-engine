import { describe, expect, it } from "vitest";
import {
  assess,
  createPage,
  dataNoSnippetSectionIds,
  digestValue,
  robotsSnippetControls,
  validatePage,
  validateReadiness,
  type GenerativePageInput,
} from "./index.js";

function input(overrides: Partial<GenerativePageInput> = {}): GenerativePageInput {
  const evidence = [
    { id: "e-first", kind: "FIRST_PARTY_DATA" as const, source: "internal analytics export" },
    { id: "e-primary", kind: "PRIMARY_SOURCE" as const, source: "https://example.com/research" },
  ];
  return {
    url: "https://example.com/guide",
    title: "Evidence-led guide",
    description: "A useful page grounded in explicit evidence and first-party experience.",
    language: "es-MX",
    modifiedDate: "2026-08-29T00:00:00Z",
    indexable: true,
    crawlAllowed: true,
    snippet: "FULL",
    sections: [
      { id: "overview", heading: "Overview", text: "This section explains the documented findings in context.", claimIds: ["claim-1", "claim-2"], dataNoSnippet: false },
    ],
    entities: [
      { id: "entity-1", name: "NEXUS", type: "SoftwareApplication", description: "A deterministic web engineering and evidence system." },
      { id: "entity-2", name: "Search", type: "Thing", sameAs: ["https://www.google.com/search/about/"] },
    ],
    evidence,
    claims: [
      { id: "claim-1", text: "The measurement comes from first-party data.", kind: "FACT", evidenceIds: ["e-first"], volatile: false },
      { id: "claim-2", text: "The supporting research is linked directly.", kind: "FACT", evidenceIds: ["e-primary"], volatile: false },
    ],
    questions: ["What evidence supports the claim?", "Who produced the source?", "When was the page updated?", "What is original here?"],
    originalContributions: [
      { id: "o1", description: "A reproducible comparison built from the site's own observed measurements and methodology.", evidenceIds: ["e-first"] },
      { id: "o2", description: "A second evidence-linked contribution that documents a distinct first-party finding in sufficient detail.", evidenceIds: ["e-primary"] },
    ],
    media: [{ url: "https://example.com/chart.png", context: "Chart showing the measured first-party comparison described in the page." }],
    ...overrides,
  };
}

describe("generative readiness", () => {
  it("creates canonical deterministic pages and readiness evidence", () => {
    const page = createPage(input());
    const result = assess(page, "2026-08-30T00:00:00Z");
    expect(result.status).toBe("READY");
    expect(result.score).toBeGreaterThanOrEqual(0.75);
    expect(() => validatePage(page)).not.toThrow();
    expect(() => validateReadiness(page, result)).not.toThrow();
    expect(createPage(input()).pageDigest).toBe(page.pageDigest);
  });

  it("blocks pages that cannot qualify for Search supporting links", () => {
    expect(assess(createPage(input({ crawlAllowed: false })), "2026-08-30T00:00:00Z").status).toBe("BLOCKED");
    const noSnippet = assess(createPage(input({ snippet: "NONE" })), "2026-08-30T00:00:00Z");
    expect(noSnippet.status).toBe("BLOCKED");
    expect(noSnippet.issues.map((issue) => issue.code)).toContain("SNIPPET_DISABLED");
  });

  it("treats max-snippet and data-nosnippet as real limiting controls", () => {
    const maxSnippetPage = createPage(input({ snippet: { maxChars: 120 } }));
    expect(robotsSnippetControls(maxSnippetPage)).toEqual(["max-snippet:120"]);
    expect(assess(maxSnippetPage, "2026-08-30T00:00:00Z").status).toBe("LIMITED");

    const sectionLimited = createPage(input({ sections: [{ id: "private", heading: "Private detail", text: "This text remains visible to people but is excluded from snippets.", claimIds: ["claim-1"], dataNoSnippet: true }] }));
    expect(dataNoSnippetSectionIds(sectionLimited)).toEqual(["private"]);
    expect(assess(sectionLimited, "2026-08-30T00:00:00Z").status).toBe("LIMITED");
  });

  it("does not award perfect evidence metrics to empty content", () => {
    const page = createPage(input({ sections: [], entities: [], evidence: [], claims: [], questions: [], originalContributions: [], media: [] }));
    const result = assess(page, "2026-08-30T00:00:00Z");
    expect(result.status).toBe("NEEDS_WORK");
    expect(result.metrics.evidenceCoverage).toBe(0);
    expect(result.metrics.primaryEvidenceCoverage).toBe(0);
    expect(result.metrics.entityClarity).toBe(0);
  });

  it("rejects dangling evidence and claim references", () => {
    expect(() => createPage(input({ claims: [{ id: "claim-1", text: "Unsupported", kind: "FACT", evidenceIds: ["missing"], volatile: false }] }))).toThrow(/unknown evidence/);
    expect(() => createPage(input({ sections: [{ id: "s", heading: "H", text: "T", claimIds: ["missing"], dataNoSnippet: false }] }))).toThrow(/unknown claim/);
  });

  it("rejects duplicate ids and unsafe URLs", () => {
    expect(() => createPage(input({ evidence: [
      { id: "dup", kind: "PRIMARY_SOURCE", source: "a" },
      { id: "dup", kind: "FIRST_PARTY_DATA", source: "b" },
    ] }))).toThrow(/duplicate ids/);
    expect(() => createPage(input({ url: "javascript:alert(1)" }))).toThrow(/HTTP/);
    expect(() => createPage(input({ media: [{ url: "https://user:secret@example.com/x.png", context: "Enough context to be useful for the media item." }] }))).toThrow(/credentials/);
  });

  it("fails closed on stale volatile claims", () => {
    const page = createPage(input({
      modifiedDate: "2025-01-01T00:00:00Z",
      claims: [
        { id: "claim-1", text: "This value changes over time.", kind: "FACT", evidenceIds: ["e-first"], volatile: true },
        { id: "claim-2", text: "The supporting research is linked directly.", kind: "FACT", evidenceIds: ["e-primary"], volatile: false },
      ],
    }));
    const result = assess(page, "2026-08-30T00:00:00Z");
    expect(result.metrics.freshnessCoverage).toBe(0);
    expect(result.issues.map((issue) => issue.code)).toContain("STALE_VOLATILE_CONTENT");
  });

  it("rejects future modified dates beyond clock-skew allowance", () => {
    const page = createPage(input({ modifiedDate: "2026-09-01T00:00:00Z" }));
    expect(() => assess(page, "2026-08-30T00:00:00Z")).toThrow(/postdate/);
  });

  it("rejects attacker-rehashed noncanonical page state", () => {
    const page = createPage(input());
    const forgedCore = { ...page, title: "Forged title" };
    const { pageDigest: _old, ...core } = forgedCore;
    const forged = { ...forgedCore, pageDigest: digestValue(core) };
    expect(() => validatePage(forged)).toThrow(/canonical|digest/);
  });

  it("rejects forged readiness even when its digest is recomputed", () => {
    const page = createPage(input());
    const result = assess(page, "2026-08-30T00:00:00Z");
    const forgedCore = { ...result, status: "BLOCKED" as const };
    const { readinessDigest: _old, ...core } = forgedCore;
    const forged = { ...forgedCore, readinessDigest: digestValue(core) };
    expect(() => validateReadiness(page, forged)).toThrow(/replay mismatch/);
  });

  it("enforces hard collection budgets", () => {
    const questions = Array.from({ length: 251 }, (_, index) => `Question number ${index}?`);
    expect(() => createPage(input({ questions }))).toThrow(/exceeds 250/);
  });
});
