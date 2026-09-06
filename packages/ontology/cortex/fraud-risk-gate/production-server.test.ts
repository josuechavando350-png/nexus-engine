import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeRiskNetworkKeyHash, signRiskPayload } from "./index";
import { fixedUpstreamTarget, normalizeRemoteAddress, startCortex14RiskProxy } from "./production-server";

const port = 39814;
const origin = `http://127.0.0.1:${port}`;
const signingSecret = "s".repeat(32);
const networkSecret = "n".repeat(32);
const policy = { challengeAtOrAbove: 500, denyAtOrAbove: 800, maxAssessmentAgeSeconds: 300, maxFutureSkewSeconds: 30 } as const;
const originalEnv = { ...process.env };

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

async function waitReady(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const result = await request("/healthz");
      if (result.status === 200) return;
    } catch {
      // bounded startup retry
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("CORTEX #14 test server did not become ready");
}

beforeEach(() => {
  process.env.NEXUS_CORTEX_14_MODE = "ACTIVE";
  process.env.NEXUS_CORTEX_14_SIGNING_SECRET = signingSecret;
  process.env.NEXUS_CORTEX_14_NETWORK_KEY_SECRET = networkSecret;
  process.env.NEXUS_CORTEX_14_POLICY_JSON = JSON.stringify(policy);
  process.env.NEXUS_CORTEX_14_UPSTREAM_ORIGIN = "https://upstream.example/";
  process.env.NEXUS_CORTEX_14_PORT = String(port);
  delete process.env.NEXUS_CORTEX_14_TRUSTED_PROXY_ADDRESSES;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(originalEnv)) process.env[key] = value;
});

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
});

describe("CORTEX #14 production risk enforcement", () => {
  it("forwards a valid low-risk request only to the fixed upstream and strips spoofable forwarding/risk headers", async () => {
    const upstreamFetch = vi.fn(async (url: URL | string, init?: RequestInit) => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }));
    vi.stubGlobal("fetch", upstreamFetch);
    const server = startCortex14RiskProxy();
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
    } finally {
      await server.close();
    }
  });

  it("rejects replay of a valid signed low-risk assessment from a different network before upstream", async () => {
    const upstreamFetch = vi.fn(async () => new Response("unexpected", { status: 200 }));
    vi.stubGlobal("fetch", upstreamFetch);
    const server = startCortex14RiskProxy();
    try {
      await waitReady();
      const result = await request("/resource", { "x-nexus-risk-envelope": encodedEnvelope(envelope(100, "203.0.113.77")) });
      expect(result.status).toBe(403);
      expect(JSON.parse(result.body)).toEqual({ error: "NETWORK_MISMATCH" });
      expect(upstreamFetch).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("enforces DENY in ACTIVE but only observes the same verified decision in OBSERVE_ONLY", async () => {
    const upstreamFetch = vi.fn(async () => new Response("observed", { status: 204 }));
    vi.stubGlobal("fetch", upstreamFetch);
    let server = startCortex14RiskProxy();
    try {
      await waitReady();
      const blocked = await request("/resource", { "x-nexus-risk-envelope": encodedEnvelope(envelope(900)) });
      expect(blocked.status).toBe(403);
      expect(upstreamFetch).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }

    process.env.NEXUS_CORTEX_14_MODE = "OBSERVE_ONLY";
    server = startCortex14RiskProxy();
    try {
      await waitReady();
      const observed = await request("/resource", { "x-nexus-risk-envelope": encodedEnvelope(envelope(900)) });
      expect(observed.status).toBe(204);
      expect(observed.headers["x-nexus-risk-action"]).toBe("DENY");
      expect(upstreamFetch).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it("fails closed when killed before evaluating or forwarding", async () => {
    process.env.NEXUS_CORTEX_14_MODE = "KILLED";
    const upstreamFetch = vi.fn(async () => new Response("unexpected"));
    vi.stubGlobal("fetch", upstreamFetch);
    const server = startCortex14RiskProxy();
    try {
      const deadline = Date.now() + 5_000;
      let result: Awaited<ReturnType<typeof request>> | undefined;
      while (Date.now() < deadline && !result) {
        try { result = await request("/resource", { "x-nexus-risk-envelope": encodedEnvelope(envelope(100)) }); } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
      }
      expect(result?.status).toBe(503);
      expect(upstreamFetch).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
