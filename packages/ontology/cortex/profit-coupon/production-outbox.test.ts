import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteCouponIssuer } from "./index";
import { SqliteCouponOutboxDispatcher } from "./production-outbox";

const dirs: string[] = [];
function database(): string { const dir = mkdtempSync(join(tmpdir(), "nexus-cortex19-outbox-")); dirs.push(dir); return join(dir, "coupon.sqlite"); }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const request = {
  requestId: "coupon-request-0001",
  subjectHash: `sha256:${"a".repeat(64)}`,
  sku: "product-00000001",
  price: 1000,
  variableCost: 500,
  currency: "MXN",
  eligible: true,
  probabilityEvidence: { probability: 0.2, modelId: "friction-model-0001", modelDigest: `sha256:${"b".repeat(64)}` },
} as const;
const policy = {
  minProfitAmount: 300,
  maxDiscountBps: 2000,
  maxCouponsPerWindow: 5,
  maxDiscountCostPerWindow: 1000,
  frequencyWindowSeconds: 3600,
  tiers: [{ probabilityAtOrBelow: 0.3, discountBps: 1000 }],
} as const;

function seed(db: string): SqliteCouponIssuer {
  const issuer = new SqliteCouponIssuer(db, "s".repeat(32), () => "ACTIVE", () => Date.parse("2026-09-06T00:00:00.000Z"));
  issuer.issue(request, policy);
  return issuer;
}

describe("CORTEX #19 durable outbox", () => {
  it("marks an outbox row sent only after the #17-style durable receipt proves the same event identity", async () => {
    const db = database(); const issuer = seed(db);
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const event = JSON.parse(String(init?.body)) as { eventId: string; stream: string; occurredAt: string; payload: unknown };
      return Response.json({ ...event, sequence: 7 }, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const dispatcher = new SqliteCouponOutboxDispatcher(db, new URL("https://events.example/v1/events"), "e".repeat(32), () => "ACTIVE", 1000);
    expect(dispatcher.pendingCount()).toBe(1);
    await expect(dispatcher.flush()).resolves.toEqual({ attempted: 1, delivered: 1, remaining: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    dispatcher.close(); issuer.close();
  });

  it("keeps an event pending if the remote receipt is ambiguous so retry with the same eventId remains possible", async () => {
    const db = database(); const issuer = seed(db);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ stream: "coupon.issued", eventId: "wrong-event-0001", sequence: 1 }, { status: 201 })));
    const dispatcher = new SqliteCouponOutboxDispatcher(db, new URL("https://events.example/v1/events"), "e".repeat(32), () => "ACTIVE", 1000);
    await expect(dispatcher.flush()).rejects.toThrow(/same event identity/u);
    expect(dispatcher.pendingCount()).toBe(1);
    dispatcher.close(); issuer.close();
  });

  it("does not start the external POST if durable control changes after batch selection", async () => {
    const db = database(); const issuer = seed(db);
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    let reads = 0;
    const dispatcher = new SqliteCouponOutboxDispatcher(db, new URL("https://events.example/v1/events"), "e".repeat(32), () => (++reads === 1 ? "ACTIVE" : "KILLED"), 1000);
    await expect(dispatcher.flush()).rejects.toThrow(/final delivery boundary/u);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dispatcher.pendingCount()).toBe(1);
    dispatcher.close(); issuer.close();
  });

  it("leaves the event pending if control is killed while the remote POST is in flight", async () => {
    const db = database(); const issuer = seed(db);
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const event = JSON.parse(String(init?.body)) as { eventId: string; stream: string; occurredAt: string; payload: unknown };
      return Response.json({ ...event, sequence: 1 }, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    let reads = 0;
    const dispatcher = new SqliteCouponOutboxDispatcher(db, new URL("https://events.example/v1/events"), "e".repeat(32), () => (++reads <= 2 ? "ACTIVE" : "KILLED"), 1000);
    await expect(dispatcher.flush()).rejects.toThrow(/durable acknowledgement/u);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dispatcher.pendingCount()).toBe(1);
    dispatcher.close(); issuer.close();
  });
});
