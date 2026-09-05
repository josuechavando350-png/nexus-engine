import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteOntologyTransactionStore } from "../sqlite-transaction-store";
import {
  createCortexBanditHttpRuntime,
  parseCortexBanditProductionConfig,
  type CortexBanditHttpRuntime,
  type CortexBanditRuntimeTelemetryEvent,
} from "./production-runtime";

const token = "test-only-cortex-api-token-00000000000000000000";
const config = parseCortexBanditProductionConfig({
  version: 1,
  scope: { tenantId: "tenant:production-runtime", organizationId: "org:production-runtime" },
  experiments: [{
    experimentId: "landing-cta",
    policy: {
      policyId: "landing-cta-policy",
      version: "v1",
      defaultArmId: "control",
      minimumObservationsPerArm: 1,
      confidenceLevel: 0.95,
      ucbExplorationCoefficient: 1,
      maxArms: 2,
      maxContextFeatures: 2,
      allowedContextKeys: ["channel"],
      maxRewardDelayMs: 86_400_000,
      conversionWeight: 0.5,
      economicValueWeight: 0.5,
      economicValueNormalizationCap: 100_000,
      mode: "ACTIVE",
    },
    arms: [
      { armId: "control", payload: { experienceId: "default" }, minTrafficShare: 0, maxTrafficShare: 1 },
      { armId: "variant", payload: { experienceId: "paid-search" }, minTrafficShare: 0, maxTrafficShare: 1 },
    ],
  }],
});

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function listen(runtime: CortexBanditHttpRuntime): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    runtime.server.once("error", reject);
    runtime.server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = runtime.server.address();
  if (!address || typeof address === "string") throw new Error("runtime did not expose a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function api(base: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers });
}

describe("CORTEX bandit production HTTP runtime", () => {
  it("connects assignment, outcome, rollback and kill to durable SQLite across restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexus-bandit-production-"));
    directories.push(directory);
    const dbPath = join(directory, "cortex.sqlite");
    let now = Date.parse("2026-09-05T22:30:00.000Z");
    const telemetry: CortexBanditRuntimeTelemetryEvent[] = [];

    let store = new SqliteOntologyTransactionStore(dbPath);
    let runtime = createCortexBanditHttpRuntime({ transactions: store, config, apiToken: token, now: () => now, onTelemetry: (event) => telemetry.push(event) });
    let base = await listen(runtime);

    const unauthorized = await fetch(`${base}/v1/bandits/landing-cta/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "unauthorized", context: { channel: "paid-search" }, eligibleArmIds: ["control", "variant"] }),
    });
    expect(unauthorized.status).toBe(401);

    const selectionResponse = await api(base, "/v1/bandits/landing-cta/select", {
      method: "POST",
      body: JSON.stringify({ requestId: "request-0001", context: { channel: "paid-search" }, eligibleArmIds: ["control", "variant"] }),
    });
    expect(selectionResponse.status).toBe(200);
    const selection = await selectionResponse.json() as { decisionId: string; armId: string; reason: string; status: string };
    expect(selection.armId).toBe("control");
    expect(selection.status).toBe("PENDING");

    const outcomeResponse = await api(base, "/v1/bandits/landing-cta/outcomes", {
      method: "POST",
      body: JSON.stringify({ decisionId: selection.decisionId, converted: true, economicValue: 50_000, outcomeAt: new Date(now).toISOString() }),
    });
    expect(outcomeResponse.status).toBe(200);
    expect(await outcomeResponse.json()).toMatchObject({ status: "REWARDED", converted: true, economicValue: 50_000 });

    now += 1_000;
    const rollbackResponse = await api(base, "/v1/bandits/landing-cta/control", {
      method: "POST",
      body: JSON.stringify({ expectedRevision: 0, mode: "FALLBACK_ONLY", reason: "rollback after monitored conversion regression" }),
    });
    expect(rollbackResponse.status).toBe(200);
    expect(await rollbackResponse.json()).toMatchObject({ state: { mode: "FALLBACK_ONLY", revision: 1 } });

    const rollbackSelectionResponse = await api(base, "/v1/bandits/landing-cta/select", {
      method: "POST",
      body: JSON.stringify({ requestId: "request-0002", context: { channel: "paid-search" }, eligibleArmIds: ["control", "variant"] }),
    });
    expect(rollbackSelectionResponse.status).toBe(200);
    expect(await rollbackSelectionResponse.json()).toMatchObject({ armId: "control", reason: "ROLLBACK_FALLBACK" });

    now += 1_000;
    const killResponse = await api(base, "/v1/bandits/landing-cta/control", {
      method: "POST",
      body: JSON.stringify({ expectedRevision: 1, mode: "KILLED", reason: "emergency kill during upstream incident" }),
    });
    expect(killResponse.status).toBe(200);
    expect(await killResponse.json()).toMatchObject({ state: { mode: "KILLED", revision: 2 } });

    await runtime.close();
    store.close();

    store = new SqliteOntologyTransactionStore(dbPath);
    runtime = createCortexBanditHttpRuntime({ transactions: store, config, apiToken: token, now: () => now, onTelemetry: (event) => telemetry.push(event) });
    base = await listen(runtime);

    const controlResponse = await api(base, "/v1/bandits/landing-cta/control");
    expect(controlResponse.status).toBe(200);
    const control = await controlResponse.json() as { state: { mode: string; revision: number }; history: unknown[] };
    expect(control.state).toEqual(expect.objectContaining({ mode: "KILLED", revision: 2 }));
    expect(control.history).toHaveLength(2);

    const killedSelectionResponse = await api(base, "/v1/bandits/landing-cta/select", {
      method: "POST",
      body: JSON.stringify({ requestId: "request-0003", context: { channel: "paid-search" }, eligibleArmIds: ["control", "variant"] }),
    });
    expect(killedSelectionResponse.status).toBe(200);
    expect(await killedSelectionResponse.json()).toMatchObject({ armId: "control", reason: "KILL_SWITCH" });

    const invalidContentType = await fetch(`${base}/v1/bandits/landing-cta/select`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
      body: "{}",
    });
    expect(invalidContentType.status).toBe(415);

    expect(JSON.stringify(telemetry)).not.toContain("paid-search");
    expect(telemetry.some((event) => event.operation === "CONTROL_WRITE" && event.controlMode === "KILLED")).toBe(true);

    await runtime.close();
    store.close();
  });

  it("rejects unknown production config fields before runtime startup", () => {
    expect(() => parseCortexBanditProductionConfig({ ...config, unexpected: true })).toThrow(/unknown field unexpected/i);
  });
});
