import { describe, expect, it } from "vitest";
import { createAdContextPolicy, evaluateAdContext, type AdContextPolicy } from "./index";

function policy(mode: "ACTIVE" | "OBSERVE_ONLY" | "KILLED" = "ACTIVE") {
  return createAdContextPolicy({
    policyId: "cano-ad-context-v1",
    mode,
    defaultExperienceId: "default",
    paidSearchExperienceId: "paid-search",
    paidSocialExperienceId: "paid-social",
    allowedExperienceIds: ["default", "paid-search", "paid-social", "campaign-a"],
    exactRules: [{
      ruleId: "campaign-a-rule",
      experienceId: "campaign-a",
      source: "google",
      medium: "cpc",
      campaign: "penal-cdmx",
    }],
  });
}

describe("CORTEX ad-context edge workers", () => {
  it("keeps direct traffic on the deterministic default experience", () => {
    expect(evaluateAdContext("https://example.test/", policy())).toEqual({
      policyId: "cano-ad-context-v1",
      mode: "ACTIVE",
      channel: "DIRECT_OR_UNKNOWN",
      experienceId: "default",
      wouldApplyExperienceId: "default",
      applied: false,
      reason: "NO_AD_CONTEXT",
      ruleId: null,
      contextPresent: false,
      clickSignalPresent: false,
    });
  });

  it("recognizes real Google click signals without returning the click identifier", () => {
    const rawClickId = "EAIaIQobChMI-secret-click-id-123";
    const result = evaluateAdContext(`https://example.test/?gclid=${rawClickId}`, policy());
    expect(result).toMatchObject({ channel: "PAID_SEARCH", experienceId: "paid-search", applied: true, reason: "PAID_SEARCH_SIGNAL", clickSignalPresent: true });
    expect(JSON.stringify(result)).not.toContain(rawClickId);
  });

  it("uses an exact controlled campaign rule before generic channel fallback", () => {
    const result = evaluateAdContext("https://example.test/?utm_source=Google&utm_medium=CPC&utm_campaign=Penal-CDMX", policy());
    expect(result).toMatchObject({ experienceId: "campaign-a", applied: true, reason: "EXACT_RULE_MATCH", ruleId: "campaign-a-rule" });
  });

  it("never reflects arbitrary UTM content into the decision", () => {
    const attackerText = "BUY-NOW-<script>alert(1)</script>";
    const result = evaluateAdContext(`https://example.test/?utm_source=google&utm_medium=cpc&utm_content=${encodeURIComponent(attackerText)}`, policy());
    expect(result.experienceId).toBe("paid-search");
    expect(JSON.stringify(result)).not.toContain(attackerText);
    expect(JSON.stringify(result)).not.toContain("script");
  });

  it("fails to default on duplicate or oversized recognized context instead of choosing attacker-controlled ambiguity", () => {
    const duplicate = evaluateAdContext("https://example.test/?gclid=one&gclid=two", policy());
    expect(duplicate).toMatchObject({ experienceId: "default", applied: false, reason: "MALFORMED_CONTEXT" });

    const oversized = evaluateAdContext(`https://example.test/?utm_campaign=${"x".repeat(300)}`, policy());
    expect(oversized).toMatchObject({ experienceId: "default", applied: false, reason: "MALFORMED_CONTEXT" });
  });

  it("fails to default when paid-search and paid-social evidence conflict", () => {
    const result = evaluateAdContext("https://example.test/?gclid=search-signal&fbclid=social-signal", policy());
    expect(result).toMatchObject({ channel: "DIRECT_OR_UNKNOWN", experienceId: "default", applied: false, reason: "AMBIGUOUS_CONTEXT" });
  });

  it("supports observe-only and kill modes without applying the candidate experience", () => {
    expect(evaluateAdContext("https://example.test/?gclid=search-signal", policy("OBSERVE_ONLY"))).toMatchObject({
      experienceId: "default",
      wouldApplyExperienceId: "paid-search",
      applied: false,
      reason: "OBSERVE_ONLY_MATCH",
    });
    expect(evaluateAdContext("https://example.test/?gclid=search-signal", policy("KILLED"))).toMatchObject({
      experienceId: "default",
      wouldApplyExperienceId: "default",
      applied: false,
      reason: "KILL_SWITCH",
    });
  });

  it("rejects unsafe or overlapping policy rules before any request is evaluated", () => {
    expect(() => createAdContextPolicy({
      policyId: "unsafe",
      mode: "ACTIVE",
      defaultExperienceId: "default",
      allowedExperienceIds: ["default"],
      exactRules: [{ ruleId: "bad", experienceId: "not-allowlisted", campaign: "x" }],
    })).toThrow(/allowlisted/);

    expect(() => createAdContextPolicy({
      policyId: "unsafe",
      mode: "ACTIVE",
      defaultExperienceId: "default",
      allowedExperienceIds: ["default"],
      exactRules: [
        { ruleId: "one", experienceId: "default", campaign: "same" },
        { ruleId: "two", experienceId: "default", campaign: "same" },
      ],
    })).toThrow(/duplicate exact-rule matcher/);

    expect(() => createAdContextPolicy({
      policyId: "overlap",
      mode: "ACTIVE",
      defaultExperienceId: "default",
      allowedExperienceIds: ["default", "specific"],
      exactRules: [
        { ruleId: "broad", experienceId: "default", source: "google" },
        { ruleId: "specific", experienceId: "specific", source: "google", campaign: "penal-cdmx" },
      ],
    })).toThrow(/overlap/);
  });

  it("fails to default even if a structurally forged policy bypasses construction with multiple matching rules", () => {
    const safe = policy();
    const forged = {
      ...safe,
      exactRules: [
        { ruleId: "one", experienceId: "campaign-a", source: "google", medium: null, campaign: null },
        { ruleId: "two", experienceId: "paid-search", source: "google", medium: "cpc", campaign: null },
      ],
    } as AdContextPolicy;
    const result = evaluateAdContext("https://example.test/?utm_source=google&utm_medium=cpc", forged);
    expect(result).toMatchObject({ experienceId: "default", applied: false, reason: "AMBIGUOUS_CONTEXT", ruleId: null });
  });
});
