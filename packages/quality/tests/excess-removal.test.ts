import type { RemovalExperimentArtifact } from "@nexus/capture/removal-experiment";
import { describe, expect, it } from "vitest";
import { createEvidenceBackedExcessCandidate, evaluateExcessRemoval } from "../excess-removal";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

function artifact(overrides: Partial<RemovalExperimentArtifact> = {}): RemovalExperimentArtifact {
  const genome = (visibleElementCount: number) => ({
    schemaVersion: 1 as const,
    viewport: { width: 390, height: 844 },
    visibleElementCount,
    layout: { gridElementCount: 1, flexElementCount: 1, centeredElementRatio: 0.5, viewportOccupancyRatio: 0.7, horizontalOffsetMean: 0.2 },
    typography: { fontSizePx: [16, 48], fontWeight: [400, 700], lineHeightRatio: [1.2], familyCount: 1 },
    geometry: { borderRadiusPx: [8], aspectRatios: [1.5] },
    media: { imageCount: 1, videoCount: 0, mediaAreaRatio: 0.2 },
    rhythm: { landmarkHeightsPx: [600], landmarkGapPx: [24] },
    motion: { animatedElementCount: 0, transitionDurationMs: [], animationDurationMs: [] },
  });
  return {
    elementId: "hero-copy",
    selector: "[data-nexus-element='hero-copy']",
    browser: "chromium",
    viewport: { width: 390, height: 844 },
    beforeScreenshotUri: "/tmp/before.png",
    beforeScreenshotDigest: digest("a"),
    beforeScreenshotByteLength: 100,
    afterScreenshotUri: "/tmp/after.png",
    afterScreenshotDigest: digest("b"),
    afterScreenshotByteLength: 80,
    diagnosticsUri: "/tmp/removal.json",
    diagnosticsDigest: digest("c"),
    removedNodeCount: 1,
    before: {
      selectorCount: 1,
      visibleElementCount: 10,
      textCharacterCount: 120,
      interactiveElementCount: 2,
      focusableElementCount: 2,
      headingOneCount: 1,
      mainLandmarkCount: 1,
      mediaElementCount: 1,
      horizontalOverflowPx: 0,
      scrollHeightPx: 1200,
      target: { present: true, visible: true, tagName: "section", textCharacterCount: 60, interactiveElementCount: 1, focusableElementCount: 1, headingOneCount: 0, mainLandmarkCount: 0, mediaElementCount: 0 },
      designGenome: genome(10),
    },
    after: {
      selectorCount: 0,
      visibleElementCount: 7,
      textCharacterCount: 60,
      interactiveElementCount: 1,
      focusableElementCount: 1,
      headingOneCount: 1,
      mainLandmarkCount: 1,
      mediaElementCount: 1,
      horizontalOverflowPx: 0,
      scrollHeightPx: 900,
      target: { present: false, visible: false, tagName: "", textCharacterCount: 0, interactiveElementCount: 0, focusableElementCount: 0, headingOneCount: 0, mainLandmarkCount: 0, mediaElementCount: 0 },
      designGenome: genome(7),
    },
    ...overrides,
  };
}

