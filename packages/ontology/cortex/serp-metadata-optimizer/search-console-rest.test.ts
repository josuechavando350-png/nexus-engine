import { describe, expect, it } from "vitest";
import { SearchConsoleApiError, SearchConsoleRestClient } from "./search-console-rest";

const SITE = "https://example.com/";
const PAGE = "https://example.com/legal";
const NOW = Date.parse("2026-09-05T05:00:00.000Z");

interface FetchCall { readonly url: string; readonly init: RequestInit | undefined }
type FetchStep = Response | Error | ((call: FetchCall) => Response | Promise<Response>);

function response(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } });
}

function sequence(steps: readonly FetchStep[]) {
  const calls: FetchCall[] = [];
  let index = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    const step = steps[index++];
    if (!step) throw new Error(`unexpected fetch ${index}`);
    if (step instanceof Error) throw step;
    return typeof step === "function" ? await step(call) : step;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function body(call: FetchCall): Record<string, unknown> {
  if (typeof call.init?.body !== "string") throw new Error("expected JSON body");
  return JSON.parse(call.init.body) as Record<string, unknown>;
}

function client(steps: readonly FetchStep[], options: { readonly maxReadRetries?: number; readonly sleep?: (ms: number) => Promise<void> } = {}) {
  const s = sequence(steps);
  const rest = new SearchConsoleRestClient({
    accessTokenProvider: async () => "oauth-token",
    fetchImpl: s.fetchImpl,
    maxReadRetries: options.maxReadRetries ?? 0,
    sleep: options.sleep,
    now: () => NOW,
  });
  return { rest, calls: s.calls };
}

function pageRow(url: string, clicks: number, impressions: number, position: number) {
  return { keys: [url], clicks, impressions, ctr: impressions > 0 ? clicks / impressions : 0, position };
}

function queryRow(query: string, clicks: number, impressions: number, position: number) {
  return { keys: [PAGE, query], clicks, impressions, ctr: impressions > 0 ? clicks / impressions : 0, position };
}

describe("SearchConsoleRestClient", () => {
  it("uses the current Search Analytics endpoint, OAuth, final web data and exact target-page query filter", async () => {
    const { rest, calls } = client([
      response({ rows: [pageRow(PAGE, 20, 1_000, 5), pageRow("https://example.com/peer", 50, 1_000, 5.2)] }),
      response({ rows: [queryRow("federal criminal defense", 12, 600, 5), queryRow("criminal defense", 8, 400, 5)] }),
    ]);
    const result = await rest.getPerformance({ siteUrl: SITE, pageUrl: PAGE, startDate: "2026-08-01", endDate: "2026-08-28", maxRows: 100 });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/searchAnalytics/query");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe("Bearer oauth-token");
    expect(body(calls[0]!)).toMatchObject({ startDate: "2026-08-01", endDate: "2026-08-28", type: "web", dataState: "final", aggregationType: "auto", dimensions: ["page"], startRow: 0 });
    expect(body(calls[1]!)).toMatchObject({
      type: "web", dataState: "final", dimensions: ["page", "query"], startRow: 0,
      dimensionFilterGroups: [{ groupType: "and", filters: [{ dimension: "page", operator: "equals", expression: PAGE }] }],
    });
    expect(result.dataState).toBe("FINAL");
    expect(result.coverage).toBe("TOP_ROWS_BOUNDED");
    expect(result.truncated).toBe(false);
    expect(result.pageRows).toHaveLength(2);
    expect(result.targetQueryRows[0]?.query).toBe("federal criminal defense");
  });

  it("respects the configured total row budget and marks a full bounded result as truncated", async () => {
    const { rest, calls } = client([
      response({ rows: [pageRow(PAGE, 1, 10, 5), pageRow("https://example.com/a", 1, 10, 5), pageRow("https://example.com/b", 1, 10, 5)] }),
      response({ rows: [queryRow("alpha", 1, 10, 5), queryRow("beta", 1, 10, 5), queryRow("gamma", 1, 10, 5)] }),
    ]);
    const result = await rest.getPerformance({ siteUrl: SITE, pageUrl: PAGE, startDate: "2026-08-01", endDate: "2026-08-28", maxRows: 6 });
    expect(calls).toHaveLength(2);
    expect(body(calls[0]!)).toMatchObject({ rowLimit: 3, startRow: 0 });
    expect(body(calls[1]!)).toMatchObject({ rowLimit: 3, startRow: 0 });
    expect(result.pageRows.length + result.targetQueryRows.length).toBe(6);
    expect(result.truncated).toBe(true);
  });

  it("uses Search Console's 25,000-row page cap and advances startRow on larger budgets", async () => {
    const firstPage = Array.from({ length: 25_000 }, (_, index) => pageRow(index === 0 ? PAGE : `https://example.com/page-${index}`, 0, 1, 5));
    const { rest, calls } = client([
      response({ rows: firstPage }),
      response({ rows: [pageRow("https://example.com/page-25000", 0, 1, 5)] }),
      response({ rows: [queryRow("alpha", 1, 10, 5)] }),
    ]);
    const result = await rest.getPerformance({ siteUrl: SITE, pageUrl: PAGE, startDate: "2026-08-01", endDate: "2026-08-28", maxRows: 50_002 });
    expect(calls).toHaveLength(3);
    expect(body(calls[0]!)).toMatchObject({ rowLimit: 25_000, startRow: 0 });
    expect(body(calls[1]!)).toMatchObject({ rowLimit: 1, startRow: 25_000 });
    expect(body(calls[2]!)).toMatchObject({ rowLimit: 25_000, startRow: 0 });
    expect(result.pageRows).toHaveLength(25_001);
    expect(result.targetQueryRows).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("retries bounded quota failures using Retry-After only because Search Console operations are reads", async () => {
    const sleeps: number[] = [];
    const { rest, calls } = client([
      response({ error: { status: "RESOURCE_EXHAUSTED", message: "quota" } }, 429, { "retry-after": "2" }),
      response({ rows: [pageRow(PAGE, 20, 1_000, 5)] }),
      response({ rows: [queryRow("federal defense", 20, 1_000, 5)] }),
    ], { maxReadRetries: 1, sleep: async (ms) => { sleeps.push(ms); } });
    const result = await rest.getPerformance({ siteUrl: SITE, pageUrl: PAGE, startDate: "2026-08-01", endDate: "2026-08-28", maxRows: 20 });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([2_000]);
    expect(result.pageRows[0]?.impressions).toBe(1_000);
  });

  it("classifies authentication and malformed responses without inventing rows", async () => {
    const auth = client([response({ error: { status: "PERMISSION_DENIED", message: "denied" } }, 403)]);
    await expect(auth.rest.getPerformance({ siteUrl: SITE, pageUrl: PAGE, startDate: "2026-08-01", endDate: "2026-08-28", maxRows: 20 })).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });

    const malformed = client([response({ rows: [{ keys: [PAGE], clicks: "20", impressions: 1_000, ctr: 0.02, position: 5 }] })]);
    await expect(malformed.rest.getPerformance({ siteUrl: SITE, pageUrl: PAGE, startDate: "2026-08-01", endDate: "2026-08-28", maxRows: 20 })).rejects.toBeInstanceOf(SearchConsoleApiError);
  });

  it("surfaces final transport exhaustion as API_ERROR and never retries beyond configured bounds", async () => {
    const sleeps: number[] = [];
    const { rest, calls } = client([new TypeError("network"), new TypeError("network")], { maxReadRetries: 1, sleep: async (ms) => { sleeps.push(ms); } });
    await expect(rest.getPerformance({ siteUrl: SITE, pageUrl: PAGE, startDate: "2026-08-01", endDate: "2026-08-28", maxRows: 20 })).rejects.toMatchObject({ code: "API_ERROR" });
    expect(calls).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
  });
});
