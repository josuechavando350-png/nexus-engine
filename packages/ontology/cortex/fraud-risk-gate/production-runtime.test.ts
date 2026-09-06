import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { setCortex14ProductionMode } from "./production-control";
import { loadCortex14ProductionConfig, startCortex14ProductionRuntime } from "./production-runtime";

const dirs: string[] = [];
const port = 39815;

function fixture(): { dir: string; database: string; signing: string; network: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), "nexus-cortex14-runtime-"));
  dirs.push(dir);
  const database = join(dir, "control.sqlite");
  const signing = join(dir, "signing.secret");
  const network = join(dir, "network.secret");
  writeFileSync(signing, "s".repeat(32), { mode: 0o600 });
  writeFileSync(network, "n".repeat(32), { mode: 0o600 });
  return {
    dir,
    database,
    signing,
    network,
    env: {
      NEXUS_CORTEX_14_DATABASE: database,
      NEXUS_CORTEX_14_SIGNING_SECRET_FILE: signing,
      NEXUS_CORTEX_14_NETWORK_KEY_SECRET_FILE: network,
      NEXUS_CORTEX_14_POLICY_JSON: JSON.stringify({ challengeAtOrAbove: 500, denyAtOrAbove: 800, maxAssessmentAgeSeconds: 300, maxFutureSkewSeconds: 30 }),
      NEXUS_CORTEX_14_UPSTREAM_ORIGIN: "https://upstream.example/",
      NEXUS_CORTEX_14_PORT: String(port),
    },
  };
}

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function health(): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`http://127.0.0.1:${port}/healthz`, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitHealth(expectedStatus: number): Promise<{ status: number; body: string }> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const result = await health();
      if (result.status === expectedStatus) return result;
    } catch {
      // bounded startup retry
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`CORTEX #14 health did not reach HTTP ${expectedStatus}`);
}

describe("CORTEX #14 production runtime composition", () => {
  it("loads secrets from bounded files and strict policy/upstream configuration", () => {
    const item = fixture();
    const config = loadCortex14ProductionConfig(item.env);
    expect(config.databasePath).toBe(item.database);
    expect(config.signingSecret).toBe("s".repeat(32));
    expect(config.networkSecret).toBe("n".repeat(32));
    expect(config.upstreamOrigin).toBe("https://upstream.example/");
    expect(config.port).toBe(port);
  });

  it("starts fail-closed with an uninitialized durable database and becomes active only after explicit CAS control", async () => {
    const item = fixture();
    const runtime = startCortex14ProductionRuntime(item.env);
    try {
      const initial = await waitHealth(503);
      expect(JSON.parse(initial.body)).toEqual({ mode: "KILLED" });
      expect(setCortex14ProductionMode(item.database, "ACTIVE", 0)).toMatchObject({ mode: "ACTIVE", revision: 1 });
      const active = await waitHealth(200);
      expect(JSON.parse(active.body)).toEqual({ mode: "ACTIVE" });
      expect(setCortex14ProductionMode(item.database, "KILLED", 1)).toMatchObject({ mode: "KILLED", revision: 2 });
      const killed = await waitHealth(503);
      expect(JSON.parse(killed.body)).toEqual({ mode: "KILLED" });
    } finally { await runtime.close(); }
  });

  it("rejects secret files with line terminators, identical secrets, malformed policy, and insecure upstreams", () => {
    const item = fixture();
    writeFileSync(item.signing, `${"s".repeat(32)}\n`, { mode: 0o600 });
    expect(() => loadCortex14ProductionConfig(item.env)).toThrow(/secret contents/u);

    writeFileSync(item.signing, "n".repeat(32), { mode: 0o600 });
    expect(() => loadCortex14ProductionConfig(item.env)).toThrow(/must be distinct/u);

    writeFileSync(item.signing, "s".repeat(32), { mode: 0o600 });
    expect(() => loadCortex14ProductionConfig({ ...item.env, NEXUS_CORTEX_14_POLICY_JSON: "{}" })).toThrow(/policy/u);
    expect(() => loadCortex14ProductionConfig({ ...item.env, NEXUS_CORTEX_14_UPSTREAM_ORIGIN: "http://upstream.example/" })).toThrow(/HTTPS origin/u);
  });
});
