import { afterEach, describe, expect, it, vi } from "vitest";
import type { OntologyScope } from "@nexus/ontology";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import type { DataManagerConversionEvent, DataManagerDestination } from "./data-manager-rest";
import { DurableEnhancedConversionsPipeline, type EnhancedConversionGateway } from "./index";
import { EnhancedConversionProductionServer } from "./production-server";
import { DurableEnhancedConversionControl } from "./runtime-control";

const scope: OntologyScope = Object.freeze({ tenantId: "tenant-cortex", organizationId: "org-cortex", brandId: "brand-cortex" });
const destination: DataManagerDestination = Object.freeze({ operatingAccountId: "1234567890", conversionActionId: "9876543210" });
const ingestToken = "ingest-token-" + "i".repeat(32);
const controlToken = "control-token-" + "c".repeat(32);
const event = {
  transactionId: "order-12345678",
  eventTimestamp: "2026-09-06T11:59:00.000Z",
  eventName: "purchase",
  eventSource: "WEB",
  adUserDataConsent: "GRANTED",
  conversionValue: 125.5,
  currency: "MXN",
  gclid: "click-id-123456",
  emailAddresses: ["person@example.com"],
  phoneNumbers: [],
} as const;

class Gateway implements EnhancedConversionGateway {
  calls = 0;
  async ingestConversion(_destination: DataManagerDestination, _event: DataManagerConversionEvent) {
    this.calls += 1;
    return { requestId: `request-${this.calls}-00000000` };
  }
}

const servers: EnhancedConversionProductionServer[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function fixture() {
  const store = new InMemoryOntologyTransactionStore();
  const gateway = new Gateway();
  const control = new DurableEnhancedConversionControl(store, scope, () => Date.parse("2026-09-06T12:00:00.000Z"));
  const engine = new DurableEnhancedConversionsPipeline(store, scope, destination, gateway, () => control.read().mode, () => Date.parse("2026-09-06T12:00:00.000Z"));
  const server = new EnhancedConversionProductionServer({ engine, control, ingestToken, controlToken, port: 0 });
  servers.push(server);
  const address = await server.start();
  return { store, gateway, control, engine, baseUrl: `http://${address.host}:${address.port}` };
}

async function postJson(baseUrl: string, path: string, token: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
  });
}

describe("CORTEX #10 production server", () => {
  it("defaults KILLED and refuses durable preparation before any conversion mutation", async () => {
    const { baseUrl, engine, gateway } = await fixture();
    const response = await postJson(baseUrl, "/v1/enhanced-conversions/events", ingestToken, event);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "KILLED" });
    expect(engine.get(event.transactionId)).toBeUndefined();
    expect(gateway.calls).toBe(0);
  });

  it("OBSERVE_ONLY validates and hashes the real input contract without persistence or Data Manager dispatch", async () => {
    const { baseUrl, control, engine, gateway } = await fixture();
    control.setMode("OBSERVE_ONLY", 0);
    const response = await postJson(baseUrl, "/v1/enhanced-conversions/events", ingestToken, event);
    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; observation: Record<string, unknown> };
    expect(body.status).toBe("OBSERVED");
    expect(body.observation.transactionDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(body.observation.eventDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(body.observation.userIdentifierCount).toBe(1);
    expect(JSON.stringify(body)).not.toContain("person@example.com");
    expect(engine.get(event.transactionId)).toBeUndefined();
    expect(gateway.calls).toBe(0);
  });

  it("ACTIVE traverses durable prepare and the real gateway interface exactly once", async () => {
    const { baseUrl, control, engine, gateway } = await fixture();
    const active = control.setMode("ACTIVE", 0);
    expect(active.revision).toBe(1);
    const response = await postJson(baseUrl, "/v1/enhanced-conversions/events", ingestToken, event);
    expect(response.status).toBe(202);
    const body = await response.json() as { status: string; externalRequestId: string };
    expect(body.status).toBe("SENT");
    expect(body.externalRequestId).toBe("request-1-00000000");
    expect(engine.get(event.transactionId)?.status).toBe("SENT");
    expect(gateway.calls).toBe(1);
  });

  it("separates ingest and control credentials and enforces control CAS", async () => {
    const { baseUrl } = await fixture();
    const unauthorized = await postJson(baseUrl, "/v1/enhanced-conversions/control", ingestToken, { mode: "ACTIVE", expectedRevision: 0 });
    expect(unauthorized.status).toBe(401);
    const first = await postJson(baseUrl, "/v1/enhanced-conversions/control", controlToken, { mode: "ACTIVE", expectedRevision: 0 });
    expect(first.status).toBe(200);
    const stale = await postJson(baseUrl, "/v1/enhanced-conversions/control", controlToken, { mode: "KILLED", expectedRevision: 0 });
    expect(stale.status).toBe(409);
  });

  it("bounds request bodies and rejects malformed media before processing", async () => {
    const { baseUrl, control } = await fixture();
    control.setMode("ACTIVE", 0);
    const wrongType = await fetch(`${baseUrl}/v1/enhanced-conversions/events`, { method: "POST", headers: { authorization: `Bearer ${ingestToken}`, "content-type": "text/plain" }, body: JSON.stringify(event) });
    expect(wrongType.status).toBe(400);
    const oversized = await postJson(baseUrl, "/v1/enhanced-conversions/events", ingestToken, { ...event, padding: "x".repeat(20_000) });
    expect(oversized.status).toBe(400);
  });
});
