import { describe, expect, it } from "vitest";
import {
  browserCapabilityDetectionSnippet,
  planSpeculativeDelivery,
  serializeResourceHintTags,
  serializeSpeculationRulesScript,
  validateSpeculativeDeliveryResult,
  type SpeculativeDeliveryRequest,
} from "./speculative-delivery.js";

function request(overrides: Partial<SpeculativeDeliveryRequest> = {}): SpeculativeDeliveryRequest {
  return {
    tenantId: "tenant-a",
    scope: "public-site",
    documentUrl: "https://example.com/start",
    candidates: [
      {
        id: "critical-css",
        target: "/app.css",
        kind: "subresource",
        action: "preload",
        as: "style",
        estimatedBytes: 12_000,
        priority: 1,
        sideEffectFree: true,
        requiresAuthentication: false,
        cacheSafety: "CACHEABLE",
      },
      {
        id: "next",
        target: "/next",
        kind: "navigation",
        action: "prefetch",
        estimatedBytes: 80_000,
        priority: 0.9,
        sideEffectFree: true,
        requiresAuthentication: false,
        cacheSafety: "CACHEABLE",
        eagerness: "eager",
      },
      {
        id: "checkout-info",
        target: "/checkout-info",
        kind: "navigation",
        action: "prerender",
        estimatedBytes: 100_000,
        priority: 0.8,
        sideEffectFree: true,
        requiresAuthentication: false,
        cacheSafety: "CACHEABLE",
        eagerness: "moderate",
      },
    ],
    ...overrides,
  };
}

