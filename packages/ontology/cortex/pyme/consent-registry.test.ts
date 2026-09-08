import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPymeConsentSubjectId, SqlitePymeConsentRegistry } from "./consent-registry";

const dirs: string[] = [];
function registry(now = Date.parse("2026-09-08T03:00:00.000Z")) {
  const dir = mkdtempSync(join(tmpdir(), "nexus-pyme-consent-")); dirs.push(dir);
  return new SqlitePymeConsentRegistry(join(dir, "consent.sqlite"), () => now);
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("CORTEX PyME central consent registry", () => {
  it("normalizes subject identity, grants by channel/purpose and revokes with CAS", () => {
    const store = registry();
    const a = createPymeConsentSubjectId("EMAIL", " Test.User+campaign@gmail.com ");
    const b = createPymeConsentSubjectId("EMAIL", "testuser@gmail.com");
    expect(a).toBe(b);
    const granted = store.grant({ subjectId: a, channel: "ENHANCED_CONVERSIONS", purpose: "ads_measurement", expectedRevision: 0, reasonCode: "EXPLICIT_OPT_IN", sourceRef: "form-consent-0001", decidedAt: "2026-09-08T02:55:00.000Z" });
    expect(granted).toMatchObject({ authorized: true, revision: 1, state: "GRANTED" });
    expect(store.authorize(a, "WHATSAPP", "lead_followup", "lead-check-0001").authorized).toBe(false);
    const revoked = store.revoke({ subjectId: a, channel: "ENHANCED_CONVERSIONS", purpose: "ads_measurement", expectedRevision: 1, reasonCode: "OPT_OUT", sourceRef: "privacy-center-0001", decidedAt: "2026-09-08T02:59:00.000Z" });
    expect(revoked).toMatchObject({ authorized: false, revision: 2, state: "REVOKED" });
    expect(store.auditTrail(a).map((entry) => entry.action)).toEqual(["GRANT", "USE", "REVOKE"]);
    store.close();
  });

  it("treats expired consent as unauthorized without mutating history", () => {
    const store = registry(Date.parse("2026-09-08T03:00:00.000Z"));
    const subject = createPymeConsentSubjectId("PHONE", "+525512345678");
    store.grant({ subjectId: subject, channel: "SMS", purpose: "lead_followup", expectedRevision: 0, reasonCode: "EXPLICIT_OPT_IN", sourceRef: "sms-check-0001", decidedAt: "2026-09-08T02:00:00.000Z", expiresAt: "2026-09-08T02:30:00.000Z" });
    expect(store.authorize(subject, "SMS", "lead_followup", "lead-check-0002")).toMatchObject({ authorized: false, reason: "EXPIRED" });
    store.close();
  });
});
