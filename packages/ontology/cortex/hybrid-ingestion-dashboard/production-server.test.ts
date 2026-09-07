import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { HybridFinancialMetricStore, type ExternalMetricSource } from "./index";
import { startCortex18Server } from "./production-server";
import type { Cortex18Mode } from "./runtime-control";

const dirs: string[] = [];
const port = 39818;
function database(): string { const dir = mkdtempSync(join(tmpdir(), "nexus-cortex18-server-")); dirs.push(dir); return join(dir, "metrics.sqlite"); }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const metric = { source: "first-party", eventId: "metric-00000001", occurredAt: "2026-09-06T00:00:00.000Z", currency: "MXN", revenue: 1000.25, cost: 300.1, spend: 200.05, conversions: 2 } as const;

function call(path: string, token: string, value: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const encoded = JSON.stringify(value);
    const req = httpRequest(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(Buffer.byteLength(encoded)) } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> }));
    });
    req.on("error", reject); req.end(encoded);
  });
}
async function waitReady(expected = 200): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const status = await new Promise<number>((resolve, reject) => { const req = httpRequest(`http://127.0.0.1:${port}/healthz`, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode ?? 0)); }); req.on("error", reject); req.end(); });
      if (status === expected) return;
    } catch { /* bounded startup retry */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("CORTEX #18 server did not become ready");
}

describe("CORTEX #18 production server", () => {
  it("persists cent-exact metrics in ACTIVE and serves consolidated dashboard reads", async () => {
    const store = new HybridFinancialMetricStore(database(), () => Date.parse("2026-09-06T00:01:00.000Z")); let mode: Cortex18Mode = "ACTIVE";
    const server = startCortex18Server({ store, sources: new Map(), writeToken: "w".repeat(32), readToken: "r".repeat(32), port, readMode: () => mode });
    try {
      await waitReady();
      expect(await call("/v1/metrics", "w".repeat(32), metric)).toEqual({ status: 200, json: { inserted: true } });
      const query = await call("/v1/dashboard/query", "r".repeat(32), { query: "query Dashboard { financialSummary { currency revenue cost spend profit conversions events } }" });
      expect(query.status).toBe(200);
      expect(query.json.data).toEqual({ financialSummary: [{ currency: "MXN", revenue: 1000.25, cost: 300.1, spend: 200.05, profit: 500.1, conversions: 2, events: 1 }] });
      mode = "OBSERVE_ONLY";
      expect((await call("/v1/dashboard/query", "r".repeat(32), { query: "query Dashboard { financialSummary { currency profit } }" })).status).toBe(200);
      expect((await call("/v1/metrics", "w".repeat(32), { ...metric, eventId: "metric-00000002" })).status).toBe(503);
    } finally { await server.close(); store.close(); }
  });

  it("rolls back an external page and cursor if the kill switch changes before the transaction commits", async () => {
    const store = new HybridFinancialMetricStore(database(), () => Date.parse("2026-09-06T00:01:00.000Z")); let mode: Cortex18Mode = "ACTIVE";
    const source: ExternalMetricSource = { sourceId: "external-ads", async poll() { mode = "KILLED"; return { items: [{ ...metric, source: "external-ads", eventId: "metric-00000002" }], nextCursor: "cursor-1" }; } };
    const server = startCortex18Server({ store, sources: new Map([[source.sourceId, source]]), writeToken: "w".repeat(32), readToken: "r".repeat(32), port, readMode: () => mode });
    try {
      await waitReady();
      const result = await call("/v1/sources/external-ads/poll", "w".repeat(32), {});
      expect(result.status).toBe(503);
      expect(result.json).toEqual({ error: "KILLED" });
      expect(store.sourceHealth("external-ads")).toEqual({ source: "external-ads", cursor: null, lastPolledAt: null, status: "NEVER_POLLED" });
      expect(store.summaries()).toEqual([]);
    } finally { await server.close(); store.close(); }
  });

  it("requires separate authorization for mutation and dashboard reads", async () => {
    const store = new HybridFinancialMetricStore(database()); const server = startCortex18Server({ store, sources: new Map(), writeToken: "w".repeat(32), readToken: "r".repeat(32), port, readMode: () => "ACTIVE" });
    try {
      await waitReady();
      expect((await call("/v1/metrics", "r".repeat(32), metric)).status).toBe(401);
      expect((await call("/v1/dashboard/query", "w".repeat(32), { query: "query Dashboard { financialSummary { currency } }" })).status).toBe(401);
    } finally { await server.close(); store.close(); }
  });
});