describe("speculative delivery", () => {
  it("builds deterministic bounded resource hints and speculation rules without claiming browser observation", () => {
    const first = planSpeculativeDelivery(request());
    const second = planSpeculativeDelivery(request());
    expect(first).toEqual(second);
    expect(first.resourceHints).toEqual([{ rel: "preload", href: "https://example.com/app.css", as: "style" }]);
    expect(first.speculationRules.prefetch?.[0]).toMatchObject({ source: "list", urls: ["https://example.com/next"], eagerness: "eager" });
    expect(first.speculationRules.prerender?.[0]).toMatchObject({ urls: ["https://example.com/checkout-info"], eagerness: "moderate" });
    expect(first.capabilityEvidence.some((entry) => entry.state === "CONFIGURED")).toBe(true);
    expect(first.capabilityEvidence.some((entry) => entry.state === "NOT_VERIFIED")).toBe(true);
    expect(first.capabilityEvidence.some((entry) => entry.state === "OBSERVED")).toBe(false);
    expect(() => validateSpeculativeDeliveryResult(first)).not.toThrow();
  });

  it("honors reduced-data and constrained-network contexts by blocking navigation speculation", () => {
    const saveData = planSpeculativeDelivery(request({ context: { saveData: true } }));
    expect(saveData.decisions.filter((entry) => entry.action !== "preload").every((entry) => !entry.selected && entry.reason === "REDUCED_DATA_BLOCKED")).toBe(true);
    expect(saveData.resourceHints).toHaveLength(1);
    expect(saveData.speculationRules).toEqual({});

    const slow = planSpeculativeDelivery(request({ context: { effectiveType: "2g" } }));
    expect(slow.decisions.filter((entry) => entry.action !== "preload").every((entry) => !entry.selected && entry.reason === "CONSTRAINED_NETWORK_BLOCKED")).toBe(true);
  });

  it("blocks unsafe navigation and requires explicit anonymous policy for cross-origin preload", () => {
    const result = planSpeculativeDelivery(request({
      candidates: [
        {
          id: "cross-nav",
          target: "https://other.example/page",
          kind: "navigation",
          action: "prefetch",
          estimatedBytes: 10,
          priority: 1,
          sideEffectFree: true,
          requiresAuthentication: false,
          cacheSafety: "CACHEABLE",
        },
        {
          id: "private-nav",
          target: "/account",
          kind: "navigation",
          action: "prerender",
          estimatedBytes: 10,
          priority: 0.9,
          sideEffectFree: true,
          requiresAuthentication: true,
          cacheSafety: "NO_STORE",
        },
        {
          id: "cdn-font",
          target: "https://cdn.example/font.woff2",
          kind: "subresource",
          action: "preload",
          as: "font",
          estimatedBytes: 10,
          priority: 0.8,
          sideEffectFree: true,
          requiresAuthentication: false,
          cacheSafety: "CACHEABLE",
          crossOriginMode: "ANONYMOUS",
        },
      ],
    }));
    expect(result.decisions.find((entry) => entry.candidateId === "cross-nav")?.reason).toBe("CROSS_ORIGIN_NAVIGATION_BLOCKED");
    expect(result.decisions.find((entry) => entry.candidateId === "private-nav")?.reason).toBe("AUTHENTICATED_NAVIGATION_BLOCKED");
    expect(result.decisions.find((entry) => entry.candidateId === "cdn-font")?.selected).toBe(true);
    expect(result.resourceHints[0]).toMatchObject({ crossorigin: "anonymous" });
  });

  it("blocks side-effecting and no-store prerender targets", () => {
    const result = planSpeculativeDelivery(request({
      candidates: [
        {
          id: "logout",
          target: "/logout",
          kind: "navigation",
          action: "prefetch",
          estimatedBytes: 1,
          priority: 1,
          sideEffectFree: false,
          requiresAuthentication: false,
          cacheSafety: "CACHEABLE",
        },
        {
          id: "private",
          target: "/private",
          kind: "navigation",
          action: "prerender",
          estimatedBytes: 1,
          priority: 0.5,
          sideEffectFree: true,
          requiresAuthentication: false,
          cacheSafety: "NO_STORE",
        },
      ],
    }));
    expect(result.decisions.map((entry) => entry.reason)).toEqual(["SIDE_EFFECT_RISK_BLOCKED", "NO_STORE_PRERENDER_BLOCKED"]);
  });

  it("enforces request, byte and navigation budgets deterministically", () => {
    const result = planSpeculativeDelivery(request({
      policy: { maxSelectedCandidates: 1, maxTotalBytes: 100_000, maxNavigationBytes: 90_000 },
    }));
    expect(result.decisions[0]).toMatchObject({ candidateId: "critical-css", selected: true });
    expect(result.decisions.slice(1).every((entry) => entry.reason === "REQUEST_BUDGET_EXHAUSTED")).toBe(true);

    const byteBound = planSpeculativeDelivery(request({ policy: { maxTotalBytes: 12_001, maxNavigationBytes: 12_001 } }));
    expect(byteBound.decisions.find((entry) => entry.candidateId === "next")?.reason).toBe("BYTE_BUDGET_EXHAUSTED");
  });

  it("rejects unsafe URLs, duplicate identities and oversized input rather than silently sanitizing", () => {
    const bad = request({
      candidates: [{
        id: "bad",
        target: "/x\r\nX-Evil: 1",
        kind: "navigation",
        action: "prefetch",
        estimatedBytes: 1,
        priority: 1,
        sideEffectFree: true,
        requiresAuthentication: false,
        cacheSafety: "CACHEABLE",
      }],
    });
    expect(() => planSpeculativeDelivery(bad)).toThrow(/control characters/);
    expect(() => planSpeculativeDelivery(request({
      candidates: [
        { id: "a", target: "/x", kind: "navigation", action: "prefetch", estimatedBytes: 1, priority: 1, sideEffectFree: true, requiresAuthentication: false, cacheSafety: "CACHEABLE" },
        { id: "b", target: "/x", kind: "navigation", action: "prefetch", estimatedBytes: 1, priority: 0.5, sideEffectFree: true, requiresAuthentication: false, cacheSafety: "CACHEABLE" },
      ],
    }))).toThrow(/duplicate speculation candidate/);
    expect(() => planSpeculativeDelivery(request({ tenantId: "__proto__" }))).toThrow(/forbidden identity/);
  });

  it("records browser support and only treats real runtime events as OBSERVED", () => {
    const real = planSpeculativeDelivery(request({
      browserObservation: {
        authority: "BROWSER_RUNTIME",
        source: "playwright-capture.json",
        observedAt: "2026-08-30T20:00:00Z",
        browser: "Chromium",
        browserVersion: "152.0.0.0",
        supports: { speculationRules: true, preload: true, prefetch: true },
        events: [{ action: "prefetch", url: "/next", outcome: "COMPLETED" }],
      },
    }));
    expect(real.capabilityEvidence.some((entry) => entry.capability === "SPECULATION_RULES" && entry.state === "SUPPORTED")).toBe(true);
    expect(real.capabilityEvidence.some((entry) => entry.capability === "PREFETCH" && entry.state === "OBSERVED")).toBe(true);

    const synthetic = planSpeculativeDelivery(request({
      browserObservation: {
        authority: "SYNTHETIC_TEST",
        source: "fixture",
        observedAt: "2026-08-30T20:00:00Z",
        browser: "FixtureBrowser",
        browserVersion: "0",
        supports: { speculationRules: true, preload: true, prefetch: true },
        events: [{ action: "prefetch", url: "/next", outcome: "COMPLETED" }],
      },
    }));
    expect(synthetic.capabilityEvidence.some((entry) => entry.state === "OBSERVED")).toBe(false);
    expect(synthetic.capabilityEvidence.some((entry) => entry.reason.includes("synthetic event"))).toBe(true);
  });

  it("detects replay tampering", () => {
    const original = planSpeculativeDelivery(request());
    const tampered = { ...original, selectedBytes: original.selectedBytes + 1 };
    expect(() => validateSpeculativeDeliveryResult(tampered)).toThrow(/replay mismatch/);
  });

  it("fails closed on cancellation and deterministic timeout checks", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => planSpeculativeDelivery(request(), { signal: controller.signal })).toThrow(/CANCELLED/);
    expect(() => planSpeculativeDelivery(request(), { deadlineEpochMs: 10, now: () => 11 })).toThrow(/TIMEOUT/);
  });

  it("serializes XSS-safe hints/rules and exposes a feature-detection snippet", () => {
    const result = planSpeculativeDelivery(request({
      candidates: [{
        id: "image",
        target: "/image.png?a=1&b=2",
        kind: "subresource",
        action: "preload",
        as: "image",
        estimatedBytes: 1,
        priority: 1,
        sideEffectFree: true,
        requiresAuthentication: false,
        cacheSafety: "CACHEABLE",
      }],
    }));
    expect(serializeResourceHintTags(result)).toContain("a=1&amp;b=2");
    expect(serializeSpeculationRulesScript(planSpeculativeDelivery(request()))).toContain('type="speculationrules"');
    expect(browserCapabilityDetectionSnippet()).toContain("HTMLScriptElement.supports");
  });
});
