import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Cortex11Error, DurableWebhookRelay, FetchWebhookRelayGateway, parseRelayInput, type RelayGateway, type RelayInput, type RelayMode } from "./index";

const dirs: string[] = [];
const identifier = { kind: "EMAIL_SHA256", value: `sha256:${"a".repeat(64)}` } as const;
const event = {
  eventId: "evt-00000001",
  eventType: "lead.accepted",
  occurredAt: "2026-09-06T00:00:00.000Z",
  adUserDataConsent: "GRANTED",
  userIdentifiers: [identifier],
  data: { source: "web", amount: 125 },
} as const;

function path(): string {
  const dir = mkdtempSync(join(tmpdir(), "nexus-cortex11-"));
  dirs.push(dir);
  return join(dir, "relay.sqlite");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CORTEX #11 consent guardrails", () => {
  it("accepts only the exact minimized contract and forbids identifiers when consent is denied", () => {
    expect(parseRelayInput(event)).toEqual(event);
    expect(() => parseRelayInput({ ...event, email: "raw@example.invalid" })).toThrowError(/unsupported/u);
    expect(() => parseRelayInput({ ...event, adUserDataConsent: "DENIED" })).toThrowError(Cortex11Error);
    expect(() => parseRelayInput({ ...event, userIdentifiers: [{ ...identifier, value: "raw@example.invalid" }] })).toThrowError(/hashed/u);
  });
});

describe("CORTEX #11 durable relay", () => {
  it("is idempotent by content and fails conflicts closed", () => {
    let mode: RelayMode = "OBSERVE_ONLY";
    const gateway: RelayGateway = { send: vi.fn() };
    const relay = new DurableWebhookRelay(path(), gateway, () => mode, () => Date.parse("2026-09-06T00:00:01.000Z"));
    const first = relay.prepare(event);
    expect(relay.prepare(event)).toEqual(first);
    expect(() => relay.prepare({ ...event, data: { source: "different" } })).toThrowError(/different relay content/u);
    mode = "KILLED";
    expect(() => relay.prepare({ ...event, eventId: "evt-00000002" })).toThrowError(/killed/u);
    relay.close();
  });

  it("rechecks the kill switch immediately before the remote side effect", async () => {
    let reads = 0;
    const gateway: RelayGateway = { send: vi.fn(async () => ({ requestId: "request-00000001" })) };
    const relay = new DurableWebhookRelay(path(), gateway, () => (++reads === 1 ? "OBSERVE_ONLY" : reads === 2 ? "ACTIVE" : "KILLED"));
    relay.prepare(event);
    await expect(relay.dispatch(event.eventId)).rejects.toMatchObject({ code: "KILLED" });
    expect(gateway.send).not.toHaveBeenCalled();
    relay.close();
  });

  it("marks any uncertain remote outcome ambiguous and refuses automatic replay", async () => {
    let mode: RelayMode = "ACTIVE";
    const gateway: RelayGateway = { send: vi.fn(async () => { throw new Error("socket reset after write"); }) };
    const relay = new DurableWebhookRelay(path(), gateway, () => mode);
    relay.prepare(event);
    await expect(relay.dispatch(event.eventId)).rejects.toMatchObject({ code: "AMBIGUOUS_OUTCOME" });
    expect(relay.get(event.eventId)?.status).toBe("AMBIGUOUS");
    await expect(relay.dispatch(event.eventId)).rejects.toMatchObject({ code: "AMBIGUOUS_OUTCOME" });
    expect(gateway.send).toHaveBeenCalledTimes(1);
    mode = "KILLED";
    relay.close();
  });

  it("persists a successful receipt without exposing raw identifiers in record metadata", async () => {
    const gateway: RelayGateway = { send: vi.fn(async (_event: RelayInput) => ({ requestId: "request-00000002" })) };
    const db = path();
    const relay = new DurableWebhookRelay(db, gateway, () => "ACTIVE", () => Date.parse("2026-09-06T00:00:02.000Z"));
    relay.prepare(event);
    const sent = await relay.dispatch(event.eventId);
    expect(sent.status).toBe("SENT");
    expect(sent.remoteRequestId).toBe("request-00000002");
    expect(JSON.stringify(sent)).not.toContain(identifier.value);
    relay.close();

    const reopened = new DurableWebhookRelay(db, gateway, () => "ACTIVE");
    expect(reopened.get(event.eventId)?.status).toBe("SENT");
    reopened.close();
  });
});

describe("CORTEX #11 HTTPS gateway", () => {
  it("uses HTTPS, bearer auth, digest and HMAC signature with bounded timeout semantics", async () => {
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => new Response(null, { status: 204, headers: { "x-request-id": "request-00000003" } }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new FetchWebhookRelayGateway(new URL("https://relay.example/v1/events"), "bearer-secret", "s".repeat(32), 1_000);
    const parsed = parseRelayInput(event);
    const receipt = await gateway.send(parsed, `sha256:${"b".repeat(64)}`);
    expect(receipt.requestId).toBe("request-00000003");
    const init = fetchMock.mock.calls[0]?.[1];
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer bearer-secret");
    expect(headers["x-nexus-event-digest"]).toMatch(/^sha256:/u);
    expect(headers["x-nexus-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/u);
    expect(init?.redirect).toBe("error");
  });

  it("rejects non-HTTPS production destinations", () => {
    expect(() => new FetchWebhookRelayGateway(new URL("http://relay.example"), "token", "s".repeat(32))).toThrowError(/configuration/u);
  });
});