describe("evaluateExcessRemoval", () => {
  it("returns NOT_TESTED when no candidates were evaluated", () => {
    expect(evaluateExcessRemoval([]).verdict).toBe("NOT_TESTED");
  });

  it("fails unexplained decoration instead of rewarding visual excess", () => {
    const report = evaluateExcessRemoval([{ elementId: "floating-orb", purposes: [], rationale: "" }]);
    expect(report.verdict).toBe("FAIL");
    expect(report.findings[0]?.code).toBe("MISSING_PURPOSE");
  });

  it("does not accept declared purpose without a removal experiment", () => {
    const report = evaluateExcessRemoval([{ elementId: "hero-grid", purposes: ["HIERARCHY"], rationale: "Establishes primary visual hierarchy" }]);
    expect(report.verdict).toBe("NOT_TESTED");
    expect(report.findings[0]?.code).toBe("REMOVAL_NOT_TESTED");
  });

  it("fails an element when removal causes no material loss", () => {
    const report = evaluateExcessRemoval([{
      elementId: "decorative-sparkles",
      purposes: ["IDENTITY"],
      rationale: "Claimed brand signature",
      observation: { outcome: "NO_MATERIAL_LOSS", evidenceIds: ["shot:before", "shot:after"], notes: "Hierarchy, comprehension and identity remained unchanged." },
    }]);
    expect(report.verdict).toBe("FAIL");
    expect(report.findings[0]?.code).toBe("EXCESS_CONFIRMED");
  });

  it("passes only when removal evidence demonstrates meaningful loss or breakage", () => {
    const report = evaluateExcessRemoval([{
      elementId: "espresso-extraction-timeline",
      purposes: ["IDENTITY", "COMPREHENSION"],
      rationale: "Makes the café ritual legible and project-specific",
      observation: { outcome: "MEANINGFUL_LOSS", evidenceIds: ["genome:before", "review:after-removal"], notes: "Removal erased the serving-ritual narrative and category-specific interaction." },
    }]);
    expect(report.verdict).toBe("PASS");
    expect(report.findings[0]?.code).toBe("PURPOSE_SUPPORTED");
  });

  it("keeps a real experiment NOT_TESTED when no objective breakage or human review exists", () => {
    const candidate = createEvidenceBackedExcessCandidate({
      elementId: "hero-copy",
      selector: "[data-nexus-element='hero-copy']",
      purposes: ["IDENTITY"],
      rationale: "Carries the project-specific opening voice",
      artifact: artifact(),
    });
    expect(candidate.observation).toBeUndefined();
    expect(evaluateExcessRemoval([candidate]).verdict).toBe("NOT_TESTED");
  });

  it("derives BROKEN_EXPERIENCE only from strong objective before/after invariants", () => {
    const removal = artifact({
      before: { ...artifact().before, headingOneCount: 1, target: { ...artifact().before.target, headingOneCount: 1 } },
      after: { ...artifact().after, headingOneCount: 0 },
    });
    const candidate = createEvidenceBackedExcessCandidate({
      elementId: "hero-copy",
      selector: "[data-nexus-element='hero-copy']",
      purposes: ["HIERARCHY", "CONTENT"],
      rationale: "Owns the only page-level heading",
      artifact: removal,
    });
    expect(candidate.observation?.outcome).toBe("BROKEN_EXPERIENCE");
    const report = evaluateExcessRemoval([candidate]);
    expect(report.verdict).toBe("PASS");
    expect(report.findings[0]?.evidenceIds).toEqual([digest("a"), digest("b"), digest("c")]);
  });

  it("accepts a human judgment only when it is bound to the exact executed evidence digests", () => {
    const executed = artifact();
    const candidate = createEvidenceBackedExcessCandidate({
      elementId: "hero-copy",
      selector: "[data-nexus-element='hero-copy']",
      purposes: ["IDENTITY"],
      rationale: "Carries the project-specific opening voice",
      artifact: executed,
      review: {
        elementId: "hero-copy",
        reviewerType: "HUMAN",
        reviewerId: "art-director-01",
        outcome: "MEANINGFUL_LOSS",
        notes: "Removal collapses the intended identity hierarchy.",
        reviewedAt: "2026-09-01T15:30:00.000Z",
        beforeScreenshotDigest: executed.beforeScreenshotDigest,
        afterScreenshotDigest: executed.afterScreenshotDigest,
        diagnosticsDigest: executed.diagnosticsDigest,
      },
    });
    expect(evaluateExcessRemoval([candidate]).verdict).toBe("PASS");
    expect(() => createEvidenceBackedExcessCandidate({
      elementId: "hero-copy",
      selector: "[data-nexus-element='hero-copy']",
      purposes: ["IDENTITY"],
      rationale: "Carries the project-specific opening voice",
      artifact: executed,
      review: {
        elementId: "hero-copy",
        reviewerType: "HUMAN",
        reviewerId: "art-director-01",
        outcome: "MEANINGFUL_LOSS",
        notes: "Stale review",
        reviewedAt: "2026-09-01T15:30:00.000Z",
        beforeScreenshotDigest: digest("d"),
        afterScreenshotDigest: executed.afterScreenshotDigest,
        diagnosticsDigest: executed.diagnosticsDigest,
      },
    })).toThrow(/not bound/);
  });
});
