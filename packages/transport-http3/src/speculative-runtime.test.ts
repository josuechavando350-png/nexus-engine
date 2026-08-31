import { describe, expect, it } from "vitest";
import { parseSpeculativeDeliveryRequest, planSpeculativeDelivery } from "./speculative-runtime.js";

function validRequest() {
  return {
    tenantId: "tenant-a",
    scope: "public-site",
    documentUrl: "https://example.com/",
    candidates: [
      {
        id: "hero-css",
        target: "/assets/hero.css",
        kind: "subresource",
        action: "preload",
        as: "style",
        estimatedBytes: 24_000,
        priority: 1,
        sideEffectFree: true,
        requiresAuthentication: false,
        cacheSafety: "CACHEABLE",
      },
      {
        id: "services",
        target: "/services",
        kind: "navigation",
        action: "prefetch",
        estimatedBytes: 120_000,
        priority: 0.8,
        sideEffectFree: true,
        requiresAuthentication: false,
        cacheSafety: "CACHEABLE",
        eagerness: "moderate",
      },
    ],
    context: { saveData: false, prefersReducedData: false, effectiveType: "4g" },
  };
}

describe("strict speculative runtime boundary", () => {
  it("parses and plans deterministic valid input", () => {
    const first = planSpeculativeDelivery(validRequest());
    const second = planSpeculativeDelivery(JSON.parse(JSON.stringify(validRequest())));
    expect(first).toEqual(second);
    expect(first.resourceHints).toHaveLength(1);
    expect(first.speculationRules.prefetch).toHaveLength(1);
  });

  it("rejects unknown fields rather than silently widening the contract", () => {
    expect(() => parseSpeculativeDeliveryRequest({ ...validRequest(), adminOverride: true })).toThrow(/unknown field adminOverride/);
    const request = validRequest();
    request.candidates[0] = { ...request.candidates[0], action: "teleport" } as never;
    expect(() => parseSpeculativeDeliveryRequest(request)).toThrow(/action has unsupported value/);
  });

  it("rejects prototype-pollution keys", () => {
    const request = JSON.parse(JSON.stringify(validRequest())) as Record<string, unknown>;
    Object.defineProperty(request, "__proto__", { value: { polluted: true }, enumerable: true, configurable: true });
    expect(() => parseSpeculativeDeliveryRequest(request)).toThrow(/forbidden key __proto__/);
  });

  it("rejects wrong runtime scalar types", () => {
    const request = validRequest() as unknown as Record<string, unknown>;
    request.context = { saveData: "false", prefersReducedData: false, effectiveType: "4g" };
    expect(() => parseSpeculativeDeliveryRequest(request)).toThrow(/saveData must be boolean or null/);
  });

  it("rejects caller-forged browser runtime authority while allowing clearly synthetic evidence", () => {
    const forged = {
      ...validRequest(),
      browserObservation: {
        authority: "BROWSER_RUNTIME",
        source: "caller.json",
        observedAt: "2026-08-31T00:00:00.000Z",
        browser: "Chromium",
        browserVersion: "152",
        supports: { speculationRules: true, preload: true, prefetch: true },
        events: [{ action: "prefetch", url: "/services", outcome: "COMPLETED" }],
      },
    };
    expect(() => planSpeculativeDelivery(forged)).toThrow(/cannot assert BROWSER_RUNTIME authority/);

    const synthetic = {
      ...forged,
      browserObservation: { ...forged.browserObservation, authority: "SYNTHETIC_TEST" },
    };
    const result = planSpeculativeDelivery(synthetic);
    expect(result.capabilityEvidence.some((entry) => entry.state === "OBSERVED")).toBe(false);
  });

  it("fails closed on oversized candidate sets", () => {
    const request = validRequest();
    request.candidates = Array.from({ length: 129 }, (_, index) => ({
      ...request.candidates[0],
      id: `asset-${index}`,
      target: `/assets/${index}.css`,
    }));
    expect(() => planSpeculativeDelivery(request)).toThrow(/candidate input exceeds/);
  });
});
