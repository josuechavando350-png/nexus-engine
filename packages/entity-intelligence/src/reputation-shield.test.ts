import { describe, expect, it } from "vitest";
import { digest } from "./index";
import { createControlledPublicPageObservation, type CompetitiveScope } from "./competitive-intelligence";
import { runReputationShield } from "./reputation-shield-runtime";
import { analyzeReputationShield, verifyReputationShield } from "./reputation-shield";

const scope: CompetitiveScope = { tenantId: "tenant-a", organizationId: "org-a", brandId: "brand-a" };
const observedAt = "2026-08-31T11:00:00.000Z";

function source(id: string, terms: readonly string[], sourceScope: CompetitiveScope = scope) {
  const url = `https://${id.trim() || "source"}.example/`;
  return {
    id,
    label: id.trim() || "source",
    observation: createControlledPublicPageObservation({
      scope: sourceScope,
      url,
      finalUrl: url,
      observedAt,
      status: 200,
      title: id.trim() || "source",
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

  it("fails closed on cross-tenant evidence and forged live authority", () => {
    const other: CompetitiveScope = { tenantId: "tenant-b", organizationId: "org-b", brandId: "brand-b" };
    expect(() => analyzeReputationShield(scope, "brand-a", [source("one", ["refund"]), source("two", ["refund"], other)], ["refund"]))
      .toThrow(/scope mismatch/);

    const forged = structuredClone(source("one", ["refund"]));
    expect(forged.observation.observationDigest).toMatch(/^[a-f0-9]{64}$/u);
    const core = { ...forged.observation, authority: "PUBLIC_HTTP_CAPTURE" as const };
    const { observationDigest: _oldDigest, ...withoutDigest } = core;
    forged.observation = { ...withoutDigest, observationDigest: digest(withoutDigest) };
    expect(forged.observation.observationDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => analyzeReputationShield(scope, "brand-a", [forged], ["refund"]))
      .toThrow(/attested|live/i);
  });

  it("fails closed on mixed observation authorities before producing a report", () => {
    const controlled = source("one", ["refund"]);
    const forgedLive = structuredClone(source("two", ["refund"]));
    const core = { ...forgedLive.observation, authority: "PUBLIC_HTTP_CAPTURE" as const };
    const { observationDigest: _oldDigest, ...withoutDigest } = core;
    forgedLive.observation = { ...withoutDigest, observationDigest: digest(withoutDigest) };

    expect(() => analyzeReputationShield(scope, "brand-a", [controlled, forgedLive], ["refund"]))
      .toThrow(/attested|live|mixed/i);
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

  it("canonicalizes source ids before emitting signed report fields", () => {
    const report = analyzeReputationShield(scope, "brand-a", [source("  one  ", ["refund"])], ["refund"]);
    expect(report.sourceIds).toEqual(["one"]);
    expect(report.signals).toEqual([{ term: "refund", sourceCount: 1, sourceIds: ["one"] }]);
    expect(report.reportDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("bounds source count and requires unique source ids after normalization", () => {
    expect(() => analyzeReputationShield(scope, "brand-a", [], ["refund"])).toThrow(/1 to 50/);
    expect(() => analyzeReputationShield(scope, "brand-a", [source("one", ["refund"]), source(" one ", ["delay"])], ["refund"]))
      .toThrow(/unique/);
  });

  it("validates tenant scope before the production runtime can capture public pages", async () => {
    await expect(runReputationShield({
      scope: { tenantId: "", organizationId: "org-a", brandId: "brand-a" },
      subjectId: "brand-a",
      observedAt,
      sources: [{ id: "one", label: "One", url: "http://127.0.0.1/private" }],
      monitoredTerms: ["refund"],
    })).rejects.toThrow(/scope\.tenantId/);
  });

  it("fails closed before transport on cancellation and invalid timeout budgets", async () => {
    const controller = new AbortController();
    controller.abort(new Error("operator cancelled reputation run"));
    await expect(runReputationShield({
      scope,
      subjectId: "brand-a",
      observedAt,
      sources: [{ id: "one", label: "One", url: "https://example.com/" }],
      monitoredTerms: ["refund"],
    }, controller.signal)).rejects.toThrow(/operator cancelled reputation run/);

    await expect(runReputationShield({
      scope,
      subjectId: "brand-a",
      observedAt,
      sources: [{ id: "one", label: "One", url: "https://example.com/" }],
      monitoredTerms: ["refund"],
      timeoutMs: 30_001,
    })).rejects.toThrow(/timeoutMs must be an integer from 100 to 30000/);
  });
});
