import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { Cortex19Error, SqliteCouponIssuer, decideCoupon, type DurableCouponEventInput } from "./index";

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
  maxDiscountCostPerWindow: 1000,
  frequencyWindowSeconds: 3600,
  tiers: [{ probabilityAtOrBelow: 0.3, discountBps: 1000 }, { probabilityAtOrBelow: 0.6, discountBps: 500 }],
} as const;

describe("CORTEX #19 financial coupon decision", () => {
  it("uses explicitly supplied probability provenance and business policy tiers", () => {
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
  it("atomically enforces frequency caps and is idempotent by canonical request content", () => {
    const issuer = new SqliteCouponIssuer(path("coupons"), "s".repeat(32), () => "ACTIVE", () => Date.parse("2026-09-06T00:00:00.000Z"));
    const first = issuer.issue(request, policy);
    expect(first.code).toMatch(/^NX-[0-9A-F]{12}$/u);
    expect(issuer.issue(request, policy)).toEqual(first);
    const capped = issuer.issue({ ...request, requestId: "coupon-request-0002" }, policy);
    expect(capped).toMatchObject({ action: "NO_OFFER", reason: "FREQUENCY_CAP", code: null });
    expect(() => issuer.issue({ ...request, price: 999 }, policy)).toThrowError(/different coupon content/u);
    issuer.close();
  });

  it("enforces the configured currency-window discount cost cap before code issuance", () => {
    const issuer = new SqliteCouponIssuer(path("cost"), "s".repeat(32), () => "ACTIVE", () => Date.parse("2026-09-06T00:00:00.000Z"));
    const costPolicy = { ...policy, maxCouponsPerWindow: 10, maxDiscountCostPerWindow: 150 };
    expect(issuer.issue(request, costPolicy)).toMatchObject({ action: "OFFER", discountAmount: 100, windowDiscountCost: 100 });
    const second = issuer.issue({ ...request, requestId: "coupon-request-0002", subjectHash: `sha256:${"c".repeat(64)}` }, costPolicy);
    expect(second).toMatchObject({ action: "NO_OFFER", reason: "COST_CAP", code: null, windowDiscountCost: 100 });
    issuer.close();
  });

  it("rechecks the kill switch after acquiring the ledger lock and before issuance", () => {
    let reads = 0;
    const issuer = new SqliteCouponIssuer(path("kill"), "s".repeat(32), () => (++reads < 2 ? "ACTIVE" : "KILLED"), () => Date.parse("2026-09-06T00:00:00.000Z"));
    expect(() => issuer.issue(request, policy)).toThrowError(/disabled before issuance/u);
    issuer.close();
  });

  it("emits issued coupons through an abstract durable outbox without raw subject identity", () => {
    const issuer = new SqliteCouponIssuer(path("outbox"), "s".repeat(32), () => "ACTIVE", () => Date.parse("2026-09-06T00:00:00.000Z"));
    issuer.issue(request, policy);
    const published: DurableCouponEventInput[] = [];
    const writer = { append(event: DurableCouponEventInput) { published.push(event); return { sequence: published.length }; } };
    expect(issuer.flushEvents(writer)).toBe(1);
    expect(issuer.flushEvents(writer)).toBe(0);
    expect(published).toHaveLength(1);
    expect(JSON.stringify(published[0])).not.toContain(request.subjectHash);
    expect(JSON.stringify(published[0])).toContain(request.probabilityEvidence.modelDigest);
    issuer.close();
  });
});
