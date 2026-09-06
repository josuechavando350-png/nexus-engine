import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeRiskNetworkKeyHash, signRiskPayload } from "./index";
import { fixedUpstreamTarget, normalizeRemoteAddress, readBoundedUpstreamBody, startCortex14RiskProxy, type Cortex14RiskProxyConfig } from "./production-server";
import type { RiskGateMode } from "./runtime-control";

const port = 39814;
const origin = `http://127.0.0.1:${port}`;
const signingSecret = "s".repeat(32);
const networkSecret = "n".repeat(32);
const policy = { challengeAtOrAbove: 500, denyAtOrAbove: 800, maxAssessmentAgeSeconds: 300, maxFutureSkewSeconds: 30 } as const;
let mode: RiskGateMode;

function envelope(riskScore: number, networkAddress = "127.0.0.1") {
  const now = Date.now();
  return signRiskPayload({
    schemaVersion: 1,
    assessmentId: `assessment-${String(riskScore).padStart(8, "0")}`,
    providerId: "provider-00000001",
    assessedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 120_000).toISOString(),
    riskScore,
    networkKeyHash: computeRiskNetworkKeyHash(networkAddress, networkSecret),
  }, signingSecret);
}

function encodedEnvelope(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function trustedProxySignature(asserted: string): string {
  return `sha256=${createHmac("sha256", networkSecret).update(`client-network\0${asserted}`, "utf8").digest("hex")}`;
}

function config(overrides: Partial<Cortex14RiskProxyConfig> = {}): Cortex14RiskProxyConfig {
  return {
    signingSecret,
    networkSecret,
    policy,
    upstreamOrigin: "https://upstream.example/",
    port,
    readMode: () => mode,
    ...overrides,
  };
}

function request(path: string, headers: Record<string, string> = {}, method = "GET", body?: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${origin}${path}`, { method, headers: { ...headers, ...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}) } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitReady(expectedStatus = 200): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const result = await request("/healthz");
      if (result.status === expectedStatus) return;
    } catch {
      // bounded startup retry
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("CORTEX #14 test server did not become ready");
}

beforeEach(() => { mode = "ACTIVE"; });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("CORTEX #14 production proxy helpers", () => {
  it("normalizes IPv4-mapped addresses and rejects missing network identity", () => {
    expect(normalizeRemoteAddress("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeRemoteAddress("127.0.0.1")).toBe("127.0.0.1");
    expect(() => normalizeRemoteAddress(undefined)).toThrowError(/unavailable/u);
  });

  it("keeps the configured HTTPS authority even for protocol-relative-looking paths", () => {
    const target = fixedUpstreamTarget(new URL("https://upstream.example/"), "//attacker.invalid/steal?x=1");
    expect(target.origin).toBe("https://upstream.example");
    expect(target.pathname).toBe("//attacker.invalid/steal");
    expect(target.search).toBe("?x=1");
  });

  it("rejects declared and streamed upstream responses above the configured bound", async () => {
    const declared = new Response("x", { headers: { "content-length": "2049" } });
    await expect(readBoundedUpstreamBody(declared, 2048)).rejects.toThrow(/TOO_LARGE/u);
    const streamed = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1025)); controller.close(); } }));
    await expect(readBoundedUpstreamBody(streamed, 1024)).rejects.toThrow(/TOO_LARGE/u);
  });
});

describe("CORTEX #14 production risk enforcement", () => {
  it("forwards a valid low-risk request only to the fixed upstream and strips spoofable forwarding/risk headers", async () => {
    const upstreamFetch = vi.fn(async (_url: URL | string, _init?: RequestInit) => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }));
    vi.stubGlobal("fetch", upstreamFetch);
    const server = startCortex14RiskProxy(config());
    try {
      await waitReady();
      const result = await request("//attacker.invalid/steal?x=1", {
        "x-nexus-risk-envelope": encodedEnvelope(envelope(100)),
        "x-forwarded-for": "203.0.113.200",
        "x-real-ip": "203.0.113.201",
      });
      expect(result.status).toBe(200);
      expect(result.headers["x-nexus-risk-action"]).toBe("ALLOW");
      expect(upstreamFetch).toHaveBeenCalledTimes(1);
      const [target, init] = upstreamFetch.mock.calls[0]!;
      expect(new URL(String(target)).origin).toBe("https://upstream.example");
      const forwarded = init?.headers as Headers;
      expect(forwarded.get("x-forwarded-for")).toBeNull();
      expect(forwarded.get("x-real-ip")).toBeNull();
      expect(forwarded.get("x-nexus-risk-envelope")).toBeNull();
    } finally { await server.close(); }
  });

  it("accepts a network assertion only from a configured trusted proxy with a valid HMAC", async () => {
    const asserted = "198.51.100.44";
    const upstreamFetch = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", upstreamFetch);
    const server = startCortex14RiskProxy(config({ trustedProxyAddresses: ["127.0.0.1"] }));
    try {
      await waitReady();
      const valid = await request("/resource", {
        "x-nexus-risk-envelope": encodedEnvelope(envelope(100, asserted)),
        "x-nexus-client-network-key": asserted,
        "x-nexus-client-network-signature": trustedProxySignature(asserted),
      });
      expect(valid.status).toBe(200);
      expect(upstreamFetch).toHaveBeenCalledTimes(1);

      const invalid = await request("/resource", {
        "x-nexus-risk-envelope": encodedEnvelope(envelope(100, asserted)),
        "x-nexus-client-network-key": asserted,
        "x-nexus-client-network-signature": `sha256=${"0".repeat(64)}`,
      });
      expect(invalid.status).toBe(403);
      expect(upstreamFetch).toHaveBeenCalledTimes(1);
    } finally { await server.close(); }
  });

  it("rejects replay of a valid signed low-risk assessment from a different network before upstream", async () => {
    const upstreamFetch = vi.fn(async () => new Response("unexpected", { status: 200 }));
    vi.stubGlobal("fetch", upstreamFetch);
    const server = startCortex14RiskProxy(config());
    try {
      await waitReady();
      const result = await request("/resource", { "x-nexus-risk-envelope": encodedEnvelope(envelope(100, "203.0.113.77")) });
      expect(result.status).toBe(403);
      expect(JSON.parse(result.body)).toEqual({ error: "NETWORK_MISMATCH" });
      expect(upstreamFetch).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it("enforces DENY in ACTIVE but only observes the same verified decision in OBSERVE_ONLY", async () => {
    const upstreamFetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", upstreamFetch);
    const server = startCortex14RiskProxy(config());
    try {
      await waitReady();
      const blocked = await request("/resource", { "x-nexus-risk-envelope": encodedEnvelope(envelope(900)) });
      expect(blocked.status).toBe(403);
      expect(upstreamFetch).not.toHaveBeenCalled();

      mode = "OBSERVE_ONLY";
      const observed = await request("/resource", { "x-nexus-risk-envelope": encodedEnvelope(envelope(900)) });
      expect(observed.status).toBe(204);
      expect(observed.headers["x-nexus-risk-action"]).toBe("DENY");
      expect(upstreamFetch).toHaveBeenCalledTimes(1);
    } finally { await server.close(); }
  });

  it("fails closed when durable control is killed or unreadable", async () => {
    const upstreamFetch = vi.fn(async () => new Response("unexpected"));
    vi.stubGlobal("fetch", upstreamFetch);
    mode = "KILLED";
    let server = startCortex14RiskProxy(config());
    try {
      await waitReady(503);
      const killed = await request("/resource", { "x-nexus-risk-envelope": encodedEnvelope(envelope(100)) });
      expect(killed.status).toBe(503);
      expect(upstreamFetch).not.toHaveBeenCalled();
    } finally { await server.close(); }

    server = startCortex14RiskProxy(config({ readMode: () => { throw new Error("control unavailable"); } }));
    try {
      await waitReady(503);
      const unavailable = await request("/resource", { "x-nexus-risk-envelope": encodedEnvelope(envelope(100)) });
      expect(unavailable.status).toBe(503);
      expect(upstreamFetch).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it("logs only minimized enforcement metadata", async () => {
    const upstreamFetch = vi.fn(async () => new Response("ok", { status: 200 }));
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", upstreamFetch);
    const server = startCortex14RiskProxy(config());
    try {
      await waitReady();
      const result = await request("/resource", { "x-nexus-risk-envelope": encodedEnvelope(envelope(100)) });
      expect(result.status).toBe(200);
      const serialized = info.mock.calls.map((call) => String(call[0])).join("\n");
      expect(serialized).toContain('"action":"ALLOW"');
      expect(serialized).not.toContain("assessment-");
      expect(serialized).not.toContain("provider-");
      expect(serialized).not.toContain('"riskScore"');
    } finally { await server.close(); }
  });
});
