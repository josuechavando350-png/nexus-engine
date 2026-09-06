import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableWebhookRelay, type RelayGateway } from "./index";
import { WebhookRelayProductionServer } from "./production-server";
import { SqliteWebhookRelayControl } from "./runtime-control";

const dirs: string[] = [];
const servers: WebhookRelayProductionServer[] = [];
const ingestToken = "ingest-token-" + "i".repeat(32);
const controlToken = "control-token-" + "c".repeat(32);
const event = {
  eventId: "evt-00000001",
  eventType: "lead.accepted",
  occurredAt: "2026-09-06T00:00:00.000Z",
  adUserDataConsent: "GRANTED",
  userIdentifiers: [{ kind: "EMAIL_SHA256", value: `sha256:${"a".repeat(64)}` }],
  data: { source: "web", amount: 125 },
} as const;

function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "nexus-cortex11-server-"));
  dirs.push(dir);
  return join(dir, "relay.sqlite");
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture() {
  const path = databasePath();
  const gateway: RelayGateway & { calls: number } = {
    calls: 0,
    async send() { this.calls += 1; return { requestId: `request-${this.calls}-00000000` }; },
  };
  const control = new SqliteWebhookRelayControl(path, () => Date.parse("2026-09-06T12:00:00.000Z"));
  const relay = new DurableWebhookRelay(path, gateway, () => control.read().mode, () => Date.parse("2026-09-06T12:00:00.000Z"));
  const server = new WebhookRelayProductionServer({ relay, control, ingestToken, controlToken, port: 0 });
  servers.push(server);
  const address = await server.start();
  return { baseUrl: `http://${address.host}:${address.port}`, relay, control, gateway };
}

async function post(baseUrl: string, path: string, token: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), redirect: "error" });
}

describe("CORTEX #11 production server", () => {
  it("defaults KILLED before any durable relay mutation", async () => {
    const { baseUrl, relay, gateway } = await fixture();
    const response = await post(baseUrl, "/v1/webhook-relay/events", ingestToken, event);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "KILLED" });
    expect(relay.get(event.eventId)).toBeUndefined();
    expect(gateway.calls).toBe(0);
  });

  it("OBSERVE_ONLY validates consent and hashes identity without durable mutation or outbound delivery", async () => {
    const { baseUrl, relay, control, gateway } = await fixture();
    control.setMode("OBSERVE_ONLY", 0);
    const response = await post(baseUrl, "/v1/webhook-relay/events", ingestToken, event);
    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; observation: Record<string, unknown> };
    expect(body.status).toBe("OBSERVED");
    expect(body.observation.eventDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(body.observation.eventIdDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(body)).not.toContain(event.eventId);
    expect(JSON.stringify(body)).not.toContain(event.userIdentifiers[0].value);
    expect(relay.get(event.eventId)).toBeUndefined();
    expect(gateway.calls).toBe(0);
  });

  it("ACTIVE persists then dispatches through the outbound gateway exactly once", async () => {
    const { baseUrl, relay, control, gateway } = await fixture();
    control.setMode("ACTIVE", 0);
    const response = await post(baseUrl, "/v1/webhook-relay/events", ingestToken, event);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "SENT", remoteRequestId: "request-1-00000000" });
    expect(relay.get(event.eventId)?.status).toBe("SENT");
    expect(gateway.calls).toBe(1);
  });

  it("uses separate control credentials and rejects stale control revisions", async () => {
    const { baseUrl } = await fixture();
    expect((await post(baseUrl, "/v1/webhook-relay/control", ingestToken, { mode: "ACTIVE", expectedRevision: 0 })).status).toBe(401);
    expect((await post(baseUrl, "/v1/webhook-relay/control", controlToken, { mode: "ACTIVE", expectedRevision: 0 })).status).toBe(200);
    expect((await post(baseUrl, "/v1/webhook-relay/control", controlToken, { mode: "KILLED", expectedRevision: 0 })).status).toBe(409);
  });

  it("rejects oversized and malformed event bodies without resetting the HTTP connection", async () => {
    const { baseUrl, control } = await fixture();
    control.setMode("ACTIVE", 0);
    const wrongType = await fetch(`${baseUrl}/v1/webhook-relay/events`, { method: "POST", headers: { authorization: `Bearer ${ingestToken}`, "content-type": "text/plain" }, body: JSON.stringify(event) });
    expect(wrongType.status).toBe(400);
    const oversized = await post(baseUrl, "/v1/webhook-relay/events", ingestToken, { ...event, data: { padding: "x".repeat(70 * 1024) } });
    expect(oversized.status).toBe(400);
  });
});
