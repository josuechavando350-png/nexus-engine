import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Cortex11Error, DurableWebhookRelay, FetchWebhookRelayGateway, RelayGatewayError, observeRelayInput, parseRelayInput, type RelayGateway, type RelayInput, type RelayMode } from "./index";

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

  it("supports OBSERVE_ONLY validation without returning event identity or payload", () => {
    const observed = observeRelayInput(event);
    expect(observed.eventDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(observed.eventIdDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(observed.eventType).toBe(event.eventType);
    expect(observed.userIdentifierCount).toBe(1);
    expect(JSON.stringify(observed)).not.toContain(event.eventId);
    expect(JSON.stringify(observed)).not.toContain(identifier.value);
  });
});

describe("CORTEX #11 durable relay", () => {
  it("requires ACTIVE for new durable preparation and remains idempotent by content", () => {
    let mode: RelayMode = "OBSERVE_ONLY";
    const gateway: RelayGateway = { send: vi.fn() };
    const relay = new DurableWebhookRelay(path(), gateway, () => mode, () => Date.parse("2026-09-06T00:00:01.000Z"));
    expect(() => relay.prepare(event)).toThrowError(/OBSERVE_ONLY blocks/u);
    expect(relay.get(event.eventId)).toBeUndefined();
    mode = "ACTIVE";
    const first = relay.prepare(event);
    expect(relay.prepare(event)).toEqual(first);
    expect(() => relay.prepare({ ...event, data: { source: "different" } })).toThrowError(/different relay content/u);
    mode = "KILLED";
    expect(() => relay.prepare({ ...event, eventId: "evt-00000002" })).toThrowError(/KILLED blocks/u);
    relay.close();
  });

  it("rechecks the kill switch immediately before the remote side effect and restores PENDING", async () => {
    let reads = 0;
    const gateway: RelayGateway = { send: vi.fn(async () => ({ requestId: "request-00000001" })) };
    const relay = new DurableWebhookRelay(path(), gateway, () => (++reads <= 3 ? "ACTIVE" : "KILLED"));
    relay.prepare(event);
    await expect(relay.dispatch(event.eventId)).rejects.toMatchObject({ code: "KILLED" });
    expect(gateway.send).not.toHaveBeenCalled();
    expect(relay.get(event.eventId)?.status).toBe("PENDING");
    relay.close();
  });

  it("keeps deterministic remote rejection PENDING but quarantines uncertain outcomes", async () => {
    let rejection = true;
    const gateway: RelayGateway = {
      send: vi.fn(async () => {
        if (rejection) throw new RelayGatewayError("REJECTED", "bad request", 400);
        throw new RelayGatewayError("AMBIGUOUS_OUTCOME", "socket reset after write");
      }),
    };
    const relay = new DurableWebhookRelay(path(), gateway, () => "ACTIVE");
    relay.prepare(event);
    await expect(relay.dispatch(event.eventId)).rejects.toMatchObject({ code: "REMOTE_REJECTED" });
    expect(relay.get(event.eventId)?.status).toBe("PENDING");
    rejection = false;
    await expect(relay.dispatch(event.eventId)).rejects.toMatchObject({ code: "AMBIGUOUS_OUTCOME" });
    expect(relay.get(event.eventId)?.status).toBe("AMBIGUOUS");
    await expect(relay.dispatch(event.eventId)).rejects.toMatchObject({ code: "AMBIGUOUS_OUTCOME" });
    expect(gateway.send).toHaveBeenCalledTimes(2);
    relay.close();
  });

  it("leaves DISPATCHING durable if the destination acknowledges but local SENT persistence is lost", async () => {
    const db = path();
    let relay: DurableWebhookRelay;
    let calls = 0;
    const gateway: RelayGateway = {
      async send() {
        calls += 1;
        relay.close();
        return { requestId: "request-00000009" };
      },
    };
    relay = new DurableWebhookRelay(db, gateway, () => "ACTIVE");
    relay.prepare(event);
    await expect(relay.dispatch(event.eventId)).rejects.toMatchObject({ code: "AMBIGUOUS_OUTCOME" });
    expect(calls).toBe(1);

    const reopened = new DurableWebhookRelay(db, gateway, () => "ACTIVE");
    expect(reopened.get(event.eventId)?.status).toBe("DISPATCHING");
    await expect(reopened.dispatch(event.eventId)).rejects.toMatchObject({ code: "AMBIGUOUS_OUTCOME" });
    expect(calls).toBe(1);
    expect(() => reopened.rollback(event.eventId)).toThrowError(/only PENDING/u);
    reopened.close();
  });

  it("supports safety rollback only from PENDING and never reverses SENT", async () => {
    const gateway: RelayGateway = { send: vi.fn(async () => ({ requestId: "request-00000002" })) };
    const relay = new DurableWebhookRelay(path(), gateway, () => "ACTIVE");
    relay.prepare(event);
    expect(relay.rollback(event.eventId).status).toBe("CANCELLED");
    expect(relay.rollback(event.eventId).status).toBe("CANCELLED");
    expect(await relay.dispatch(event.eventId)).toMatchObject({ status: "CANCELLED" });

    const second = { ...event, eventId: "evt-00000003" };
    relay.prepare(second);
    expect((await relay.dispatch(second.eventId)).status).toBe("SENT");
    expect(() => relay.rollback(second.eventId)).toThrowError(/only PENDING/u);
    relay.close();
  });

  it("persists a successful receipt without exposing hashed identifiers in record metadata", async () => {
    const gateway: RelayGateway = { send: vi.fn(async (_event: RelayInput) => ({ requestId: "request-00000004" })) };
    const db = path();
    const relay = new DurableWebhookRelay(db, gateway, () => "ACTIVE", () => Date.parse("2026-09-06T00:00:02.000Z"));
    relay.prepare(event);
    const sent = await relay.dispatch(event.eventId);
    expect(sent.status).toBe("SENT");
    expect(sent.remoteRequestId).toBe("request-00000004");
    expect(JSON.stringify(sent)).not.toContain(identifier.value);
    relay.close();

    const reopened = new DurableWebhookRelay(db, gateway, () => "ACTIVE");
    expect(reopened.get(event.eventId)?.status).toBe("SENT");
    reopened.close();
  });
});

