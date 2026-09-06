import { describe, expect, it } from "vitest";
import {
  Cortex14Error,
  computeRiskNetworkKeyHash,
  evaluateSignedRiskEnvelope,
  evaluateSignedRiskEnvelopeForNetwork,
  signRiskPayload,
} from "./index";

const secret = "s".repeat(32);
const networkSecret = "n".repeat(32);
const policy = { challengeAtOrAbove: 500, denyAtOrAbove: 800, maxAssessmentAgeSeconds: 300, maxFutureSkewSeconds: 30 } as const;
const now = Date.parse("2026-09-06T00:02:00.000Z");
const networkKeyHash = computeRiskNetworkKeyHash("203.0.113.10", networkSecret);
const payload = {
  schemaVersion: 1,
  assessmentId: "assessment-00000001",
  providerId: "provider-00000001",
  assessedAt: "2026-09-06T00:00:00.000Z",
  expiresAt: "2026-09-06T00:05:00.000Z",
  riskScore: 100,
  networkKeyHash,
} as const;

describe("CORTEX #14 signed risk gate", () => {
  it("uses provider risk scores only through a verified envelope and configured thresholds", () => {
    const low = signRiskPayload(payload, secret);
    expect(evaluateSignedRiskEnvelope(low, secret, policy, now).action).toBe("ALLOW");
    const medium = signRiskPayload({ ...payload, assessmentId: "assessment-00000002", riskScore: 650 }, secret);
    expect(evaluateSignedRiskEnvelope(medium, secret, policy, now).action).toBe("CHALLENGE");
    const high = signRiskPayload({ ...payload, assessmentId: "assessment-00000003", riskScore: 900 }, secret);
    expect(evaluateSignedRiskEnvelope(high, secret, policy, now).action).toBe("DENY");
  });

  it("binds an otherwise valid signed assessment to the exact request network key", () => {
    const signed = signRiskPayload(payload, secret);
    expect(evaluateSignedRiskEnvelopeForNetwork(signed, secret, policy, networkKeyHash, now).action).toBe("ALLOW");
    const replayNetworkHash = computeRiskNetworkKeyHash("203.0.113.11", networkSecret);
    expect(() => evaluateSignedRiskEnvelopeForNetwork(signed, secret, policy, replayNetworkHash, now)).toThrowError(/different request network key/u);
  });

  it("derives opaque network bindings with a keyed digest rather than storing an address", () => {
    expect(networkKeyHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(networkKeyHash).not.toContain("203.0.113.10");
    expect(computeRiskNetworkKeyHash("203.0.113.10", networkSecret)).toBe(networkKeyHash);
    expect(computeRiskNetworkKeyHash("203.0.113.10", "m".repeat(32))).not.toBe(networkKeyHash);
  });

  it("rejects tampering instead of trusting client-supplied scores", () => {
    const signed = signRiskPayload(payload, secret);
    const tampered = { ...signed, payload: { ...signed.payload, riskScore: 999 } };
    expect(() => evaluateSignedRiskEnvelope(tampered, secret, policy, now)).toThrowError(Cortex14Error);
    expect(() => evaluateSignedRiskEnvelope(signed, "x".repeat(32), policy, now)).toThrowError(/signature mismatch/u);
  });

  it("rejects stale, expired, and future assessments", () => {
    const stale = signRiskPayload(payload, secret);
    expect(() => evaluateSignedRiskEnvelope(stale, secret, policy, Date.parse("2026-09-06T00:10:00.000Z"))).toThrowError(/stale|expired/u);
    const future = signRiskPayload({ ...payload, assessmentId: "assessment-00000004", assessedAt: "2026-09-06T00:03:00.000Z", expiresAt: "2026-09-06T00:08:00.000Z" }, secret);
    expect(() => evaluateSignedRiskEnvelope(future, secret, policy, now)).toThrowError(/future/u);
  });

  it("requires a hashed network key and rejects unbounded or contradictory policies", () => {
    expect(() => signRiskPayload({ ...payload, networkKeyHash: "192.0.2.1" }, secret)).toThrowError(/SHA-256/u);
    expect(() => computeRiskNetworkKeyHash("203.0.113.10", "short")).toThrowError(/secret/u);
    const signed = signRiskPayload(payload, secret);
    expect(() => evaluateSignedRiskEnvelope(signed, secret, { ...policy, challengeAtOrAbove: 900, denyAtOrAbove: 800 }, now)).toThrowError(/out of range/u);
  });
});
