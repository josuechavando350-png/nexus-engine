import { describe, expect, it } from "vitest";
import { FRICTION_FEATURE_CONTRACT_ID, parseFrictionProbabilityModel, parseFrictionSnapshot, scoreFrictionAbandonment } from "./index";
import { decideFrictionControlPlaneAction, parseFrictionActionPolicy } from "./control-plane-actions";

const model = parseFrictionProbabilityModel({
  schemaVersion: 1,
  featureContractId: FRICTION_FEATURE_CONTRACT_ID,
  modelId: "friction-v1",
  sourceDigest: `sha256:${"1".repeat(64)}`,
  intercept: -1,
  coefficients: { interactionLatency: 4, validationErrorRatio: 4, repeatedActionRatio: 3, longTaskRate: 2, visibilityLossRate: 1, scrollDeficit: 2, coarsePointerIndicator: 0.5 },
  lowRiskMax: 0.3,
  mediumRiskMax: 0.7,
});

function policy(mode: "ACTIVE" | "OBSERVE_ONLY" | "KILLED" = "ACTIVE") {
  return parseFrictionActionPolicy({
    schemaVersion: 1,
    policyId: "rescue-policy-v1",
    sourceDigest: `sha256:${"2".repeat(64)}`,
    mode,
    minimumElapsedMs: 10_000,
    minimumInteractionCount: 3,
    minimumAbandonmentProbability: 0.75,
    minimumProbabilityMarginAboveHighRisk: 0.05,
    coarsePointerActionId: "mobile-help",
    finePointerActionId: "desktop-help",
    profiles: [
      { actionId: "mobile-help", kind: "SURFACE_CONTACT", label: "Need help?", message: "Open a concise contact option." },
      { actionId: "desktop-help", kind: "SHOW_HELP", label: "Need help?", message: "Show a concise help panel." },
    ],
  });
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return parseFrictionSnapshot({
    schemaVersion: 1,
    featureContractId: FRICTION_FEATURE_CONTRACT_ID,
    pointerClass: "COARSE",
    elapsedMs: 20_000,
    scrollDepthBps: 1_000,
    maxInteractionLatencyMs: 1_500,
    interactionCount: 10,
    validationErrorCount: 5,
    repeatedActionCount: 5,
    longTaskCount: 10,
    visibilityLossCount: 2,
    ...overrides,
  });
}

describe("CORTEX #29 governed rescue actions", () => {
  it("selects only a predeclared action after evidence and confidence thresholds pass", () => {
    const input = snapshot();
    const score = scoreFrictionAbandonment(input, model);
    const decision = decideFrictionControlPlaneAction(input, score, model, policy());
    expect(score.riskBand).toBe("HIGH");
    expect(decision).toMatchObject({ reason: "ACTION_SELECTED", evidenceSufficient: true, action: { actionId: "mobile-help", kind: "SURFACE_CONTACT" } });
    expect(decision.abandonmentProbability).toBeGreaterThanOrEqual(decision.requiredProbability);
  });

  it("does nothing when sample evidence is too small even if instantaneous score is high", () => {
    const input = snapshot({ elapsedMs: 5_000, interactionCount: 1 });
    const decision = decideFrictionControlPlaneAction(input, scoreFrictionAbandonment(input, model), model, policy());
    expect(decision).toMatchObject({ action: null, reason: "INSUFFICIENT_EVIDENCE", evidenceSufficient: false });
  });

  it("OBSERVE_ONLY and KILLED never emit a consumer-visible action", () => {
    const input = snapshot();
    const score = scoreFrictionAbandonment(input, model);
    expect(decideFrictionControlPlaneAction(input, score, model, policy("OBSERVE_ONLY"))).toMatchObject({ action: null, reason: "OBSERVE_ONLY" });
    expect(decideFrictionControlPlaneAction(input, score, model, policy("KILLED"))).toMatchObject({ action: null, reason: "KILL_SWITCH" });
  });

  it("binds action decisions to the same scoring model identity", () => {
    const input = snapshot();
    const score = scoreFrictionAbandonment(input, model);
    const other = parseFrictionProbabilityModel({ ...model, modelId: "different-model" });
    expect(() => decideFrictionControlPlaneAction(input, score, other, policy())).toThrowError(/identity/u);
  });
});