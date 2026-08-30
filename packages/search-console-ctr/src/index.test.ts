import { describe, expect, it } from "vitest";
import {
  analyzeCtrOpportunities,
  buildMonotonicCtrCurve,
  createControlledDataset,
  fetchSearchAnalytics,
  validateCtrAnalysis,
  validateDataset,
} from "./index.js";

const request = {
  siteUrl: "sc-domain:example.com",
  startDate: "2026-08-01",
  endDate: "2026-08-28",
  dimensions: ["query"] as const,
};

function dataset() {
  return createControlledDataset(request, [
    { keys: ["alpha"], clicks: 40, impressions: 100, ctr: 0.4, position: 1.2 },
    { keys: ["beta"], clicks: 20, impressions: 100, ctr: 0.2, position: 2.1 },
    { keys: ["gamma"], clicks: 25, impressions: 100, ctr: 0.25, position: 3.1 },
    { keys: ["delta"], clicks: 0, impressions: 100, ctr: 0, position: 4.2 },
  ]);
}

describe("Search Console CTR engineering", () => {
  it("builds a deterministic monotonic non-increasing CTR curve", () => {
    const curve = buildMonotonicCtrCurve(dataset());
    for (let index = 1; index < curve.points.length; index += 1) {
      expect(curve.points[index - 1]!.expectedCtr).toBeGreaterThanOrEqual(curve.points[index]!.expectedCtr);
    }
  });

  it("uses weighted PAVA to pool monotonicity violations", () => {
    const curve = buildMonotonicCtrCurve(dataset());
    const position2 = curve.points.find((point) => point.position === 2);
    const position3 = curve.points.find((point) => point.position === 3);
    expect(position2?.expectedCtr).toBeCloseTo(0.225);
    expect(position3?.expectedCtr).toBeCloseTo(0.225);
  });

  it("never produces Infinity when baseline CTR is zero", () => {
    const analysis = analyzeCtrOpportunities(dataset(), 0);
    const zero = analysis.opportunities.find((row) => row.keys[0] === "delta");
    expect(zero?.relativeCtrDelta).toBeNull();
    expect(Number.isFinite(zero?.opportunityClicks ?? Number.NaN)).toBe(true);
  });

  it("marks outputs observational rather than causal", () => {
    expect(analyzeCtrOpportunities(dataset()).nonClaim).toBe("OBSERVATIONAL_NOT_CAUSAL");
  });

  it("replays dataset and analysis and rejects tampering", () => {
    const source = dataset();
    const analysis = analyzeCtrOpportunities(source);
    expect(() => validateDataset(source)).not.toThrow();
    expect(() => validateCtrAnalysis(source, analysis)).not.toThrow();
    expect(() => validateDataset({ ...source, datasetDigest: "f".repeat(64) })).toThrow(/replay mismatch/);
    expect(() => validateCtrAnalysis(source, { ...analysis, datasetDigest: "f".repeat(64) })).toThrow(/dataset mismatch/);
  });

  it("rejects malformed or internally inconsistent API rows", () => {
    expect(() => createControlledDataset(request, [{ keys: ["x"], clicks: 11, impressions: 10, ctr: 1.1, position: 1 }])).toThrow();
    expect(() => createControlledDataset(request, [{ keys: ["x"], clicks: 5, impressions: 10, ctr: 0.1, position: 1 }])).toThrow(/inconsistent/);
    expect(() => createControlledDataset(request, [{ keys: [], clicks: 0, impressions: 0, ctr: 0, position: 1 }])).toThrow(/dimensions/);
  });

  it("enforces documented Search Analytics rowLimit bounds", () => {
    expect(() => createControlledDataset({ ...request, rowLimit: 25_001 }, [])).toThrow(/25000/);
    expect(() => createControlledDataset({ ...request, startRow: -1 }, [])).toThrow(/non-negative/);
    expect(() => createControlledDataset({ ...request, rowLimit: 1 }, [
      { keys: ["x"], clicks: 1, impressions: 10, ctr: 0.1, position: 1 },
      { keys: ["y"], clicks: 1, impressions: 10, ctr: 0.1, position: 2 },
    ])).toThrow(/more rows/);
  });

  it("returns UNAVAILABLE when live OAuth credentials are absent", async () => {
    await expect(fetchSearchAnalytics(request, undefined)).resolves.toEqual({ status: "UNAVAILABLE", reason: "Search Console OAuth access token unavailable" });
  });

  it("uses the official Search Analytics endpoint and accepts validated first-party rows", async () => {
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain("www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ authorization: "Bearer token" });
      return new Response(JSON.stringify({ rows: [{ keys: ["alpha"], clicks: 4, impressions: 10, ctr: 0.4, position: 1.1 }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const result = await fetchSearchAnalytics(request, "token", fakeFetch as typeof fetch);
    expect(result.status).toBe("PASS");
    expect(result.dataset?.sourceAuthority).toBe("SEARCH_CONSOLE_API");
    expect(result.dataset?.coverage).toBe("TOP_ROWS_NOT_GUARANTEED_COMPLETE");
  });

  it("fails closed on provider errors, malformed JSON, and invalid provider payloads", async () => {
    const denied = await fetchSearchAnalytics(request, "token", (async () => new Response("denied", { status: 403 })) as typeof fetch);
    expect(denied.status).toBe("FAIL");
    const invalidJson = await fetchSearchAnalytics(request, "token", (async () => new Response("not-json", { status: 200 })) as typeof fetch);
    expect(invalidJson.status).toBe("FAIL");
    const malformed = await fetchSearchAnalytics(request, "token", (async () => new Response(JSON.stringify({ rows: [{ keys: ["x"], clicks: 2, impressions: 1, ctr: 2, position: 1 }] }), { status: 200 })) as typeof fetch);
    expect(malformed.status).toBe("FAIL");
  });

  it("passes AbortSignal through to the provider boundary", async () => {
    const controller = new AbortController();
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      return new Response(JSON.stringify({ rows: [] }), { status: 200 });
    };
    const result = await fetchSearchAnalytics(request, "token", fakeFetch as typeof fetch, controller.signal);
    expect(result.status).toBe("PASS");
  });
});