describe("CORTEX #11 HTTPS gateway", () => {
  it("uses HTTPS, bearer auth, digest and HMAC signature with bounded timeout semantics", async () => {
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => new Response(null, { status: 204, headers: { "x-request-id": "request-00000005" } }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new FetchWebhookRelayGateway(new URL("https://relay.example/v1/events"), "bearer-secret", "s".repeat(32), 1_000);
    const parsed = parseRelayInput(event);
    const receipt = await gateway.send(parsed, `sha256:${"b".repeat(64)}`);
    expect(receipt.requestId).toBe("request-00000005");
    const init = fetchMock.mock.calls[0]?.[1];
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer bearer-secret");
    expect(headers["x-nexus-event-digest"]).toMatch(/^sha256:/u);
    expect(headers["x-nexus-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/u);
    expect(init?.redirect).toBe("error");
  });

  it("distinguishes deterministic 4xx rejection from ambiguous transport or server failure", async () => {
    const denied = new FetchWebhookRelayGateway(new URL("https://relay.example/v1/events"), "bearer-secret", "s".repeat(32));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 422 })));
    await expect(denied.send(parseRelayInput(event), `sha256:${"b".repeat(64)}`)).rejects.toMatchObject({ code: "REJECTED", httpStatus: 422 });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    await expect(denied.send(parseRelayInput(event), `sha256:${"b".repeat(64)}`)).rejects.toMatchObject({ code: "AMBIGUOUS_OUTCOME", httpStatus: 503 });
  });

  it("rejects non-HTTPS production destinations", () => {
    expect(() => new FetchWebhookRelayGateway(new URL("http://relay.example"), "token", "s".repeat(32))).toThrowError(/configuration/u);
  });
});
