import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCortex14RiskProxy } from "./production-server";

const port = 39816;
const origin = `http://127.0.0.1:${port}`;
const policy = { challengeAtOrAbove: 500, denyAtOrAbove: 800, maxAssessmentAgeSeconds: 300, maxFutureSkewSeconds: 30 } as const;

function request(envelope: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${origin}/resource`, { headers: { "x-nexus-risk-envelope": envelope } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitReady(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const result = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(`${origin}/healthz`, (response) => { response.resume(); resolve(response.statusCode ?? 0); });
        req.on("error", reject);
        req.end();
      });
      if (result === 200) return;
    } catch {
      // bounded startup retry
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("CORTEX #14 envelope test server did not become ready");
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("CORTEX #14 envelope transport boundary", () => {
  it("rejects non-base64url and malformed JSON envelopes before any upstream call", async () => {
    const upstreamFetch = vi.fn(async () => new Response("unexpected", { status: 200 }));
    vi.stubGlobal("fetch", upstreamFetch);
    const server = startCortex14RiskProxy({
      signingSecret: "s".repeat(32),
      networkSecret: "n".repeat(32),
      policy,
      upstreamOrigin: "https://upstream.example/",
      port,
      readMode: () => "ACTIVE",
    });
    try {
      await waitReady();
      const invalidAlphabet = await request("not+base64url");
      expect(invalidAlphabet.status).toBe(400);
      expect(JSON.parse(invalidAlphabet.body)).toEqual({ error: "INVALID_INPUT" });

      const malformedJson = await request(Buffer.from("{not-json", "utf8").toString("base64url"));
      expect(malformedJson.status).toBe(400);
      expect(JSON.parse(malformedJson.body)).toEqual({ error: "INVALID_INPUT" });
      expect(upstreamFetch).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
