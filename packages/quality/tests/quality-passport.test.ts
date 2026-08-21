import { describe, expect, it } from "vitest";
import { createQualityPassport, verifyQualityPassport } from "../quality-passport";

const SHA = "a".repeat(40);
const HASH = "b".repeat(64);

describe("quality passport", () => {
  it("creates a verifiable PASS passport from evidence-backed checks", () => {
    const passport = createQualityPassport({
      projectId: "fixture",
      engineVersion: "6.0.0",
      sourceRevision: SHA,
      generatedAt: "2026-08-21T06:00:00.000Z",
      viewport: { width: 390, height: 844 },
      artifactHashes: { "capture/mobile.png": HASH },
      checks: [{ id: "browser", status: "PASS", detail: "captured in Chromium", evidenceIds: ["capture:mobile"] }],
    });
    expect(passport.verdict).toBe("PASS");
    expect(passport.passportHash).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyQualityPassport(passport)).toBe(true);
  });

  it("marks unmeasured checks as INCOMPLETE instead of PASS", () => {
    const passport = createQualityPassport({
      projectId: "fixture",
      engineVersion: "6.0.0",
      sourceRevision: SHA,
      generatedAt: "2026-08-21T06:00:00.000Z",
      viewport: { width: 390, height: 844 },
      artifactHashes: {},
      checks: [{ id: "field-rum", status: "NOT_TESTED", detail: "no production samples yet", evidenceIds: [] }],
    });
    expect(passport.verdict).toBe("INCOMPLETE");
  });

  it("rejects PASS checks without evidence", () => {
    expect(() => createQualityPassport({
      projectId: "fixture",
      engineVersion: "6.0.0",
      sourceRevision: SHA,
      generatedAt: "2026-08-21T06:00:00.000Z",
      viewport: { width: 390, height: 844 },
      artifactHashes: {},
      checks: [{ id: "browser", status: "PASS", detail: "claimed pass", evidenceIds: [] }],
    })).toThrow(/cannot PASS without evidence/);
  });
});
