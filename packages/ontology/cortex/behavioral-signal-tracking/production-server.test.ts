import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteOntologyTransactionStore } from "../sqlite-transaction-store";
import { createBehavioralSignalPolicy } from "./index";
import { CortexBehavioralSignalRuntime } from "./runtime";
import { createBehavioralProductionServer } from "./production-server";

const origin = "https://canopenal.com";
const ingestToken = "ingest-token-00000000000000000000000000000001";
const controlToken = "control-token-0000000000000000000000000000001";
const privacyKey = "privacy-key-00000000000000000000000000000001";
const scope = Object.freeze({ tenantId: "cano", organizationId: "nexus", brandId: "cano-penal" });

function policy(mode: "ACTIVE" | "OBSERVE_ONLY" | "KILLED" = "ACTIVE") {
  return createBehavioralSignalPolicy({
    policyId: "cano-behavioral-v1",
    version: "v1",
    pseudonymizationKeyId: "cano-key-v1",
    allowedSurfaceIds: ["cano-site"],
    allowedElementIds: ["hero-primary", "contact-form"],
    maxEventAgeMs: 60_000,
    maxFutureSkewMs: 5_000,
    maxSessionDurationMs: 3_600_000,
    maxEventsPerSession: 64,
    maxEngagementMsPerEvent: 60_000,
    mode,
  });
}

function event(eventId: string, occurredAt: string) {
  return {
    channel: "BASE",
    event: {
      eventId,
      sessionId: "session:production-test-0001",
      siteId: "cano-penal",
      kind: "PAGE_VIEW",
      occurredAt,
      surfaceId: "cano-site",
      collectionAllowed: true,
      privacyDecisionRef: "consent-v1",
    },
  };
}

const directories: string[] = [];
afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

async function listen(server: ReturnType<typeof createBehavioralProductionServer>["server"]): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind TCP");
  return `http://127.0.0.1:${address.port}`;
}

describe("CORTEX behavioral production server", () => {
  it("persists ingest, kill and rollback control across the real HTTP and SQLite boundary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexus-behavioral-production-"));
    directories.push(directory);
    const dbPath = join(directory, "state.sqlite");
    let nowMs = Date.parse("2026-09-05T23:30:00.000Z");
    const store = new SqliteOntologyTransactionStore(dbPath);
    const runtime = new CortexBehavioralSignalRuntime(store, scope, policy(), { pseudonymizationKey: privacyKey }, () => nowMs);
    const production = createBehavioralProductionServer({ runtime, allowedOrigins: [origin], ingestToken, controlToken });
    const base = await listen(production.server);

    const ingest = await fetch(`${base}/v1/behavioral/ingest`, {
      method: "POST",
      headers: { authorization: `Bearer ${ingestToken}`, origin, "content-type": "application/json" },
      body: JSON.stringify(event("event:production-0001", new Date(nowMs).toISOString())),
    });
    expect(ingest.status).toBe(202);
    expect(await ingest.json()).toMatchObject({ status: "RECORDED", reason: "RECORDED", mode: "ACTIVE", siteId: "cano-penal" });

    expect((await fetch(`${base}/v1/behavioral/control`, { headers: { authorization: `Bearer ${ingestToken}` } })).status).toBe(401);
    const control = await fetch(`${base}/v1/behavioral/control`, { headers: { authorization: `Bearer ${controlToken}` } });
    const active = await control.json() as { active: { digest: string; mode: string } };
    expect(active.active.mode).toBe("ACTIVE");

    const killedResponse = await fetch(`${base}/v1/behavioral/control/kill`, {
      method: "POST",
      headers: { authorization: `Bearer ${controlToken}`, "content-type": "application/json" },
      body: JSON.stringify({ expectedActiveDigest: active.active.digest }),
    });
    expect(killedResponse.status).toBe(200);
    const killed = await killedResponse.json() as { active: { digest: string; mode: string } };
    expect(killed.active.mode).toBe("KILLED");

    nowMs += 1_000;
    const blocked = await fetch(`${base}/v1/behavioral/ingest`, {
      method: "POST",
      headers: { authorization: `Bearer ${ingestToken}`, origin, "content-type": "application/json" },
      body: JSON.stringify(event("event:production-0002", new Date(nowMs).toISOString())),
    });
    expect(blocked.status).toBe(202);
    expect(await blocked.json()).toMatchObject({ status: "NOOP", reason: "KILL_SWITCH", mode: "KILLED" });

    const rollback = await fetch(`${base}/v1/behavioral/control/rollback`, {
      method: "POST",
      headers: { authorization: `Bearer ${controlToken}`, "content-type": "application/json" },
      body: JSON.stringify({ expectedActiveDigest: killed.active.digest }),
    });
    expect(rollback.status).toBe(200);
    expect(await rollback.json()).toMatchObject({ active: { mode: "ACTIVE" } });

    await production.close();
    store.close();

    const reopenedStore = new SqliteOntologyTransactionStore(dbPath);
    const reopened = new CortexBehavioralSignalRuntime(reopenedStore, scope, policy(), { pseudonymizationKey: privacyKey }, () => nowMs);
    expect(reopened.controlState().active.mode).toBe("ACTIVE");
    expect(reopened.controlState().generation).toBe(3);
    reopenedStore.close();
  });
});
