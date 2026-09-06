import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteDurableEventStream } from "../event-budget-stream/index";
import { Cortex18Error, HybridFinancialMetricStore, HttpIncrementalMetricSource, executeDashboardGraphql, type ExternalMetricSource } from "./index";

const dirs: string[] = [];
function temp(name: string): string { const dir = mkdtempSync(join(tmpdir(), `nexus-cortex18-${name}-`)); dirs.push(dir); return join(dir, `${name}.sqlite`); }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const metric = { source: "first-party", eventId: "metric-00000001", occurredAt: "2026-09-06T00:00:00.000Z", currency: "MXN", revenue: 1000, cost: 300, spend: 200, conversions: 2 } as const;

describe("CORTEX #18 hybrid ingestion", () => {
  it("consumes first-party financial events from the durable CORTEX #17 stream with committed offsets", () => {
    const events = new SqliteDurableEventStream(temp("events"));
    events.append({ stream: "financial.metrics", eventId: metric.eventId, occurredAt: metric.occurredAt, payload: metric });
    const store = new HybridFinancialMetricStore(temp("metrics"));
    expect(store.ingestOwnStream(events, "financial.metrics", "dashboard.consumer")).toEqual({ consumed: 1, inserted: 1, offset: 1 });
    expect(store.ingestOwnStream(events, "financial.metrics", "dashboard.consumer")).toEqual({ consumed: 0, inserted: 0, offset: 1 });
    expect(store.summaries()).toEqual([{ currency: "MXN", revenue: 1000, cost: 300, spend: 200, profit: 500, conversions: 2, events: 1 }]);
    store.close(); events.close();
  });

  it("polls external APIs incrementally and advances the cursor only after durable ingestion", async () => {
    const store = new HybridFinancialMetricStore(temp("poll"), () => Date.parse("2026-09-06T00:01:00.000Z"));
    const source: ExternalMetricSource = {
      sourceId: "external-ads",
      poll: vi.fn(async (cursor: string | null) => ({ items: [{ ...metric, source: "external-ads", eventId: cursor ? "metric-00000003" : "metric-00000002" }], nextCursor: cursor ? "cursor-2" : "cursor-1" })),
    };
    expect(await store.pollExternal(source)).toEqual({ received: 1, inserted: 1, nextCursor: "cursor-1" });
    expect(await store.pollExternal(source)).toEqual({ received: 1, inserted: 1, nextCursor: "cursor-2" });
    expect(source.poll).toHaveBeenNthCalledWith(1, null);
    expect(source.poll).toHaveBeenNthCalledWith(2, "cursor-1");
    expect(store.sourceHealth("external-ads").cursor).toBe("cursor-2");
    store.close();
  });

  it("fails idempotency conflicts closed instead of double-counting financial metrics", () => {
    const store = new HybridFinancialMetricStore(temp("conflict"));
    expect(store.ingest(metric)).toBe(true);
    expect(store.ingest(metric)).toBe(false);
    expect(() => store.ingest({ ...metric, revenue: 9999 })).toThrowError(Cortex18Error);
    store.close();
  });
});

describe("CORTEX #18 dashboard GraphQL boundary", () => {
  it("serves consolidated financial and source-health fields without converting currencies implicitly", () => {
    const store = new HybridFinancialMetricStore(temp("graphql"));
    store.ingest(metric);
    store.ingest({ ...metric, source: "external-ads", eventId: "metric-00000002", currency: "USD", revenue: 100, cost: 20, spend: 10, conversions: 1 });
    const result = executeDashboardGraphql(store, "query Dashboard { financialSummary { currency revenue cost spend profit conversions events } sourceHealth { source cursor lastPolledAt status } }", ["external-ads"]);
    const summaries = result.data.financialSummary as { currency: string }[];
    expect(summaries.map((row) => row.currency)).toEqual(["MXN", "USD"]);
    expect(result.data.sourceHealth).toEqual([{ source: "external-ads", cursor: null, lastPolledAt: null, status: "NEVER_POLLED" }]);
    expect(() => executeDashboardGraphql(store, "mutation Nope { financialSummary { revenue } }", [])).toThrowError(/only GraphQL query/u);
    expect(() => executeDashboardGraphql(store, "query { secretField }", [])).toThrowError(/unsupported/u);
    store.close();
  });
});

describe("CORTEX #18 external HTTPS adapter", () => {
  it("uses a fixed HTTPS endpoint and the durable cursor", async () => {
    const fetchMock = vi.fn(async (url: URL) => Response.json({ items: [{ ...metric, source: "external-ads", eventId: "metric-00000004" }], nextCursor: "next-1" }));
    vi.stubGlobal("fetch", fetchMock);
    const source = new HttpIncrementalMetricSource("external-ads", new URL("https://metrics.example/v1/events"), "secret", 1_000);
    expect((await source.poll("cursor-0")).nextCursor).toBe("next-1");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("cursor=cursor-0");
  });

  it("rejects non-HTTPS external sources", () => {
    expect(() => new HttpIncrementalMetricSource("external-ads", new URL("http://metrics.example"), "secret")).toThrowError(/configuration/u);
  });
});
