import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { GeoHoldoutProductionServer } from "./production-server";
import { SqliteGeoExperimentRegistry } from "./registry";
import { SqliteGeoHoldoutControl } from "./runtime-control";

const dirs: string[] = [];
const EXPERIMENT_TOKEN = "experiment-token-cortex12-000001";
const CONTROL_TOKEN = "control-token-cortex12-0000000001";
const geos = Array.from({ length: 20 }, (_, index) => ({ geoId: `geo-${String(index + 1).padStart(4, "0")}`, baselineOutcome: 1_000 + index * 10 }));
const designInput = {
  experimentId: "experiment-geo-http-001",
  seed: "http-seed-with-at-least-sixteen-chars",
  holdoutFraction: 0.4,
  maxBaselineImbalance: 0.2,
  minGeosPerArm: 3,
  geos,
} as const;

function database(): string {
  const dir = mkdtempSync(join(tmpdir(), "nexus-cortex12-http-"));
  dirs.push(dir);
  return join(dir, "geo.sqlite");
}

function headers(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture(mutationAllowed?: () => boolean) {
  const db = database();
  const control = new SqliteGeoHoldoutControl(db);
  const registry = new SqliteGeoExperimentRegistry(db, Date.now, mutationAllowed ?? (() => control.read().mode === "ACTIVE"));
  const server = new GeoHoldoutProductionServer({ registry, control, experimentToken: EXPERIMENT_TOKEN, controlToken: CONTROL_TOKEN, host: "127.0.0.1", port: 0 });
  const address = await server.start();
  const base = `http://${address.host}:${address.port}`;
  return {
    db,
    control,
    registry,
    server,
    base,
    async close() {
      await server.close();
      registry.close();
      control.close();
    },
  };
}

describe("CORTEX #12 production HTTP boundary", () => {
  it("keeps health metadata minimal and requires credentials for control and experiments", async () => {
    const app = await fixture();
    try {
      const health = await fetch(`${app.base}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });
      const unauthorizedControl = await fetch(`${app.base}/v1/geo-holdout/control`);
      expect(unauthorizedControl.status).toBe(401);
      const unauthorizedExperiment = await fetch(`${app.base}/v1/geo-holdout/design`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(designInput) });
      expect(unauthorizedExperiment.status).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("fails closed while KILLED and OBSERVE_ONLY never persists a design", async () => {
    const app = await fixture();
    try {
      const killed = await fetch(`${app.base}/v1/geo-holdout/design`, { method: "POST", headers: headers(EXPERIMENT_TOKEN), body: JSON.stringify(designInput) });
      expect(killed.status).toBe(503);
      expect(app.registry.get(designInput.experimentId)).toBeUndefined();

      const observeControl = await fetch(`${app.base}/v1/geo-holdout/control`, { method: "POST", headers: headers(CONTROL_TOKEN), body: JSON.stringify({ mode: "OBSERVE_ONLY", expectedRevision: 0 }) });
      expect(observeControl.status).toBe(200);
      const observed = await fetch(`${app.base}/v1/geo-holdout/design`, { method: "POST", headers: headers(EXPERIMENT_TOKEN), body: JSON.stringify(designInput) });
      expect(observed.status).toBe(200);
      const body = await observed.json() as { status: string; design: unknown };
      expect(body.status).toBe("OBSERVED");
      expect(JSON.stringify(body)).not.toContain(designInput.seed);
      expect(app.registry.get(designInput.experimentId)).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("registers and analyzes one durable preregistered design only in ACTIVE mode", async () => {
    const app = await fixture();
    try {
      expect((await fetch(`${app.base}/v1/geo-holdout/control`, { method: "POST", headers: headers(CONTROL_TOKEN), body: JSON.stringify({ mode: "ACTIVE", expectedRevision: 0 }) })).status).toBe(200);
      const registeredResponse = await fetch(`${app.base}/v1/geo-holdout/design`, { method: "POST", headers: headers(EXPERIMENT_TOKEN), body: JSON.stringify(designInput) });
      expect(registeredResponse.status).toBe(201);
      const registeredBody = await registeredResponse.json() as { status: string; design: { assignments: readonly { geoId: string; arm: "TREATMENT" | "CONTROL"; baselineOutcome: number }[]; designDigest: string } };
      expect(registeredBody.status).toBe("REGISTERED");
      expect(JSON.stringify(registeredBody)).not.toContain(designInput.seed);
      expect(app.registry.get(designInput.experimentId)?.design.designDigest).toBe(registeredBody.design.designDigest);

      const outcomes = registeredBody.design.assignments.map((assignment, index) => ({ geoId: assignment.geoId, baselineOutcome: assignment.baselineOutcome, experimentOutcome: assignment.baselineOutcome + (assignment.arm === "TREATMENT" ? 80 + index : 10 + index) }));
      const analyzedResponse = await fetch(`${app.base}/v1/geo-holdout/analyze`, { method: "POST", headers: headers(EXPERIMENT_TOKEN), body: JSON.stringify({ experimentId: designInput.experimentId, outcomes }) });
      expect(analyzedResponse.status).toBe(200);
      const analyzedBody = await analyzedResponse.json() as { status: string; analysis: { designDigest: string } };
      expect(analyzedBody.status).toBe("ANALYZED");
      expect(analyzedBody.analysis.designDigest).toBe(registeredBody.design.designDigest);
      expect(app.registry.get(designInput.experimentId)?.analysis?.designDigest).toBe(registeredBody.design.designDigest);
    } finally {
      await app.close();
    }
  });

  it("keeps a rejected design non-durable and preserves its explicit rejection reason", async () => {
    const app = await fixture();
    try {
      app.control.setMode("ACTIVE", 0);
      const rejectedInput = { ...designInput, experimentId: "experiment-geo-http-002", minGeosPerArm: 9 };
      const response = await fetch(`${app.base}/v1/geo-holdout/design`, { method: "POST", headers: headers(EXPERIMENT_TOKEN), body: JSON.stringify(rejectedInput) });
      expect(response.status).toBe(422);
      const body = await response.json() as { status: string; design: { reason: string; baselineImbalance: unknown } };
      expect(body).toMatchObject({ status: "REJECTED", design: { reason: "INSUFFICIENT_ARM_SIZE", baselineImbalance: null } });
      expect(app.registry.get(rejectedInput.experimentId)).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("retains a final durable mutation guard after the HTTP control recheck", async () => {
    let allowMutation = false;
    const app = await fixture(() => allowMutation);
    try {
      app.control.setMode("ACTIVE", 0);
      const blocked = await fetch(`${app.base}/v1/geo-holdout/design`, { method: "POST", headers: headers(EXPERIMENT_TOKEN), body: JSON.stringify(designInput) });
      expect(blocked.status).toBe(503);
      expect(await blocked.json()).toEqual({ error: "MODE_BLOCKED" });
      expect(app.registry.get(designInput.experimentId)).toBeUndefined();
      allowMutation = true;
      const committed = await fetch(`${app.base}/v1/geo-holdout/design`, { method: "POST", headers: headers(EXPERIMENT_TOKEN), body: JSON.stringify(designInput) });
      expect(committed.status).toBe(201);
    } finally {
      await app.close();
    }
  });

  it("rejects unsupported media types and bounded-body violations", async () => {
    const app = await fixture();
    try {
      app.control.setMode("ACTIVE", 0);
      const wrongType = await fetch(`${app.base}/v1/geo-holdout/design`, { method: "POST", headers: { authorization: `Bearer ${EXPERIMENT_TOKEN}`, "content-type": "text/plain" }, body: JSON.stringify(designInput) });
      expect(wrongType.status).toBe(400);
      const oversized = await fetch(`${app.base}/v1/geo-holdout/design`, { method: "POST", headers: headers(EXPERIMENT_TOKEN), body: JSON.stringify({ padding: "x".repeat(300_000) }) });
      expect(oversized.status).toBe(400);
    } finally {
      await app.close();
    }
  });
});
