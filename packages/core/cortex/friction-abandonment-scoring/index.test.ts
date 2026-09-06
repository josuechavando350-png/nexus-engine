import { describe, expect, it } from "vitest";
import { parseFrictionProbabilityModel, parseFrictionSnapshot, scoreFrictionAbandonment } from "./index.js";

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

function model(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    modelId: "test-calibration-v1",
    sourceDigest: `sha256:${"a".repeat(64)}`,
    intercept: -3,
    coefficients: {
      interactionLatency: 2,
      validationErrorRatio: 2,
      repeatedActionRatio: 2,
      longTaskRate: 2,
      visibilityLossRate: 2,
      scrollDeficit: 2,
      mobileIndicator: 0,
    },
    lowRiskMax: 0.33,
    mediumRiskMax: 0.66,
    ...overrides,
  };
}

describe("CORTEX #9 friction abandonment scoring", () => {
  it("accepts an exact bounded privacy-minimized snapshot contract", () => {
    expect(parseFrictionSnapshot(snapshot())).toEqual(snapshot());
    expect(() => parseFrictionSnapshot(snapshot({ email: "not-allowed@example.invalid" }))).toThrow(/unknown or missing/i);
    expect(() => parseFrictionSnapshot(snapshot({ scrollDepthBps: 10_001 }))).toThrow(/scrollDepthBps/i);
    expect(() => parseFrictionSnapshot(snapshot({ deviceClass: "TABLET" }))).toThrow(/deviceClass/i);
  });

  it("requires an explicit bounded probability-model contract", () => {
    expect(parseFrictionProbabilityModel(model())).toEqual(model());
    expect(() => parseFrictionProbabilityModel(model({ sourceDigest: "unbound" }))).toThrow(/sourceDigest/i);
    expect(() => parseFrictionProbabilityModel(model({ lowRiskMax: 0.8, mediumRiskMax: 0.4 }))).toThrow(/greater/i);
    expect(() => parseFrictionProbabilityModel(model({ inventedField: true }))).toThrow(/unknown or missing/i);
  });

  it("produces a deterministic bounded probability bound to model provenance", () => {
    const first = scoreFrictionAbandonment(snapshot(), model());
    const second = scoreFrictionAbandonment(snapshot(), model());
    expect(first).toEqual(second);
    expect(first.abandonmentProbability).toBeGreaterThanOrEqual(0);
    expect(first.abandonmentProbability).toBeLessThanOrEqual(1);
    expect(first.estimator).toBe("CONFIGURED_LOGISTIC_MODEL_V1");
    expect(first.modelId).toBe("test-calibration-v1");
    expect(first.modelSourceDigest).toBe(`sha256:${"a".repeat(64)}`);
    expect(first.riskBand).toBe("LOW");
  });

  it("raises risk as measured friction grows under a positive calibrated model", () => {
    const low = scoreFrictionAbandonment(snapshot(), model());
    const high = scoreFrictionAbandonment(snapshot({
      scrollDepthBps: 0,
      maxInteractionLatencyMs: 900,
      validationErrorCount: 10,
      repeatedActionCount: 10,
      longTaskCount: 20,
      visibilityLossCount: 5,
    }), model());
    expect(high.abandonmentProbability).toBeGreaterThan(low.abandonmentProbability);
    expect(high.riskBand).toBe("HIGH");
  });

  it("does not invent a mobile penalty when the configured model has no mobile coefficient", () => {
    const desktop = scoreFrictionAbandonment(snapshot({ deviceClass: "DESKTOP" }), model());
    const mobile = scoreFrictionAbandonment(snapshot({ deviceClass: "MOBILE" }), model());
    expect(mobile.abandonmentProbability).toBe(desktop.abandonmentProbability);
    expect(mobile.evidence).toEqual(desktop.evidence);
  });
});
