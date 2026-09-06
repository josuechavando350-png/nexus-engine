import { readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeRiskNetworkKeyHash, signRiskPayload } from "./index";
import { setCortex14ProductionMode } from "./production-control";
import { startCortex14ProductionRuntime } from "./production-runtime";

const runRealProof = process.env.NEXUS_CORTEX_14_REAL_PROOF === "1" ? it : it.skip;
const signingSecret = "s".repeat(64);
const networkSecret = "n".repeat(64);
const policy = { challengeAtOrAbove: 500, denyAtOrAbove: 800, maxAssessmentAgeSeconds: 300, maxFutureSkewSeconds: 30 } as const;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the CORTEX #14 real-runtime proof`);
  return value;
}

function port(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error(`${name} is invalid`);
  return value;
}

function listen(server: ReturnType<typeof createHttpsServer>, targetPort: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(targetPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: ReturnType<typeof createHttpsServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function proxyRequest(proxyPort: number, path: string, envelope?: string, extraHeaders: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const headers = envelope ? { "x-nexus-risk-envelope": envelope, ...extraHeaders } : extraHeaders;
    const request = httpRequest({ host: "127.0.0.1", port: proxyPort, path, method: "GET", headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
}

async function waitForHealth(proxyPort: number, expectedStatus: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await proxyRequest(proxyPort, "/healthz");
      if (response.status === expectedStatus) return;
    } catch {
      // bounded startup retry
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`CORTEX #14 runtime did not reach health status ${expectedStatus}`);
}

function signedEnvelope(score: number): string {
  const now = Date.now();
  const envelope = signRiskPayload({
    schemaVersion: 1,
    assessmentId: `assessment-real-${String(score).padStart(8, "0")}`,
    providerId: "provider-real-00000001",
    assessedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 120_000).toISOString(),
    riskScore: score,
    networkKeyHash: computeRiskNetworkKeyHash("127.0.0.1", networkSecret),
  }, signingSecret);
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

describe("CORTEX #14 real production composition", () => {
  runRealProof("proves real TLS upstream, enforcement modes, hop-by-hop stripping, and durable kill across restart", async () => {
    const proofDir = required("NEXUS_CORTEX_14_PROOF_DIR");
    const proxyPort = port("NEXUS_CORTEX_14_PROXY_PORT");
    const upstreamPort = port("NEXUS_CORTEX_14_UPSTREAM_PORT");
    const databasePath = join(proofDir, "cortex14-control.sqlite");
    const signingFile = join(proofDir, "signing.secret");
    const networkFile = join(proofDir, "network.secret");
    writeFileSync(signingFile, signingSecret, { mode: 0o600 });
    writeFileSync(networkFile, networkSecret, { mode: 0o600 });

    let upstreamHits = 0;
    let lastUpstreamHeaders: Record<string, string | string[] | undefined> = {};
    const upstream = createHttpsServer({
      key: readFileSync(join(proofDir, "server.key")),
      cert: readFileSync(join(proofDir, "server.crt")),
    }, (request, response) => {
      upstreamHits += 1;
      lastUpstreamHeaders = request.headers;
      response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      response.end("real-upstream-ok");
    });
    await listen(upstream, upstreamPort);

    const env: NodeJS.ProcessEnv = {
      NEXUS_CORTEX_14_PERSISTENCE_ACK: "durable-volume",
      NEXUS_CORTEX_14_DATABASE: databasePath,
      NEXUS_CORTEX_14_SIGNING_SECRET_FILE: signingFile,
      NEXUS_CORTEX_14_NETWORK_KEY_SECRET_FILE: networkFile,
      NEXUS_CORTEX_14_POLICY_JSON: JSON.stringify(policy),
      NEXUS_CORTEX_14_UPSTREAM_ORIGIN: `https://127.0.0.1:${upstreamPort}/`,
      NEXUS_CORTEX_14_PORT: String(proxyPort),
    };

    let runtime: ReturnType<typeof startCortex14ProductionRuntime> | undefined;
    try {
      runtime = startCortex14ProductionRuntime(env);
      await waitForHealth(proxyPort, 503);
      expect(setCortex14ProductionMode(databasePath, "ACTIVE", 0)).toMatchObject({ mode: "ACTIVE", revision: 1 });
      await waitForHealth(proxyPort, 200);

      const allowed = await proxyRequest(proxyPort, "/checkout?proof=1", signedEnvelope(100), {
        connection: "x-proof-hop, keep-alive",
        "x-proof-hop": "must-not-cross-proxy",
        "x-forwarded-for": "203.0.113.200",
      });
      expect(allowed.status).toBe(200);
      expect(allowed.headers["x-nexus-risk-action"]).toBe("ALLOW");
      expect(allowed.body).toBe("real-upstream-ok");
      expect(upstreamHits).toBe(1);
      expect(lastUpstreamHeaders["x-proof-hop"]).toBeUndefined();
      expect(lastUpstreamHeaders["x-forwarded-for"]).toBeUndefined();
      expect(lastUpstreamHeaders["x-nexus-risk-envelope"]).toBeUndefined();

      const challenged = await proxyRequest(proxyPort, "/checkout", signedEnvelope(650));
      expect(challenged.status).toBe(429);
      expect(JSON.parse(challenged.body)).toEqual({ error: "RISK_CHALLENGE" });
      expect(upstreamHits).toBe(1);

      const denied = await proxyRequest(proxyPort, "/checkout", signedEnvelope(900));
      expect(denied.status).toBe(403);
      expect(JSON.parse(denied.body)).toEqual({ error: "RISK_DENIED" });
      expect(upstreamHits).toBe(1);

      expect(setCortex14ProductionMode(databasePath, "OBSERVE_ONLY", 1)).toMatchObject({ mode: "OBSERVE_ONLY", revision: 2 });
      const observedDeny = await proxyRequest(proxyPort, "/checkout", signedEnvelope(900));
      expect(observedDeny.status).toBe(200);
      expect(observedDeny.headers["x-nexus-risk-action"]).toBe("DENY");
      expect(upstreamHits).toBe(2);

      expect(setCortex14ProductionMode(databasePath, "KILLED", 2)).toMatchObject({ mode: "KILLED", revision: 3 });
      await waitForHealth(proxyPort, 503);
      const killed = await proxyRequest(proxyPort, "/checkout", signedEnvelope(100));
      expect(killed.status).toBe(503);
      expect(JSON.parse(killed.body)).toEqual({ error: "KILLED" });
      expect(upstreamHits).toBe(2);

      await runtime.close();
      runtime = undefined;

      runtime = startCortex14ProductionRuntime(env);
      await waitForHealth(proxyPort, 503);
      const afterRestart = await proxyRequest(proxyPort, "/checkout", signedEnvelope(100));
      expect(afterRestart.status).toBe(503);
      expect(upstreamHits).toBe(2);
      expect(setCortex14ProductionMode(databasePath, "ACTIVE", 2)).toThrow(/revision conflict/u);
    } finally {
      if (runtime) await runtime.close().catch(() => undefined);
      await close(upstream).catch(() => undefined);
    }
  }, 60_000);
});
