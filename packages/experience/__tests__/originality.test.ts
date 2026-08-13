import { describe, expect, it } from "vitest";
import { compareFingerprints, type StyleFingerprintV2 } from "../originality";

const base: StyleFingerprintV2 = {
  version: 2,
  subject: "a",
  observedAt: "2026-08-11",
  openingSignature: "editorial thesis",
  navigationSignature: "quiet top index",
  sectionSequence: ["thesis", "evidence", "action"],
  structure: { cardReliance: 0, gridRegularity: 0.3, symmetry: 0.4, overlap: 0.1, whitespace: 0.8, continuity: 0.7 },
  ctaGrammar: ["textual"],
  geometryGrammar: ["rules", "open-field"],
  mediaGrammar: ["documentary-inline"],
  motionGrammar: ["quiet-reveal"],
  typographyHierarchy: ["serif-dominant", "high-contrast"]
};

describe("Originality Engine V2", () => {
  it("contains no color dimension", () => {
    expect(JSON.stringify(base)).not.toMatch(/color|palette|hex/i);
  });

  it("compares structure and grammar without inventing a pass/fail threshold", () => {
    const different: StyleFingerprintV2 = {
      ...base,
      subject: "b",
      openingSignature: "media immersion",
      navigationSignature: "edge rail",
      sectionSequence: ["arrival", "chapters", "conversion"],
      structure: { cardReliance: 0, gridRegularity: 0.1, symmetry: 0.1, overlap: 0.8, whitespace: 0.4, continuity: 0.9 },
      ctaGrammar: ["edge-control"],
      geometryGrammar: ["fullbleed", "layering"],
      mediaGrammar: ["continuous-fullscreen"],
      motionGrammar: ["chapter-transition"],
      typographyHierarchy: ["display-overlay", "caption-rail"]
    };

    const report = compareFingerprints(base, different);
    expect(report.overall).toBeLessThan(0.7);
    expect(report.warnings).toEqual([]);
  });

  it("warns on objective exact structural duplication", () => {
    const report = compareFingerprints(base, { ...base, subject: "clone" });
    expect(report.warnings.some((warning) => warning.includes("exact structural duplication"))).toBe(true);
  });

  it("keeps justification visible instead of deleting similarity", () => {
    const report = compareFingerprints(base, { ...base, subject: "justified" }, {
      justifications: { opening: "Both experiences must start with a legally required notice." }
    });
    const opening = report.dimensions.find((item) => item.dimension === "opening");
    expect(opening?.score).toBe(1);
    expect(opening?.justified).toBe(true);
  });
});
