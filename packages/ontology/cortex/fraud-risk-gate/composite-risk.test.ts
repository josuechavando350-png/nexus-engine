import test from "node:test";
import assert from "node:assert/strict";
import { signRiskPayload, type RiskPolicy } from "./index.js";
import { evaluateCompositeRisk, signNetworkContext, type CompositeRiskPolicy } from "./composite-risk.js";

const now = Date.parse("2026-09-07T06:00:00.000Z");
const networkHash = `sha256:${"a".repeat(64)}`;
const basePolicy: RiskPolicy = { challengeAtOrAbove: 500, denyAtOrAbove: 800, maxAssessmentAgeSeconds: 600, maxFutureSkewSeconds: 5 };
const policy: CompositeRiskPolicy = {
  version: 1,
  challengeAtOrAbove: 550,
  denyAtOrAbove: 750,
  minFamiliesForChallenge: 2,
  minFamiliesForDeny: 3,
  minPresentFamilies: 2,
  highFamilyAtOrAbove: 650,
  sharedNetworkWeightMultiplier: 0.2,
  baseEnvelopePolicy: basePolicy,
  providers: [
    { providerId: "network-provider", family: "NETWORK", weight: 1 },
    { providerId: "automation-provider", family: "AUTOMATION", weight: 1 },
    { providerId: "velocity-provider", family: "VELOCITY", weight: 1 },
    { providerId: "integrity-provider", family: "INTEGRITY", weight: 1 },
    { providerId: "network-provider-2", family: "NETWORK", weight: 0.5 },
  ],
};
const providerSecrets = {
  "network-provider": "n".repeat(40),
  "automation-provider": "a".repeat(40),
  "velocity-provider": "v".repeat(40),
  "integrity-provider": "i".repeat(40),
  "network-provider-2": "m".repeat(40),
};
const networkContextSecret = "c".repeat(40);

function signal(providerId: keyof typeof providerSecrets, score: number, assessmentId = `assessment-${providerId}`) {
  return signRiskPayload({
    schemaVersion: 1,
    assessmentId,
    providerId,
    assessedAt: "2026-09-07T05:59:30.000Z",
    expiresAt: "2026-09-07T06:05:00.000Z",
    riskScore: score,
    networkKeyHash: networkHash,
  }, providerSecrets[providerId]);
}

function context(networkClass: "DEDICATED" | "SHARED_OR_NAT" | "CORPORATE" | "UNKNOWN") {
  return signNetworkContext({
    schemaVersion: 1,
    providerId: "network-context-provider",
    assessedAt: "2026-09-07T05:59:30.000Z",
    expiresAt: "2026-09-07T06:05:00.000Z",
    networkKeyHash: networkHash,
    networkClass,
  }, networkContextSecret);
}

test("shared network risk cannot deny without independent high-risk families", () => {
  const decision = evaluateCompositeRisk({
    version: 1,
    signals: [signal("network-provider", 1000), signal("automation-provider", 300)],
    networkContext: context("SHARED_OR_NAT"),
  }, policy, { providerSecrets, networkContextSecret }, networkHash, now);
  assert.equal(decision.action, "ALLOW");
  assert.equal(decision.networkContributionAttenuated, true);
  assert.deepEqual(decision.presentFamilies, ["AUTOMATION", "NETWORK"]);
});

test("three independent high-risk families can deny", () => {
  const decision = evaluateCompositeRisk({
    version: 1,
    signals: [signal("automation-provider", 900), signal("velocity-provider", 850), signal("integrity-provider", 900)],
    networkContext: context("CORPORATE"),
  }, policy, { providerSecrets, networkContextSecret }, networkHash, now);
  assert.equal(decision.action, "DENY");
  assert.equal(decision.reason, "COMPOSITE_DENY");
  assert.deepEqual(decision.highRiskFamilies, ["AUTOMATION", "INTEGRITY", "VELOCITY"]);
});

test("multiple network providers never count as independent families", () => {
  const decision = evaluateCompositeRisk({
    version: 1,
    signals: [signal("network-provider", 900), signal("network-provider-2", 950), signal("automation-provider", 700)],
    networkContext: context("DEDICATED"),
  }, policy, { providerSecrets, networkContextSecret }, networkHash, now);
  assert.equal(decision.presentFamilies.length, 2);
  assert.notEqual(decision.action, "DENY");
});

test("network context must be cryptographically bound to the request network", () => {
  const wrongContext = signNetworkContext({
    schemaVersion: 1,
    providerId: "network-context-provider",
    assessedAt: "2026-09-07T05:59:30.000Z",
    expiresAt: "2026-09-07T06:05:00.000Z",
    networkKeyHash: `sha256:${"b".repeat(64)}`,
    networkClass: "CORPORATE",
  }, networkContextSecret);
  assert.throws(() => evaluateCompositeRisk({ version: 1, signals: [signal("automation-provider", 800), signal("velocity-provider", 800)], networkContext: wrongContext }, policy, { providerSecrets, networkContextSecret }, networkHash, now), /another network/);
});
