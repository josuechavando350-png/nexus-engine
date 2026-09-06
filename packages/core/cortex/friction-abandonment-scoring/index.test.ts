import { describe, expect, it } from "vitest";
import {
  FRICTION_FEATURE_CONTRACT_ID,
  parseFrictionProbabilityModel,
  parseFrictionSnapshot,
  scoreFrictionAbandonment,
} from "./index.js";

const SOURCE_DIGEST = `sha256:${"a".repeat(64)}` as const;
const model = {
  schemaVersion: 1,
  featureContractId: FRICTION_FEATURE_CONTRACT_ID,
  modelId: "ci-fixture-do-not-use",
  sourceDigest: SOURCE_DIGEST,
  intercept: -3,
  coefficients: {
    interactionLatency: 2,
    validationErrorRatio: 2,
    repeatedActionRatio: 2,
    longTaskRate: 2,
    visibilityLossRate: 2,
    scrollDeficit: 2,
    coarsePointerIndicator: 0,
  },
  lowRiskMax: 0.33,
  mediumRiskMax: 0.66,
};
const snapshot = {
  schemaVersion: 1,
  featureContractId: FRICTION_FEATURE_CONTRACT_ID,
  pointerClass: "FINE",
  elapsedMs: 30_000,
  scrollDepthBps: 5_000,
  maxInteractionLatencyMs: 250,
  interactionCount: 5,
  validationErrorCount: 1,
  repeatedActionCount: 1,
  longTaskCount: 1,
  visibilityLossCount: 0,
};

describe("CORTEX #9 friction abandonment scoring", () => {
  it("requires the exact minimized feature contract and rejects unknown input", () => {
    expect(parseFrictionSnapshot(snapshot)).toMatchObject({
      featureContractId: FRICTION_FEATURE_CONTRACT_ID,
      pointerClass: "FINE",
    });
    expect(() => parseFrictionSnapshot({ ...snapshot, featureContractId: "OTHER" })).toThrow(/feature contract/i);
    expect(() => parseFrictionSnapshot({ ...snapshot, pointerClass: "MOBILE" })).toThrow(/pointerClass/i);
    expect(() => parseFrictionSnapshot({ ...snapshot, email: "forbidden@example.invalid" })).toThrow(/unknown or missing/i);
  });

  it("requires an explicitly versioned model bound to the same feature contract", () => {
    expect(parseFrictionProbabilityModel(model)).toMatchObject({
      featureContractId: FRICTION_FEATURE_CONTRACT_ID,
      modelId: "ci-fixture-do-not-use",
      sourceDigest: SOURCE_DIGEST,
    });
    expect(() => parseFrictionProbabilityModel({ ...model, featureContractId: "OTHER" })).toThrow(/feature contract/i);
    expect(() => parseFrictionProbabilityModel({ ...model, sourceDigest: "sha256:not-a-digest" })).toThrow(/sourceDigest/i);
    expect(() => parseFrictionProbabilityModel({ ...model, mediumRiskMax: 0.2 })).toThrow(/greater than/i);
  });

  it("produces a deterministic bounded probability only from the configured model", () => {
    const score = scoreFrictionAbandonment(snapshot, model);
    expect(score.estimator).toBe("CONFIGURED_LOGISTIC_MODEL_V1");
    expect(score.modelId).toBe(model.modelId);
    expect(score.modelSourceDigest).toBe(SOURCE_DIGEST);
    expect(score.featureContractId).toBe(FRICTION_FEATURE_CONTRACT_ID);
    expect(score.pointerClass).toBe("FINE");
    expect(score.abandonmentProbability).toBeGreaterThanOrEqual(0);
    expect(score.abandonmentProbability).toBeLessThanOrEqual(1);
    expect(["LOW", "MEDIUM", "HIGH"]).toContain(score.riskBand);
    expect(score).toEqual(scoreFrictionAbandonment(snapshot, model));
  });

  it("bounds all numeric inputs and refuses non-finite model coefficients", () => {
    expect(() => parseFrictionSnapshot({ ...snapshot, elapsedMs: 1_800_001 })).toThrow(/elapsedMs/i);
    expect(() => parseFrictionSnapshot({ ...snapshot, scrollDepthBps: -1 })).toThrow(/scrollDepthBps/i);
    expect(() => parseFrictionProbabilityModel({
      ...model,
      coefficients: { ...model.coefficients, longTaskRate: Number.NaN },
    })).toThrow(/finite number/i);
  });
});
