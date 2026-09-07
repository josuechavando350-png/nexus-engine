import test from "node:test";
import assert from "node:assert/strict";
import { decideDynamicPrice, SqliteDynamicPricingController, PriceAdapterError, type DynamicPriceAdapter, type DynamicPricingPolicy } from "./dynamic-pricing.js";

const MODEL = "pricing-model-v1";
const DIGEST = `sha256:${"a".repeat(64)}` as const;
const policy: DynamicPricingPolicy = {
  version: 1,
  allowedModelDigests: { [MODEL]: DIGEST },
  skuRules: [{
    sku: "sku-basic",
    allowedMarkets: ["mx-national"],
    allowedChannels: ["web"],
    minPrice: 80,
    maxPrice: 130,
    minProfitAmount: 25,
    minGrossMarginRatio: 0.25,
    maxAbsoluteAdjustmentBps: 2000,
    minInventoryUnits: 1,
    tiers: [
      { probabilityAtOrBelow: 0.4, adjustmentBps: -1000 },
      { probabilityAtOrBelow: 0.8, adjustmentBps: -500 },
      { probabilityAtOrBelow: 1, adjustmentBps: 500 },
    ],
  }],
};
function request(probability = 0.3) {
  return { requestId: "price-request-001", sku: "sku-basic", marketId: "mx-national", channel: "web", currency: "MXN", currentPrice: 100, variableCost: 50, inventoryUnits: 10, probabilityEvidence: { probability, modelId: MODEL, modelDigest: DIGEST } };
}

test("pricing contract rejects sensitive identity fields instead of ignoring them", () => {
  assert.throws(() => decideDynamicPrice({ ...request(), email: "person@example.com" }, policy), /forbidden sensitive field email/);
  assert.throws(() => decideDynamicPrice({ ...request(), age: 32 }, policy), /forbidden sensitive field age/);
  assert.throws(() => decideDynamicPrice({ ...request(), subjectHash: `sha256:${"b".repeat(64)}` }, policy), /forbidden sensitive field subjectHash/);
});

test("model provenance, margin and market constraints gate price changes", () => {
  const allowed = decideDynamicPrice(request(0.3), policy);
  assert.equal(allowed.action, "CHANGE_PRICE");
  assert.equal(allowed.nextPrice, 90);
  assert.equal(allowed.projectedProfit, 40);

  const wrongModel = decideDynamicPrice({ ...request(), probabilityEvidence: { probability: 0.3, modelId: MODEL, modelDigest: `sha256:${"c".repeat(64)}` } }, policy);
  assert.equal(wrongModel.reason, "MODEL_NOT_ALLOWED");

  const blockedMarket = decideDynamicPrice({ ...request(), marketId: "other-market" }, policy);
  assert.equal(blockedMarket.reason, "MARKET_BLOCKED");

  const tightPolicy: DynamicPricingPolicy = { ...policy, skuRules: [{ ...policy.skuRules[0]!, minProfitAmount: 45 }] };
  assert.equal(decideDynamicPrice(request(), tightPolicy).reason, "MARGIN_GUARDRAIL");
});

test("durable controller rechecks remote current price, applies idempotently and rolls back exact prior price", async () => {
  let remote = 100;
  const mutations: { expectedPrice: number; nextPrice: number; idempotencyKey: string }[] = [];
  const adapter: DynamicPriceAdapter = {
    async readPrice() { return remote; },
    async mutatePrice(input) {
      assert.equal(remote, input.expectedPrice);
      mutations.push({ expectedPrice: input.expectedPrice, nextPrice: input.nextPrice, idempotencyKey: input.idempotencyKey });
      remote = input.nextPrice;
      return { mutationId: `mutation-${mutations.length}-abcdef`, observedPrice: remote };
    },
  };
  let mode: "ACTIVE" | "OBSERVE_ONLY" | "KILLED" = "ACTIVE";
  const controller = new SqliteDynamicPricingController(":memory:", policy, adapter, () => mode, () => Date.parse("2026-09-07T06:00:00.000Z"));
  try {
    const prepared = controller.prepare(request());
    assert.equal(prepared.status, "PREPARED");
    const applied = await controller.apply(prepared.requestId);
    assert.equal(applied.status, "APPLIED");
    assert.equal(remote, 90);
    assert.equal((await controller.apply(prepared.requestId)).status, "APPLIED");
    assert.equal(mutations.length, 1);
    const rolled = await controller.rollback(prepared.requestId);
    assert.equal(rolled.status, "ROLLED_BACK");
    assert.equal(remote, 100);
    assert.match(mutations[1]!.idempotencyKey, /:rollback$/);
  } finally { controller.close(); }
});

test("uncertain remote mutation quarantines the request instead of blind retry", async () => {
  const adapter: DynamicPriceAdapter = {
    async readPrice() { return 100; },
    async mutatePrice() { throw new PriceAdapterError("AMBIGUOUS_OUTCOME", "timeout after write"); },
  };
  const controller = new SqliteDynamicPricingController(":memory:", policy, adapter, () => "ACTIVE");
  try {
    controller.prepare(request());
    await assert.rejects(() => controller.apply("price-request-001"), /ambiguous/i);
    assert.equal(controller.get("price-request-001")?.status, "AMBIGUOUS");
    await assert.rejects(() => controller.apply("price-request-001"), /operator reconciliation/);
  } finally { controller.close(); }
});
