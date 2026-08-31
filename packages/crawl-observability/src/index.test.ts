import { describe, expect, it } from "vitest";
import {
  assessCrawl,
  createDataset,
  createObservation,
  parseObservationJsonLine,
  validateAssessment,
  validateDataset,
  validateObservation,
} from "./index.js";

const base = {
  userAgent: "Googlebot/2.1 (+http://www.google.com/bot.html)",
  actor: "SEARCH_BOT" as const,
  authority: "SERVER_ACCESS_LOG" as const,
  source: "s3://edge-access/2026-08-30.ndjson",
};

function dataset(overrides: Array<Record<string, unknown>> = []) {
  const rows = [
    { id: "r1", observedAt: "2026-08-30T10:00:00Z", url: "https://example.com/", status: 200, responseTimeMs: 120 },
    { id: "r2", observedAt: "2026-08-30T10:01:00Z", url: "https://example.com/about", status: 200, responseTimeMs: 180 },
    { id: "r3", observedAt: "2026-08-30T10:02:00Z", url: "https://example.com/contact", status: 200, responseTimeMs: 220 },
  ].map((row, index) => ({ ...base, ...row, ...(overrides[index] ?? {}) }));
  return createDataset({ site: "https://example.com", windowStart: "2026-08-30T09:00:00Z", windowEnd: "2026-08-30T11:00:00Z", observations: rows });
}

describe("crawl observability", () => {
  it("creates and replays READY evidence from observed server requests", () => {
    const input = dataset();
    validateDataset(input);
    const assessment = assessCrawl(input);
    expect(assessment.status).toBe("READY");
    expect(assessment.summary.searchBotRequests).toBe(3);
    expect(assessment.nonClaim).toContain("NOT_SEARCH_ENGINE_INDEXING_OR_RANKING_EVIDENCE");
    validateAssessment(input, assessment);
  });

  it("blocks observed search-bot 5xx without converting absence into success", () => {
    const input = dataset([{ status: 503 }]);
    const assessment = assessCrawl(input);
    expect(assessment.status).toBe("BLOCKED");
    expect(assessment.issues.some((issue) => issue.code === "SEARCH_BOT_5XX")).toBe(true);
  });

  it("reports insufficient evidence for too few observed search-bot requests", () => {
    const input = createDataset({
      site: "https://example.com",
      windowStart: "2026-08-30T09:00:00Z",
      windowEnd: "2026-08-30T11:00:00Z",
      observations: [{ ...base, id: "one", observedAt: "2026-08-30T10:00:00Z", url: "https://example.com/", status: 200 }],
    });
    expect(assessCrawl(input).status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("fails closed on an observed 5xx even when evidence volume is sparse", () => {
    const input = createDataset({
      site: "https://example.com",
      windowStart: "2026-08-30T09:00:00Z",
      windowEnd: "2026-08-30T11:00:00Z",
      observations: [{ ...base, id: "sparse-5xx", observedAt: "2026-08-30T10:00:00Z", url: "https://example.com/", status: 503 }],
    });
    const assessment = assessCrawl(input);
    expect(assessment.status).toBe("BLOCKED");
    expect(assessment.issues.some((issue) => issue.code === "SEARCH_BOT_5XX" && issue.severity === "ERROR")).toBe(true);
  });

  it("detects redirect chains and loops", () => {
    const input = dataset([
      { status: 301, redirectLocation: "https://example.com/a" },
      { url: "https://example.com/a", status: 302, redirectLocation: "https://example.com/b" },
      { url: "https://example.com/b", status: 302, redirectLocation: "https://example.com/" },
    ]);
    const assessment = assessCrawl(input);
    expect(assessment.status).toBe("BLOCKED");
    expect(assessment.issues.some((issue) => issue.code === "SEARCH_BOT_REDIRECT_CHAIN" && issue.severity === "ERROR")).toBe(true);
  });

  it("rejects tampered observation, dataset and assessment evidence", () => {
    const observation = createObservation({ ...base, id: "x", observedAt: "2026-08-30T10:00:00Z", url: "https://example.com/", status: 200 });
    expect(() => validateObservation({ ...observation, status: 500 })).toThrow(/digest mismatch/);
    const input = dataset();
    expect(() => validateDataset({ ...input, datasetDigest: "0".repeat(64) })).toThrow(/digest mismatch/);
    const assessment = assessCrawl(input);
    expect(() => validateAssessment(input, { ...assessment, status: "READY", assessmentDigest: "f".repeat(64) })).toThrow(/digest mismatch/);
  });

  it("rejects cross-origin rows, duplicate ids, out-of-window observations and credentials", () => {
    expect(() => createDataset({ site: "https://example.com", windowStart: "2026-08-30T09:00:00Z", windowEnd: "2026-08-30T11:00:00Z", observations: [
      { ...base, id: "x", observedAt: "2026-08-30T10:00:00Z", url: "https://evil.example/path", status: 200 },
    ] })).toThrow(/cross-origin/);
    expect(() => createDataset({ site: "https://example.com", windowStart: "2026-08-30T09:00:00Z", windowEnd: "2026-08-30T11:00:00Z", observations: [
      { ...base, id: "x", observedAt: "2026-08-30T10:00:00Z", url: "https://example.com/1", status: 200 },
      { ...base, id: "x", observedAt: "2026-08-30T10:01:00Z", url: "https://example.com/2", status: 200 },
    ] })).toThrow(/duplicate/);
    expect(() => createObservation({ ...base, id: "x", observedAt: "2026-08-30T12:00:00Z", url: "https://user:pass@example.com/", status: 200 })).toThrow(/credentials/);
    expect(() => createDataset({ site: "https://example.com", windowStart: "2026-08-30T09:00:00Z", windowEnd: "2026-08-30T11:00:00Z", observations: [
      { ...base, id: "x", observedAt: "2026-08-30T12:00:00Z", url: "https://example.com/", status: 200 },
    ] })).toThrow(/outside dataset window/);
  });

  it("fails closed on malformed JSON-lines and unknown fields", () => {
    expect(() => parseObservationJsonLine("not json")).toThrow();
    expect(() => parseObservationJsonLine(JSON.stringify({ ...base, id: "x", observedAt: "2026-08-30T10:00:00Z", url: "https://example.com/", status: 200, surprise: true }))).toThrow(/unknown observation field/);
  });

  it("bounds timing, status and redirect semantics", () => {
    expect(() => createObservation({ ...base, id: "x", observedAt: "2026-08-30T10:00:00Z", url: "https://example.com/", status: 700 })).toThrow(/HTTP status/);
    expect(() => createObservation({ ...base, id: "x", observedAt: "2026-08-30T10:00:00Z", url: "https://example.com/", status: 200, responseTimeMs: 999_999 })).toThrow(/responseTimeMs/);
    expect(() => createObservation({ ...base, id: "x", observedAt: "2026-08-30T10:00:00Z", url: "https://example.com/", status: 200, redirectLocation: "https://example.com/new" })).toThrow(/3xx/);
  });
});
