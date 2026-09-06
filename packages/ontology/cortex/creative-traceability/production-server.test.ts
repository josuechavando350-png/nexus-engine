import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteCreativeTraceRegistry, verifyCreativeTrace } from "./index";
import { startCortex16Server } from "./production-server";
import type { Cortex16Mode } from "./runtime-control";

const dirs: string[] = [];
const port = 39816;
const origin = `http://127.0.0.1:${port}`;
const writeToken = "w".repeat(32);
const readToken = "r".repeat(32);
const signingSecret = "s".repeat(32);
function database(): string { const dir = mkdtempSync(join(tmpdir(), "nexus-cortex16-server-")); dirs.push(dir); return join(dir, "trace.sqlite"); }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type RegisterResponse = { record: { traceKey: string; manifestDigest: `sha256:${string}` }; signedTrace: unknown };
type ResolveResponse = { result: Record<string, unknown> };

function request<T = unknown>(path: string, token: string, payload?: unknown): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    const encoded = payload === undefined ? undefined : JSON.stringify(payload);
    const req = httpRequest(`${origin}${path}`, { method: payload === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, ...(encoded ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(encoded)) } : {}) } }, (response) => {
      const chunks: Buffer[] = []; response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); resolve({ status: response.statusCode ?? 0, body: (text ? JSON.parse(text) : null) as T }); });
    });
    req.on("error", reject); if (encoded) req.write(encoded); req.end();
  });
}
async function ready(expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { if ((await request("/healthz", readToken)).status === expected) return; } catch { /* bounded startup retry */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("CORTEX #16 server readiness failed");
}

const creativeA = { creativeId: "creative-alpha", version: "version-0001", assetDigests: [`sha256:${"a".repeat(64)}`], deploymentKeys: ["campaign-0001"], activatedAt: "2026-09-06T00:00:00.000Z" } as const;
const creativeB = { creativeId: "creative-beta", version: "version-0001", assetDigests: [`sha256:${"b".repeat(64)}`], deploymentKeys: ["campaign-0002"], activatedAt: "2026-09-06T00:00:00.000Z" } as const;

describe("CORTEX #16 production traceability boundary", () => {
  it("registers signed immutable traces and preserves ambiguity under aggregation", async () => {
    const registry = new SqliteCreativeTraceRegistry(database()); let mode: Cortex16Mode = "ACTIVE";
    const server = startCortex16Server({ registry, writeToken, readToken, signingSecret, port, readMode: () => mode });
    try {
      await ready(200);
      const a = await request<RegisterResponse>("/v1/creatives/register", writeToken, creativeA); const b = await request<RegisterResponse>("/v1/creatives/register", writeToken, creativeB);
      expect(a.status).toBe(201); expect(b.status).toBe(201);
      expect(verifyCreativeTrace(a.body.signedTrace, signingSecret)).toEqual({ traceKey: a.body.record.traceKey, manifestDigest: a.body.record.manifestDigest });
      const exact = await request<ResolveResponse>("/v1/aggregates/resolve", readToken, { aggregationId: "aggregate-0001", metric: "conversions", value: 12, traceKeys: [a.body.record.traceKey] });
      expect(exact.body.result).toMatchObject({ resolution: "EXACT", creativeIds: ["creative-alpha"], value: 12 });
      const ambiguous = await request<ResolveResponse>("/v1/aggregates/resolve", readToken, { aggregationId: "aggregate-0002", metric: "conversions", value: 30, traceKeys: [a.body.record.traceKey, b.body.record.traceKey] });
      expect(ambiguous.body.result).toMatchObject({ resolution: "AMBIGUOUS_SET", creativeIds: ["creative-alpha", "creative-beta"], value: 30 });
      expect(ambiguous.body.result).not.toHaveProperty("allocation");
      mode = "OBSERVE_ONLY";
      expect((await request("/v1/creatives/register", writeToken, { ...creativeA, version: "version-0002" })).status).toBe(503);
      expect((await request("/v1/aggregates/resolve", readToken, { aggregationId: "aggregate-0003", metric: "clicks", value: 4, traceKeys: [a.body.record.traceKey] })).status).toBe(200);
      mode = "KILLED"; expect((await request("/v1/aggregates/resolve", readToken, { aggregationId: "aggregate-0004", metric: "clicks", value: 1, traceKeys: [a.body.record.traceKey] })).status).toBe(503);
    } finally { await server.close(); registry.close(); }
  });

  it("rechecks control immediately before registry mutation", async () => {
    const registry = new SqliteCreativeTraceRegistry(database()); let reads = 0;
    const server = startCortex16Server({ registry, writeToken, readToken, signingSecret, port, readMode: () => (++reads < 2 ? "ACTIVE" : "KILLED") });
    try {
      await ready(200); reads = 0;
      expect((await request("/v1/creatives/register", writeToken, creativeA)).status).toBe(503);
      expect(registry.resolveAggregate({ aggregationId: "aggregate-0005", metric: "clicks", value: 1, traceKeys: ["nxc16-unknown-000000000001"] }).resolution).toBe("UNRESOLVED");
    } finally { await server.close(); registry.close(); }
  });
});
