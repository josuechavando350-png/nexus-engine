import { describe, expect, it, vi } from "vitest";
import {
  certifyCwvLifecycleOptimization,
  createCwvBuildOptimizationPlan,
  cwvEdgeResponseHeaders,
  evaluateCwvEdgeRequest,
  evaluateCwvRuntimeOptimization,
  executeCwvBuildOptimizationPlan,
  type CwvBuildOptimizationAdapter,
  type CwvMetricsSnapshot,
  type CwvRegressionGuardrails,
} from "./index";

const D1 = `sha256:${"1".repeat(64)}` as const;
const D2 = `sha256:${"2".repeat(64)}` as const;
const D3 = `sha256:${"3".repeat(64)}` as const;

const plan = createCwvBuildOptimizationPlan("pyme-cwv-policy-v1", [
  { actionId: "critical-css-main", kind: "CRITICAL_CSS", target: "/app.css", required: true },
  { actionId: "image-hero-main", kind: "IMAGE_PERCEPTUAL", target: "/hero.jpg", required: true },
]);

const before: CwvMetricsSnapshot = Object.freeze({ lcpMs: 2800, inpMs: 240, cls: 0.08, ttfbMs: 650, totalJsBytes: 400_000, totalCssBytes: 90_000, imageBytes: 1_800_000, fontBytes: 180_000 });
const after: CwvMetricsSnapshot = Object.freeze({ lcpMs: 2100, inpMs: 170, cls: 0.04, ttfbMs: 520, totalJsBytes: 350_000, totalCssBytes: 70_000, imageBytes: 1_100_000, fontBytes: 150_000 });
const guardrails: CwvRegressionGuardrails = Object.freeze({ maxLcpRegressionMs: 100, maxInpRegressionMs: 50, maxClsRegression: 0.01, maxTtfbRegressionMs: 100, maxJsGrowthBytes: 10_000, maxCssGrowthBytes: 5_000, maxImageGrowthBytes: 10_000, maxFontGrowthBytes: 5_000 });

function appliedReceipts() {
  return [
    { actionId: "critical-css-main", kind: "CRITICAL_CSS" as const, status: "APPLIED" as const, beforeDigest: D1, afterDigest: D2, evidenceDigest: D3 },
    { actionId: "image-hero-main", kind: "IMAGE_PERCEPTUAL" as const, status: "APPLIED" as const, beforeDigest: D1, afterDigest: D2, evidenceDigest: D3 },
  ];
}

describe("CORTEX #33 lifecycle CWV optimization pipeline", () => {
  it("rejects NO_CHANGE for a required build-time optimization", async () => {
    const adapter: CwvBuildOptimizationAdapter = {
      apply: vi.fn(async (action) => ({ actionId: action.actionId, kind: action.kind, status: "NO_CHANGE" as const, beforeDigest: D1, afterDigest: D1, evidenceDigest: D3 })),
    };
    await expect(executeCwvBuildOptimizationPlan(plan, adapter)).rejects.toThrow(/was not applied/u);
  });

  it("accepts exact applied receipts and certifies measured improvements with visual and functional proof", async () => {
    const receipts = appliedReceipts();
    const adapter: CwvBuildOptimizationAdapter = { apply: vi.fn(async (action) => receipts.find((receipt) => receipt.actionId === action.actionId)!) };
    const executed = await executeCwvBuildOptimizationPlan(plan, adapter);
    const certification = certifyCwvLifecycleOptimization({
      plan,
      receipts: executed,
      before,
      after,
      proofs: { visual: D2, functional: D3 },
      guardrails,
    });
    expect(certification.improvements).toEqual({ lcpMs: 700, inpMs: 70, cls: 0.04, ttfbMs: 130, totalJsBytes: 50_000, totalCssBytes: 20_000, imageBytes: 700_000, fontBytes: 30_000 });
  });

  it("rejects image and font growth beyond configured guardrails", () => {
    expect(() => certifyCwvLifecycleOptimization({
      plan,
      receipts: appliedReceipts(),
      before,
      after: { ...after, imageBytes: before.imageBytes + 10_001 },
      proofs: { visual: D2, functional: D3 },
      guardrails,
    })).toThrow(/image growth/u);
    expect(() => certifyCwvLifecycleOptimization({
      plan,
      receipts: appliedReceipts(),
      before,
      after: { ...after, fontBytes: before.fontBytes + 5_001 },
      proofs: { visual: D2, functional: D3 },
      guardrails,
    })).toThrow(/font growth/u);
  });

  it("keeps private, query-bearing and killed requests out of edge optimization", () => {
    const active = { version: 1 as const, policyId: "pyme-edge-v1", mode: "ACTIVE" as const, routes: [{ path: "/", cacheControl: "public, max-age=60, s-maxage=300, stale-while-revalidate=600", lcpPreloadPath: "/hero.avif", lcpPreloadAs: "image" as const }] };
    expect(evaluateCwvEdgeRequest(active, { url: "https://example.test/", method: "GET", hasAuthorization: false, hasCookie: true }).reason).toBe("PRIVATE_CONTEXT");
    expect(evaluateCwvEdgeRequest(active, { url: "https://example.test/?lead=1", method: "GET", hasAuthorization: false, hasCookie: false }).reason).toBe("QUERY_PRESENT");
    expect(evaluateCwvEdgeRequest({ ...active, mode: "KILLED" }, { url: "https://example.test/", method: "GET", hasAuthorization: false, hasCookie: false }).reason).toBe("KILLED");
  });

  it("emits concrete cache and preload headers only for allowlisted public routes", () => {
    const policy = { version: 1 as const, policyId: "pyme-edge-v1", mode: "ACTIVE" as const, routes: [{ path: "/", cacheControl: "public, max-age=60, s-maxage=300, stale-while-revalidate=600", lcpPreloadPath: "/font.woff2", lcpPreloadAs: "font" as const }] };
    const decision = evaluateCwvEdgeRequest(policy, { url: "https://example.test/", method: "GET", hasAuthorization: false, hasCookie: false });
    expect(decision.optimized).toBe(true);
    expect(cwvEdgeResponseHeaders(decision)).toEqual({ "cache-control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600", link: "</font.woff2>; rel=preload; as=font; crossorigin=anonymous" });
  });

  it("reuses the existing CWV runtime decision to yield non-critical JavaScript under INP/LCP pressure", () => {
    const decision = evaluateCwvRuntimeOptimization({ visibility: "VISIBLE", lcpMs: 3100, cls: 0.02, inpMs: 280, recentLongTaskMs: 80 });
    expect(decision.state).toBe("PRESSURE");
    expect(decision.reasons).toEqual(["LCP", "INP"]);
    expect(decision.shouldSuspendSpeculation).toBe(true);
    expect(decision.javascriptScheduling).toBe("YIELD_NON_CRITICAL");
  });
});
