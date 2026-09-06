import { describe, expect, it } from "vitest";
import { Cortex14Error, evaluateSignedRiskEnvelope, signRiskPayload } from "./index";

const secret = "s".repeat(32);
const policy = { challengeAtOrAbove: 500, denyAtOrAbove: 800, maxAssessmentAgeSeconds: 300, maxFutureSkewSeconds: 30 } as const;
const now = Date.parse("2026-09-06T00:02:00.000Z");
const payload = {
  schemaVersion: 1,
  assessmentId: "assessment-00000001",
  providerId: "provider-00000001",
  assessedAt: "2026-09-06T00:00:00.000Z",
  expiresAt: "2026-09-06T00:05:00.000Z",
  riskScore: 100,
  networkKeyHash: `sha256:${"a".repeat(64)}`,
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
    const signed = signRiskPayload(payload, secret);
    expect(() => evaluateSignedRiskEnvelope(signed, secret, { ...policy, challengeAtOrAbove: 900, denyAtOrAbove: 800 }, now)).toThrowError(/out of range/u);
  });
});
