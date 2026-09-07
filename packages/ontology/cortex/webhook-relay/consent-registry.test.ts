import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableWebhookRelay } from "./index";
import { ConsentGuardedWebhookRelay, ConsentRegistryFailoverGateway, DurableConsentRegistry } from "./consent-registry";

const SUBJECT = `sha256:${"a".repeat(64)}`;
const NOW = "2026-09-07T06:10:00.000Z";
let roots: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const root of roots) rmSync(root, { recursive: true, force: true }); roots = []; });

function event() {
  return {
    eventId: "relay-event-0001",
    eventType: "whatsapp.lead_followup",
    occurredAt: NOW,
    adUserDataConsent: "GRANTED" as const,
    userIdentifiers: [{ kind: "PHONE_SHA256" as const, value: SUBJECT }],
    data: { templateId: "lead-followup-v1" },
  };
}

function routes() {
  const route = (url: string) => ({ endpoint: new URL(url), bearerToken: () => "bearer-token", signingSecret: () => "s".repeat(32) });
  return { WHATSAPP: [route("https://primary.example/relay"), route("https://backup.example/relay")], SMS: [route("https://sms.example/relay")], OTHER: [route("https://other.example/relay")] } as const;
}

describe("CORTEX #31 consent registry", () => {
  it("persists opt-out across restart and blocks preparation before any relay row is created", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex31-")); roots.push(root);
    const db = join(root, "relay.sqlite");
    const registry = new DurableConsentRegistry(db);
    registry.set({ subjectKey: SUBJECT, channel: "WHATSAPP", status: "GRANTED", policyId: "messaging-v1", expectedRevision: 0, changedAt: NOW });
    registry.set({ subjectKey: SUBJECT, channel: "WHATSAPP", status: "OPTED_OUT", policyId: "messaging-v1", expectedRevision: 1, changedAt: "2026-09-07T06:11:00.000Z" });
    registry.close();

    const reopened = new DurableConsentRegistry(db);
    const base = new DurableWebhookRelay(db, { async send() { throw new Error("must not send"); } }, () => "ACTIVE");
    const relay = new ConsentGuardedWebhookRelay(base, reopened);
    expect(reopened.read(SUBJECT, "WHATSAPP")?.status).toBe("OPTED_OUT");
    expect(() => relay.prepare(event())).toThrow(/opted out/u);
    expect(base.get("relay-event-0001")).toBeUndefined();
    base.close(); reopened.close();
  });

  it("turns a late opt-out into deterministic rejection so the durable event returns to PENDING with zero provider POST", async () => {
    const root = mkdtempSync(join(tmpdir(), "cortex31-")); roots.push(root);
    const db = join(root, "relay.sqlite");
    const registry = new DurableConsentRegistry(db);
    registry.set({ subjectKey: SUBJECT, channel: "WHATSAPP", status: "GRANTED", policyId: "messaging-v1", expectedRevision: 0, changedAt: NOW });
    const fetchMock = vi.fn(async () => new Response(null, { status: 204, headers: { "x-request-id": "provider-request-0001" } }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new ConsentRegistryFailoverGateway({ registry, routes: routes() });
    const base = new DurableWebhookRelay(db, gateway, () => "ACTIVE");
    const relay = new ConsentGuardedWebhookRelay(base, registry);
    relay.prepare(event());
    registry.set({ subjectKey: SUBJECT, channel: "WHATSAPP", status: "OPTED_OUT", policyId: "messaging-v1", expectedRevision: 1, changedAt: "2026-09-07T06:11:00.000Z" });
    await expect(relay.dispatch("relay-event-0001")).rejects.toMatchObject({ code: "REMOTE_REJECTED" });
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(relay.get("relay-event-0001")?.status).toBe("PENDING");
    base.close(); registry.close();
  });

  it("fails over only after deterministic HTTP 429 and preserves the exact event digest", async () => {
    const root = mkdtempSync(join(tmpdir(), "cortex31-")); roots.push(root);
    const db = join(root, "relay.sqlite");
    const registry = new DurableConsentRegistry(db);
    registry.set({ subjectKey: SUBJECT, channel: "WHATSAPP", status: "GRANTED", policyId: "messaging-v1", expectedRevision: 0, changedAt: NOW });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 204, headers: { "x-request-id": "provider-request-0002" } }));
    vi.stubGlobal("fetch", fetchMock);
    const base = new DurableWebhookRelay(db, new ConsentRegistryFailoverGateway({ registry, routes: routes() }), () => "ACTIVE");
    const relay = new ConsentGuardedWebhookRelay(base, registry);
    const prepared = relay.prepare(event());
    const sent = await relay.dispatch(prepared.eventId);
    expect(sent.status).toBe("SENT");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstHeaders = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    const secondHeaders = (fetchMock.mock.calls[1]?.[1] as RequestInit).headers as Record<string, string>;
    expect(firstHeaders["x-nexus-event-digest"]).toBe(prepared.digest);
    expect(secondHeaders["x-nexus-event-digest"]).toBe(prepared.digest);
    base.close(); registry.close();
  });
});
