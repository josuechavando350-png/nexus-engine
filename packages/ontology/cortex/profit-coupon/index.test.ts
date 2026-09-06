import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteDurableEventStream } from "../event-budget-stream/index";
import { Cortex19Error, SqliteCouponIssuer, decideCoupon } from "./index";

const dirs: string[] = [];
function path(name: string): string { const dir = mkdtempSync(join(tmpdir(), `nexus-cortex19-${name}-`)); dirs.push(dir); return join(dir, `${name}.sqlite`); }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

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
  maxCouponsPerWindow: 1,
  frequencyWindowSeconds: 3600,
  tiers: [{ probabilityAtOrBelow: 0.3, discountBps: 1000 }, { probabilityAtOrBelow: 0.6, discountBps: 500 }],
} as const;

describe("CORTEX #19 financial coupon decision", () => {
  it("uses explicitly supplied calibrated-probability provenance and business policy tiers", () => {
    expect(decideCoupon(request, policy)).toEqual({ action: "OFFER", reason: "OFFER_ALLOWED", discountBps: 1000, discountAmount: 100, priceAfterDiscount: 900, profitAfterDiscount: 400 });
  });

  it("refuses incentives that would violate the configured minimum profit", () => {
    const result = decideCoupon(request, { ...policy, minProfitAmount: 450 });
    expect(result.action).toBe("NO_OFFER");
    expect(result.reason).toBe("MARGIN_GUARDRAIL");
  });

  it("refuses ineligible requests and missing model provenance", () => {
    expect(decideCoupon({ ...request, eligible: false }, policy).reason).toBe("INELIGIBLE");
    expect(() => decideCoupon({ ...request, probabilityEvidence: { ...request.probabilityEvidence, modelDigest: "unknown" } }, policy)).toThrowError(Cortex19Error);
  });
});

describe("CORTEX #19 durable issuance", () => {
  it("atomically enforces frequency limits and is idempotent by request content", () => {
    const issuer = new SqliteCouponIssuer(path("coupons"), "s".repeat(32), () => "ACTIVE", () => Date.parse("2026-09-06T00:00:00.000Z"));
    const first = issuer.issue(request, policy);
    expect(first.code).toMatch(/^NX-[0-9A-F]{12}$/u);
    expect(issuer.issue(request, policy)).toEqual(first);
    expect(() => issuer.issue({ ...request, requestId: "coupon-request-0002" }, policy)).toThrowError(/frequency limit/u);
    expect(() => issuer.issue({ ...request, price: 999 })).toThrowError(/different coupon content/u);
    issuer.close();
  });

  it("rechecks the kill switch after acquiring the ledger lock and before issuance", () => {
    let reads = 0;
    const issuer = new SqliteCouponIssuer(path("kill"), "s".repeat(32), () => (++reads < 3 ? "ACTIVE" : "KILLED"), () => Date.parse("2026-09-06T00:00:00.000Z"));
    expect(() => issuer.issue(request, policy)).toThrowError(/disabled before issuance/u);
    issuer.close();
  });

  it("emits issued coupons through a durable outbox into CORTEX #17 without raw subject identity", () => {
    const issuer = new SqliteCouponIssuer(path("outbox"), "s".repeat(32), () => "ACTIVE", () => Date.parse("2026-09-06T00:00:00.000Z"));
    issuer.issue(request, policy);
    const events = new SqliteDurableEventStream(path("events"));
    expect(issuer.flushEvents(events)).toBe(1);
    expect(issuer.flushEvents(events)).toBe(0);
    const published = events.read("coupon.issued", 0, 10);
    expect(published).toHaveLength(1);
    expect(JSON.stringify(published[0])).not.toContain(request.subjectHash);
    expect(JSON.stringify(published[0])).toContain(request.probabilityEvidence.modelDigest);
    events.close(); issuer.close();
  });
});
