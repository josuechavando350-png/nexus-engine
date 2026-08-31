import { describe, expect, it, vi } from "vitest";
import { createControlledDataset, type SearchAnalyticsRequest } from "./index";
import { analyzeIntentRadar, verifyIntentRadar, type IntentRadarScope, type IntentRule } from "./intent-radar";
import { runLiveIntentRadar } from "./intent-radar-runtime";

const scope: IntentRadarScope = { tenantId: "tenant-a", organizationId: "org-a", brandId: "brand-a" };
const rules: IntentRule[] = [
  { id: "buy", label: "Commercial", anyTokens: ["buy", "price", "near me"] },
  { id: "compare", label: "Comparison", anyTokens: ["vs", "best"] },
];

function request(startDate: string, endDate: string): SearchAnalyticsRequest {
  return { siteUrl: "sc-domain:example.com", startDate, endDate, dimensions: ["query"], rowLimit: 100 };
}

function controlled(startDate: string, endDate: string, rows: Array<{ query: string; clicks: number; impressions: number; position?: number }>) {
  return createControlledDataset(request(startDate, endDate), rows.map((row) => ({
    keys: [row.query], clicks: row.clicks, impressions: row.impressions,
    ctr: row.impressions === 0 ? 0 : row.clicks / row.impressions, position: row.position ?? 4,
  })));
}

describe("Intent Radar", () => {
  it("produces deterministic synthetic signals from controlled evidence and classifies multi-token rules", () => {
    const baseline = controlled("2026-07-01", "2026-07-31", [{ query: "lawyer near me", clicks: 2, impressions: 20 }]);
    const current = controlled("2026-08-01", "2026-08-31", [
      { query: "lawyer near me", clicks: 8, impressions: 80 },
      { query: "best lawyer", clicks: 4, impressions: 40 },
    ]);
    const report = analyzeIntentRadar({ scope, dataset: current }, { scope, dataset: baseline }, rules);
    expect(report.evidenceState).toBe("SYNTHETIC");
    expect(report.nonClaim).toBe("OBSERVATIONAL_SEARCH_DEMAND_NOT_CAUSAL_OR_MARKET_COMPLETE");
    expect(report.signals.find((signal) => signal.query === "lawyer near me")?.intentIds).toContain("buy");
    expect(report.signals.find((signal) => signal.query === "best lawyer")?.intentIds).toContain("compare");
    expect(verifyIntentRadar({ scope, dataset: current }, { scope, dataset: baseline }, rules, report)).toBe(true);
  });

  it("rejects cross-tenant analysis, overlapping windows and property mismatch", () => {
    const baseline = controlled("2026-07-01", "2026-07-31", [{ query: "a", clicks: 1, impressions: 10 }]);
    const current = controlled("2026-08-01", "2026-08-31", [{ query: "a", clicks: 2, impressions: 20 }]);
    expect(() => analyzeIntentRadar({ scope, dataset: current }, { scope: { ...scope, tenantId: "tenant-b" }, dataset: baseline }, rules)).toThrow(/cross-tenant/);
    const overlap = controlled("2026-08-01", "2026-08-20", [{ query: "a", clicks: 1, impressions: 10 }]);
    expect(() => analyzeIntentRadar({ scope, dataset: current }, { scope, dataset: overlap }, rules)).toThrow(/baseline window/);
    const other = createControlledDataset({ ...request("2026-07-01", "2026-07-31"), siteUrl: "sc-domain:other.example" }, [{ keys: ["a"], clicks: 1, impressions: 10, ctr: 0.1, position: 1 }]);
    expect(() => analyzeIntentRadar({ scope, dataset: current }, { scope, dataset: other }, rules)).toThrow(/same Search Console property/);
  });

  it("detects report and dataset tampering instead of accepting stale provenance", () => {
    const baseline = controlled("2026-07-01", "2026-07-31", [{ query: "price", clicks: 1, impressions: 10 }]);
    const current = controlled("2026-08-01", "2026-08-31", [{ query: "price", clicks: 5, impressions: 50 }]);
    const report = analyzeIntentRadar({ scope, dataset: current }, { scope, dataset: baseline }, rules);
    const tamperedReport = structuredClone(report);
    (tamperedReport.signals[0] as { score: number }).score = 999;
    expect(verifyIntentRadar({ scope, dataset: current }, { scope, dataset: baseline }, rules, tamperedReport)).toBe(false);
    const tamperedDataset = structuredClone(current);
    (tamperedDataset.rows[0] as { impressions: number }).impressions = 500;
    expect(() => analyzeIntentRadar({ scope, dataset: tamperedDataset }, { scope, dataset: baseline }, rules)).toThrow(/replay mismatch/);
  });

  it("reports NOT_ENOUGH_EVIDENCE when no query demand grows", () => {
    const baseline = controlled("2026-07-01", "2026-07-31", [{ query: "price", clicks: 5, impressions: 50 }]);
    const current = controlled("2026-08-01", "2026-08-31", [{ query: "price", clicks: 1, impressions: 10 }]);
    expect(analyzeIntentRadar({ scope, dataset: current }, { scope, dataset: baseline }, rules).evidenceState).toBe("NOT_ENOUGH_EVIDENCE");
  });

  it("does not claim live evidence without credentials", async () => {
    await expect(runLiveIntentRadar({ scope, current: request("2026-08-01", "2026-08-31"), baseline: request("2026-07-01", "2026-07-31"), rules })).resolves.toEqual({ status: "UNAVAILABLE", reason: "Search Console OAuth access token unavailable" });
  });

  it("bounds live execution with cancellation and fails closed on transport failure", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as unknown as typeof fetch;
    const result = await runLiveIntentRadar({ scope, current: request("2026-08-01", "2026-08-31"), baseline: request("2026-07-01", "2026-07-31"), rules, accessToken: "token", timeoutMs: 100, fetchImpl });
    expect(result.status).toBe("FAIL");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
