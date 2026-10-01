import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.unstubAllGlobals();
});

describe("CANO growth attribution ingress", () => {
  it("fails closed when the upstream CRM attribution path is not configured", async () => {
    delete process.env.NEXUS_GROWTH_ATTRIBUTION_ENDPOINT;
    delete process.env.NEXUS_GROWTH_ATTRIBUTION_TOKEN;
    delete process.env.NEXUS_CANO_GROWTH_WRITE_TOKEN;
    const response = await POST(new Request("https://cano.test/api/nexus/growth", { method: "POST" }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "GROWTH_ATTRIBUTION_NOT_CONFIGURED" });
  });

  it("rejects unauthenticated writes before parsing business evidence", async () => {
    process.env.NEXUS_GROWTH_ATTRIBUTION_ENDPOINT = "https://growth.example/ingest";
    process.env.NEXUS_GROWTH_ATTRIBUTION_TOKEN = "a".repeat(32);
    process.env.NEXUS_CANO_GROWTH_WRITE_TOKEN = "b".repeat(32);
    const response = await POST(new Request("https://cano.test/api/nexus/growth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }));
    expect(response.status).toBe(401);
  });

  it("forwards only a valid pseudonymous signed-client event", async () => {
    process.env.NEXUS_GROWTH_ATTRIBUTION_ENDPOINT = "https://growth.example/ingest";
    process.env.NEXUS_GROWTH_ATTRIBUTION_TOKEN = "a".repeat(32);
    process.env.NEXUS_CANO_GROWTH_WRITE_TOKEN = "b".repeat(32);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const event = {
      siteId: "cano-penal",
      eventId: "event.crm.00000001",
      journeySha256: `sha256:${"c".repeat(64)}`,
      occurredAt: "2026-10-01T21:00:00.000Z",
      stage: "SIGNED_CLIENT",
      channel: "REFERRAL",
      landingPath: "/evaluacion-empresarial",
      revenueMinor: 2500000,
      rawName: "must-not-pass",
    };
    const response = await POST(new Request("https://cano.test/api/nexus/growth", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${"b".repeat(32)}` },
      body: JSON.stringify(event),
    }));
    expect(response.status).toBe(202);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const forwarded = JSON.parse(String(init?.body));
    expect(forwarded.rawName).toBeUndefined();
    expect(forwarded.stage).toBe("SIGNED_CLIENT");
    expect(forwarded.revenueMinor).toBe(2500000);
  });
});
