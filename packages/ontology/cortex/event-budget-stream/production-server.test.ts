import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteDurableEventStream } from "./index";
import { startCortex17Server } from "./production-server";
import type { Cortex17Mode } from "./runtime-control";

const dirs: string[] = [];
const port = 39817;
const origin = `http://127.0.0.1:${port}`;
const writeToken = "w".repeat(32);
const readToken = "r".repeat(32);
function database(): string { const dir = mkdtempSync(join(tmpdir(), "nexus-cortex17-server-")); dirs.push(dir); return join(dir, "events.sqlite"); }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function request(path: string, token: string, payload?: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const encoded = payload === undefined ? undefined : JSON.stringify(payload);
    const req = httpRequest(`${origin}${path}`, { method: payload === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, ...(encoded ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(encoded)) } : {}) } }, (response) => {
      const chunks: Buffer[] = []; response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) as unknown : null }); });
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
  throw new Error("CORTEX #17 server readiness failed");
}

const budget = {
  totalBudget: 1_000,
  maxShiftFraction: 0.2,
  minConfidence: 0.8,
  maxDataAgeMinutes: 60,
  channels: [
    { channel: "search", currentSpend: 500, minSpend: 300, maxSpend: 700, marginalReturn: 2.5, confidence: 0.95, dataAgeMinutes: 10 },
    { channel: "social", currentSpend: 500, minSpend: 300, maxSpend: 700, marginalReturn: 1.2, confidence: 0.9, dataAgeMinutes: 10 },
  ],
} as const;

describe("CORTEX #17 production boundary", () => {
  it("appends idempotent events and exposes them only with read credentials", async () => {
    const db = database(); let mode: Cortex17Mode = "ACTIVE";
    const server = startCortex17Server({ databasePath: db, writeToken, readToken, port, readMode: () => mode });
    try {
      await ready(200);
      const event = { stream: "commerce.events", eventId: "evt-00000001", occurredAt: "2026-09-06T00:00:00.000Z", payload: { revenue: 125.5, currency: "MXN" } };
      expect((await request("/v1/events", readToken, event)).status).toBe(401);
      const first = await request("/v1/events", writeToken, event); expect(first.status).toBe(201);
      const second = await request("/v1/events", writeToken, event); expect(second).toEqual(first);
      expect((await request("/v1/events?stream=commerce.events&after=0&limit=10", writeToken)).status).toBe(401);
      const listed = await request("/v1/events?stream=commerce.events&after=0&limit=10", readToken); expect(listed.status).toBe(200);
      expect(JSON.stringify(listed.body)).toContain("evt-00000001");
      mode = "KILLED"; expect((await request("/v1/events?stream=commerce.events&after=0&limit=10", readToken)).status).toBe(503);
    } finally { await server.close(); }
  });

  it("persists ACTIVE budget decisions but keeps OBSERVE_ONLY decisions side-effect free", async () => {
    const db = database(); let mode: Cortex17Mode = "ACTIVE";
    const server = startCortex17Server({ databasePath: db, writeToken, readToken, port, readMode: () => mode });
    try {
      await ready(200);
      const active = await request("/v1/budget/arbitrate", writeToken, { decisionId: "decision-00000001", occurredAt: "2026-09-06T00:00:00.000Z", input: budget });
      expect(active.status).toBe(200); expect(active.body).toMatchObject({ mode: "ACTIVE", result: { decision: "REALLOCATE" } });
      expect(JSON.stringify(active.body)).toMatch(/"persistedSequence":\d+/u);
      mode = "OBSERVE_ONLY";
      const observed = await request("/v1/budget/arbitrate", writeToken, { decisionId: "decision-00000002", occurredAt: "2026-09-06T00:01:00.000Z", input: budget });
      expect(observed.status).toBe(200); expect(observed.body).toMatchObject({ mode: "OBSERVE_ONLY", result: { decision: "REALLOCATE" }, persistedSequence: null });
      const direct = new SqliteDurableEventStream(db);
      const records = direct.read("budget.arbitration", 0, 10);
      expect(records).toHaveLength(1);
      expect(records[0]?.eventId).toBe("budget-decision-00000001");
      direct.close();
    } finally { await server.close(); }
  });

  it("fails closed when control flips before durable event mutation", async () => {
    const db = database(); let reads = 0;
    const server = startCortex17Server({ databasePath: db, writeToken, readToken, port, readMode: () => (++reads < 2 ? "ACTIVE" : "KILLED") });
    try {
      await ready(200); reads = 0;
      const result = await request("/v1/events", writeToken, { stream: "ads.events", eventId: "evt-00000002", occurredAt: "2026-09-06T00:00:00.000Z", payload: { spend: 10 } });
      expect(result.status).toBe(503);
      const direct = new SqliteDurableEventStream(db); expect(direct.read("ads.events", 0, 10)).toHaveLength(0); direct.close();
    } finally { await server.close(); }
  });
});
