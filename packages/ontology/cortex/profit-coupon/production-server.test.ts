import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteCouponIssuer } from "./index";
import { startCortex19Server } from "./production-server";
import type { Cortex19Mode } from "./runtime-control";

const dirs: string[] = [];
const port = 39819;
function database(): string { const dir = mkdtempSync(join(tmpdir(), "nexus-cortex19-server-")); dirs.push(dir); return join(dir, "coupon.sqlite"); }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const modelDigest = `sha256:${"b".repeat(64)}`;
const requestBody = {
  request: {
    requestId: "coupon-request-0001",
    subjectHash: `sha256:${"a".repeat(64)}`,
    sku: "product-00000001",
    price: 1000,
    variableCost: 500,
    currency: "MXN",
    eligible: true,
    probabilityEvidence: { probability: 0.2, modelId: "friction-model-0001", modelDigest },
  },
} as const;
const policy = {
  minProfitAmount: 300,
  maxDiscountBps: 2000,
  maxCouponsPerWindow: 5,
  maxDiscountCostPerWindow: 1000,
  frequencyWindowSeconds: 3600,
  tiers: [{ probabilityAtOrBelow: 0.3, discountBps: 1000 }],
} as const;

function call(body: unknown, token = "a".repeat(32)): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const encoded = JSON.stringify(body);
    const req = httpRequest(`http://127.0.0.1:${port}/v1/coupons/issue`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(Buffer.byteLength(encoded)) } }, (response) => {
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
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(`http://127.0.0.1:${port}/healthz`, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode ?? 0)); }); req.on("error", reject); req.end();
      });
      if (status === expected) return;
    } catch { /* bounded startup retry */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("CORTEX #19 server did not become ready");
}

describe("CORTEX #19 production HTTP boundary", () => {
  it("uses server-owned policy and approved model provenance before issuing a real code", async () => {
    const db = database(); let mode: Cortex19Mode = "ACTIVE";
    const issuer = new SqliteCouponIssuer(db, "s".repeat(32), () => mode, () => Date.parse("2026-09-06T00:00:00.000Z"));
    const server = startCortex19Server({ issuer, apiToken: "a".repeat(32), policy, allowedModelDigests: new Map([["friction-model-0001", modelDigest]]), port, readMode: () => mode });
    try {
      await waitReady();
      const result = await call(requestBody);
      expect(result.status).toBe(200);
      expect(result.json.mode).toBe("ACTIVE");
      expect(result.json.result).toMatchObject({ action: "OFFER", reason: "OFFER_ALLOWED", code: expect.stringMatching(/^NX-/u) });
    } finally { await server.close(); issuer.close(); }
  });

  it("rejects unapproved model provenance even when the digest is syntactically valid", async () => {
    const db = database(); let mode: Cortex19Mode = "ACTIVE";
    const issuer = new SqliteCouponIssuer(db, "s".repeat(32), () => mode);
    const server = startCortex19Server({ issuer, apiToken: "a".repeat(32), policy, allowedModelDigests: new Map([["friction-model-0001", modelDigest]]), port, readMode: () => mode });
    try {
      await waitReady();
      const result = await call({ request: { ...requestBody.request, probabilityEvidence: { ...requestBody.request.probabilityEvidence, modelDigest: `sha256:${"c".repeat(64)}` } } });
      expect(result.status).toBe(400);
      expect(result.json).toEqual({ error: "INVALID_INPUT" });
    } finally { await server.close(); issuer.close(); }
  });

  it("keeps OBSERVE_ONLY side-effect-free and fails closed in KILLED", async () => {
    const db = database(); let mode: Cortex19Mode = "OBSERVE_ONLY";
    const issuer = new SqliteCouponIssuer(db, "s".repeat(32), () => mode);
    const server = startCortex19Server({ issuer, apiToken: "a".repeat(32), policy, allowedModelDigests: new Map([["friction-model-0001", modelDigest]]), port, readMode: () => mode });
    try {
      await waitReady();
      const observed = await call(requestBody);
      expect(observed.status).toBe(200);
      expect(observed.json.result).toMatchObject({ action: "OFFER", code: null });
      mode = "ACTIVE";
      const active = await call(requestBody);
      expect(active.status).toBe(200);
      expect(active.json.result).toMatchObject({ action: "OFFER", code: expect.stringMatching(/^NX-/u) });
      mode = "KILLED";
      const killed = await call({ request: { ...requestBody.request, requestId: "coupon-request-0002" } });
      expect(killed.status).toBe(503);
      expect(killed.json).toEqual({ error: "KILLED" });
    } finally { await server.close(); issuer.close(); }
  });

  it("requires the API credential", async () => {
    const db = database(); const issuer = new SqliteCouponIssuer(db, "s".repeat(32), () => "ACTIVE");
    const server = startCortex19Server({ issuer, apiToken: "a".repeat(32), policy, allowedModelDigests: new Map([["friction-model-0001", modelDigest]]), port, readMode: () => "ACTIVE" });
    try { await waitReady(); expect((await call(requestBody, "wrong".repeat(8))).status).toBe(401); }
    finally { await server.close(); issuer.close(); }
  });
});
