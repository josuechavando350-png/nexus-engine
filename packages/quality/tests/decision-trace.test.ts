import { describe, expect, it } from "vitest";
import { createDecisionTrace, verifyDecisionTrace } from "../decision-trace";
import { createQualityPassport, verifyQualityPassport } from "../quality-passport";

describe("decision trace", () => {
  const entries = [
    { elementId: "hero.title", property: "font-family", value: "Editorial Serif", authority: "PROJECT_DESIGN_DNA" as const, authorityRef: "dna.typography.display", rationale: "Display type is declared once by the project DNA." },
    { elementId: "hero.cta", property: "label", value: "Agenda una cita", authority: "HUMAN_ART_DIRECTOR" as const, authorityRef: "director:brief-v2", rationale: "Director approved the conversion language." },
    { elementId: "hero.media", property: "loading", value: "eager", authority: "ENGINE_RULE" as const, authorityRef: "performance:lcp-primary-media", rationale: "Engine rule protects primary LCP media loading." },
  ];

  it("is deterministic regardless of input order", () => {
    const a = createDecisionTrace(entries);
    const b = createDecisionTrace([...entries].reverse());
    expect(a.traceHash).toBe(b.traceHash);
    expect(a.entries).toEqual(b.entries);
    expect(verifyDecisionTrace(a)).toBe(true);
  });

  it("rejects duplicate decisions and forged authorities", () => {
    expect(() => createDecisionTrace([entries[0]!, { ...entries[0]!, value: "Other" }])).toThrow(/duplicate/);
    expect(() => createDecisionTrace([{ ...entries[0]!, authority: "AUTONOMOUS_AI" as never }])).toThrow(/invalid decision authority/);
    const trace = createDecisionTrace(entries);
    expect(verifyDecisionTrace({ ...trace, authority: "FORGED" as never })).toBe(false);
  });

  it("is cryptographically bound into the quality passport", () => {
    const trace = createDecisionTrace(entries);
    const passport = createQualityPassport({
      projectId: "client-demo",
      engineVersion: "6.0.0",
      sourceRevision: "a".repeat(40),
      generatedAt: "2026-08-21T00:00:00.000Z",
      viewport: { width: 390, height: 844 },
      artifactHashes: { "index.html": "b".repeat(64) },
      checks: [{ id: "build", status: "PASS", detail: "Build evidence exists", evidenceIds: ["build-1"] }],
      decisionTrace: trace,
    });
    expect(passport.decisionTrace?.traceHash).toBe(trace.traceHash);
    expect(verifyQualityPassport(passport)).toBe(true);
    expect(verifyQualityPassport({ ...passport, decisionTrace: { ...trace, traceHash: "c".repeat(64) } })).toBe(false);
  });
});
