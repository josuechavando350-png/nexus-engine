import { describe, expect, it } from "vitest";
import { digest } from "./index";
import { createControlledPublicPageObservation, type CompetitiveScope } from "./competitive-intelligence";
import { analyzeReputationShield, verifyReputationShield } from "./reputation-shield";

const scope: CompetitiveScope = { tenantId: "tenant-a", organizationId: "org-a", brandId: "brand-a" };
const observedAt = "2026-08-31T11:00:00.000Z";

function source(id: string, terms: readonly string[], sourceScope: CompetitiveScope = scope) {
  const url = `https://${id}.example/`;
  return {
    id,
    label: id,
    observation: createControlledPublicPageObservation({
      scope: sourceScope,
      url,
      finalUrl: url,
      observedAt,
      status: 200,
      title: id,
      description: null,
      canonicalUrl: url,
      visibleTerms: terms,
      bodyDigest: digest(`<html>${terms.join(" ")}</html>`),
    }),
  };
}

describe("reputation shield", () => {
  it("reports only observed monitored term signals and keeps synthetic evidence explicit", () => {
    const sources = [source("one", ["refund", "service"]), source("two", ["refund", "delay"]), source("three", ["service"])];
    const report = analyzeReputationShield(scope, "brand-a", sources, ["refund", "delay", "fraud"]);
    expect(report.evidenceState).toBe("SYNTHETIC");
    expect(report.nonClaim).toMatch(/NOT_SENTIMENT/);
    expect(report.signals).toEqual([
      { term: "refund", sourceCount: 2, sourceIds: ["one", "two"] },
      { term: "delay", sourceCount: 1, sourceIds: ["two"] },
    ]);
    expect(verifyReputationShield(scope, "brand-a", sources, ["refund", "delay", "fraud"], report)).toBe(true);
  });

  it("fails closed on cross-tenant evidence and mixed authorities", () => {
    const other: CompetitiveScope = { tenantId: "tenant-b", organizationId: "org-b", brandId: "brand-b" };
    expect(() => analyzeReputationShield(scope, "brand-a", [source("one", ["refund"]), source("two", ["refund"], other)], ["refund"]))
      .toThrow(/scope mismatch/);

    const forged = structuredClone(source("one", ["refund"]));
    const core = { ...forged.observation, authority: "PUBLIC_HTTP_CAPTURE" as const };
    const { observationDigest: _discarded, ...withoutDigest } = core;
    forged.observation = { ...withoutDigest, observationDigest: digest(withoutDigest) };
    expect(() => analyzeReputationShield(scope, "brand-a", [forged], ["refund"]))
      .toThrow(/attested|live/i);
  });

  it("detects replay/tamper and rejects duplicate or ambiguous monitored terms", () => {
    const sources = [source("one", ["refund"]), source("two", ["delay"])];
    const report = analyzeReputationShield(scope, "brand-a", sources, ["refund", "delay"]);
    const tampered = structuredClone(report);
    (tampered.signals[0] as { sourceCount: number }).sourceCount = 99;
    expect(verifyReputationShield(scope, "brand-a", sources, ["refund", "delay"], tampered)).toBe(false);
    expect(() => analyzeReputationShield(scope, "brand-a", sources, ["Refund", "refund"])).toThrow(/unique/);
    expect(() => analyzeReputationShield(scope, "brand-a", sources, ["two words"])).toThrow(/single normalized tokens/);
  });

  it("bounds source count and requires unique source ids", () => {
    expect(() => analyzeReputationShield(scope, "brand-a", [], ["refund"])).toThrow(/1 to 50/);
    expect(() => analyzeReputationShield(scope, "brand-a", [source("one", ["refund"]), source("one", ["delay"])], ["refund"]))
      .toThrow(/unique/);
  });
});
