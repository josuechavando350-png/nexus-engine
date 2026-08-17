import { describe, expect, it } from "vitest";
import type { DesignGenomeObservation } from "@nexus/capture/design-genome";
import type { StyleFingerprintV2 } from "@nexus/experience";
import { evaluateStructuralFingerprints } from "../structural-fingerprint";

const fingerprint: StyleFingerprintV2 = {
  version: 2,
  subject: "project-a",
  observedAt: "2026-08-17T08:00:00.000Z",
  openingSignature: "asymmetric object-led opening",
  navigationSignature: "edge navigation",
  sectionSequence: ["opening", "proof", "ritual", "conversion"],
  structure: { cardReliance: 0.1, gridRegularity: 0.25, symmetry: 0.2, overlap: 0.7, whitespace: 0.65, continuity: 0.85 },
  ctaGrammar: ["contextual invitation"],
  geometryGrammar: ["cross-boundary object"],
  mediaGrammar: ["documentary crop"],
  motionGrammar: ["spatial continuity"],
  typographyHierarchy: ["editorial interruption"],
};

function genome(overrides: Partial<DesignGenomeObservation> = {}): DesignGenomeObservation {
  return {
    schemaVersion: 1,
    viewport: { width: 390, height: 844 },
    visibleElementCount: 40,
    layout: { gridElementCount: 1, flexElementCount: 2, centeredElementRatio: 0.2, viewportOccupancyRatio: 0.8, horizontalOffsetMean: 0.4 },
    typography: { fontSizePx: [12, 16, 48], fontWeight: [400, 600], lineHeightRatio: [1.1, 1.4], familyCount: 2 },
    geometry: { borderRadiusPx: [0, 4, 12, 24], aspectRatios: [1, 1.4, 1.8] },
    media: { imageCount: 3, videoCount: 0, mediaAreaRatio: 0.35 },
    rhythm: { landmarkHeightsPx: [500, 650, 700], landmarkGapPx: [48, 96] },
    motion: { animatedElementCount: 4, transitionDurationMs: [180, 260], animationDurationMs: [800] },
    ...overrides,
  };
}

describe("structural fingerprint gates", () => {
  it("passes a distinct project when history and measured genomes are available", () => {
    const prior = { ...fingerprint, subject: "project-old", openingSignature: "full-bleed editorial media", navigationSignature: "floating rail" };
    const report = evaluateStructuralFingerprints({ fingerprint, priorFingerprints: [prior], genomes: [genome()] });
    expect(report.templateFingerprint.verdict).toBe("PASS");
    expect(report.aiFingerprint.verdict).toBe("PASS");
  });

  it("keeps template regression NOT_TESTED without historical project fingerprints", () => {
    const report = evaluateStructuralFingerprints({ fingerprint, priorFingerprints: [], genomes: [genome()] });
    expect(report.templateFingerprint.verdict).toBe("NOT_TESTED");
  });

  it("fails exact structural reuse from prior projects", () => {
    const prior = { ...fingerprint, subject: "project-old" };
    const report = evaluateStructuralFingerprints({ fingerprint, priorFingerprints: [prior], genomes: [genome()] });
    expect(report.templateFingerprint.verdict).toBe("FAIL");
    expect(report.templateFingerprint.findings.join(" ")).toMatch(/duplication/);
  });

  it("fails explicit prohibited structural markers without claiming an aesthetic AI score", () => {
    const generic = { ...fingerprint, openingSignature: "centered hero with four cards" };
    const prior = { ...fingerprint, subject: "project-old", openingSignature: "different" };
    const report = evaluateStructuralFingerprints({ fingerprint: generic, priorFingerprints: [prior], genomes: [genome()] });
    expect(report.aiFingerprint.verdict).toBe("FAIL");
    expect(report.aiFingerprint.findings.some((finding) => finding.includes("banned structural marker"))).toBe(true);
  });

  it("fails a measured generic centered card-grid with repeated geometry", () => {
    const generic: StyleFingerprintV2 = {
      ...fingerprint,
      structure: { ...fingerprint.structure, cardReliance: 0.9, gridRegularity: 0.92 },
    };
    const centered = genome({
      layout: { gridElementCount: 5, flexElementCount: 4, centeredElementRatio: 0.8, viewportOccupancyRatio: 0.85, horizontalOffsetMean: 0.1 },
      geometry: { borderRadiusPx: [16, 16, 16, 16, 16], aspectRatios: [1, 1, 1, 1] },
    });
    const prior = { ...fingerprint, subject: "project-old", openingSignature: "different" };
    const report = evaluateStructuralFingerprints({ fingerprint: generic, priorFingerprints: [prior], genomes: [centered] });
    expect(report.aiFingerprint.verdict).toBe("FAIL");
    expect(report.aiFingerprint.findings.some((finding) => finding.includes("card-grid"))).toBe(true);
    expect(report.aiFingerprint.evidence.some((item) => item.includes("centeredElementRatio"))).toBe(true);
    expect(report.aiFingerprint.evidence.some((item) => item.includes("radiusSpreadPx"))).toBe(true);
  });

  it("keeps structural AI fingerprint NOT_TESTED without measured Design Genome evidence", () => {
    const prior = { ...fingerprint, subject: "project-old", openingSignature: "different" };
    const report = evaluateStructuralFingerprints({ fingerprint, priorFingerprints: [prior], genomes: [] });
    expect(report.aiFingerprint.verdict).toBe("NOT_TESTED");
  });
});
