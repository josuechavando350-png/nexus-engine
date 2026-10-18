import { describe, expect, it } from "vitest";
import {
  compareRenderPair,
  createRenderObservation,
  parseRenderObservationJson,
  validateRenderDiffAssessment,
  type RenderObservationInput,
} from "./render-diff.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

function observation(overrides: Partial<RenderObservationInput> = {}) {
  return createRenderObservation({
    id: "render-standard",
    tenantId: "tenant-a",
    scopeId: "site:example.com",
    capturedAt: "2026-08-31T04:50:00.000Z",
    url: "https://example.com/",
    profile: "STANDARD_CHROMIUM",
    authority: "CONTROLLED_BROWSER",
    source: "nexus-controlled-browser",
    httpStatus: 200,
    htmlSha256: A,
    visibleTextSha256: B,
    linkSetSha256: C,
    visibleTextLength: 1000,
    linkCount: 20,
    ...overrides,
  });
}

function pair(googlebotOverrides: Partial<RenderObservationInput> = {}) {
  return {
    standard: observation(),
    googlebot: observation({ id: "render-googlebot", profile: "GOOGLEBOT_COMPAT", ...googlebotOverrides }),
  };
}

describe("Googlebot-compatible render diff", () => {
  it("reports equivalent only for matching controlled-browser observations", () => {
    const input = pair();
    const result = compareRenderPair(input);
    expect(result).toMatchObject({ state: "OBSERVED", equivalent: true, issues: [] });
    expect(result.nonClaim).toMatch(/NOT_GOOGLE_CRAWL_INDEXING_OR_RANKING_EVIDENCE/);
    expect(() => validateRenderDiffAssessment({ ...input, assessment: result })).not.toThrow();
  });

  it("fails closed on material visible-content divergence", () => {
    const result = compareRenderPair(pair({ visibleTextSha256: A, visibleTextLength: 600, linkSetSha256: A, linkCount: 8 }));
    expect(result.equivalent).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["VISIBLE_TEXT_DIFF", "LINK_SET_DIFF", "VISIBLE_TEXT_LENGTH_DRIFT", "LINK_COUNT_DRIFT"]));
  });

  it("does not upgrade synthetic observations to observed evidence", () => {
    const result = compareRenderPair(pair({ authority: "SYNTHETIC_TEST" }));
    expect(result.state).toBe("NOT_VERIFIED");
    expect(result.equivalent).toBe(false);
  });

  it("rejects tenant and scope leaks", () => {
    expect(() => compareRenderPair(pair({ tenantId: "tenant-b" }))).toThrow(/tenant mismatch/);
    expect(() => compareRenderPair(pair({ scopeId: "site:other.example" }))).toThrow(/scope mismatch/);
  });

  it("rejects URL mismatch and stale capture pairing", () => {
    expect(() => compareRenderPair(pair({ url: "https://example.com/other" }))).toThrow(/URL mismatch/);
    expect(() => compareRenderPair(pair({ capturedAt: "2026-08-31T05:00:01.000Z" }))).toThrow(/five-minute skew/);
  });

  it("detects replay tampering", () => {
    const input = pair();
    const result = compareRenderPair(input);
    expect(() => validateRenderDiffAssessment({ ...input, assessment: { ...result, equivalent: false } })).toThrow(/replay mismatch|digest mismatch/);
  });

  it("rejects forged observation digests", () => {
    const input = pair();
    const forged = { ...input.googlebot, linkCount: 999 };
    expect(() => compareRenderPair({ standard: input.standard, googlebot: forged })).toThrow(/replay mismatch/);
  });

  it("rejects unknown runtime fields", () => {
    const raw = JSON.stringify({
      id: "x",
      tenantId: "tenant-a",
      scopeId: "site:example.com",
      capturedAt: "2026-08-31T04:50:00.000Z",
      url: "https://example.com/",
      profile: "GOOGLEBOT_COMPAT",
      authority: "CONTROLLED_BROWSER",
      source: "controlled",
      httpStatus: 200,
      htmlSha256: A,
      visibleTextSha256: B,
      linkSetSha256: C,
      visibleTextLength: 10,
      linkCount: 1,
      googleVerified: true,
    });
    expect(() => parseRenderObservationJson(raw)).toThrow(/unknown render observation field googleVerified/);
  });

  it("bounds input metrics", () => {
    expect(() => observation({ visibleTextLength: 10_000_001 })).toThrow(/visibleTextLength/);
    expect(() => observation({ linkCount: 100_001 })).toThrow(/linkCount/);
  });
});
