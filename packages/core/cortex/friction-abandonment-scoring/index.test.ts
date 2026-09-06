import { describe, expect, it } from "vitest";
import { parseFrictionSnapshot, scoreFrictionAbandonment } from "./index.js";

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    deviceClass: "DESKTOP",
    elapsedMs: 60_000,
    scrollDepthBps: 8_000,
    maxInteractionLatencyMs: 150,
    interactionCount: 10,
    validationErrorCount: 0,
    repeatedActionCount: 0,
    longTaskCount: 0,
    visibilityLossCount: 0,
    ...overrides,
  };
}

describe("CORTEX #9 friction abandonment scoring", () => {
  it("accepts an exact bounded privacy-minimized contract", () => {
    expect(parseFrictionSnapshot(snapshot())).toEqual(snapshot());
    expect(() => parseFrictionSnapshot(snapshot({ email: "not-allowed@example.invalid" }))).toThrow(/unknown or missing/i);
    expect(() => parseFrictionSnapshot(snapshot({ scrollDepthBps: 10_001 }))).toThrow(/scrollDepthBps/i);
    expect(() => parseFrictionSnapshot(snapshot({ deviceClass: "TABLET" }))).toThrow(/deviceClass/i);
  });

  it("produces a deterministic bounded probability and explicit evidence", () => {
    const first = scoreFrictionAbandonment(snapshot());
    const second = scoreFrictionAbandonment(snapshot());
    expect(first).toEqual(second);
    expect(first.abandonmentProbability).toBeGreaterThanOrEqual(0);
    expect(first.abandonmentProbability).toBeLessThanOrEqual(1);
    expect(first.estimator).toBe("DETERMINISTIC_FRICTION_INDEX_V1");
    expect(first.riskBand).toBe("LOW");
  });

  it("raises risk monotonically as measured friction grows", () => {
    const low = scoreFrictionAbandonment(snapshot());
    const high = scoreFrictionAbandonment(snapshot({
      scrollDepthBps: 0,
      maxInteractionLatencyMs: 900,
      validationErrorCount: 10,
      repeatedActionCount: 10,
      longTaskCount: 20,
      visibilityLossCount: 5,
    }));
    expect(high.abandonmentProbability).toBeGreaterThan(low.abandonmentProbability);
    expect(high.riskBand).toBe("HIGH");
  });

  it("does not create a mobile penalty without measured mobile friction", () => {
    const desktop = scoreFrictionAbandonment(snapshot({ deviceClass: "DESKTOP" }));
    const mobile = scoreFrictionAbandonment(snapshot({ deviceClass: "MOBILE" }));
    expect(mobile.abandonmentProbability).toBe(desktop.abandonmentProbability);
    expect(mobile.evidence).toEqual(desktop.evidence);
  });
});
