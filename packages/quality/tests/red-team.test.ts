import { describe, expect, it } from "vitest";
import type { CaptureArtifact } from "@nexus/capture";
import type { CreativeCriticReport, VerdictState } from "@nexus/creative";
import type { StyleFingerprintV2 } from "@nexus/experience";
import { runRedTeamArena, type MutationAttackId } from "../red-team";
import type { StructuralFingerprintReport } from "../structural-fingerprint";

const fingerprint: StyleFingerprintV2 = {
  version: 2,
  subject: "subject-a",
  observedAt: "2026-08-17T00:00:00.000Z",
  openingSignature: "object-led asymmetric opening",
  navigationSignature: "quiet edge navigation",
  sectionSequence: ["opening", "ritual", "proof", "conversion"],
  structure: { cardReliance: 0.1, gridRegularity: 0.3, symmetry: 0.2, overlap: 0.7, whitespace: 0.6, continuity: 0.9 },
  ctaGrammar: ["contextual invitation"],
  geometryGrammar: ["cross-boundary object", "offset axis"],
  mediaGrammar: ["documentary crop", "continuity frame"],
  motionGrammar: ["state transition", "spatial continuity"],
  typographyHierarchy: ["high contrast", "editorial interruption"],
};

const creativeReport: CreativeCriticReport = {
  authority: "NEXUS_CREATIVE_CRITIC",
  verdict: "PASS",
  approved: true,
  findings: [],
  referenceEntryIds: ["ref-a", "ref-b"],
};

const structuralPass: StructuralFingerprintReport = Object.freeze({
  authority: "NEXUS_STRUCTURAL_FINGERPRINT",
  templateFingerprint: Object.freeze({ verdict: "PASS", findings: Object.freeze([]), evidence: Object.freeze(["history:checked"]) }),
  aiFingerprint: Object.freeze({ verdict: "PASS", findings: Object.freeze([]), evidence: Object.freeze(["genome:measured"]) }),
});

const mutationIds = [
  "BRAND_SWAP",
  "INDUSTRY_TRANSPLANT",
  "CONTENT_STRESS",
  "ASSET_DEGRADATION",
  "VIEWPORT_TORTURE",
  "MOTION_REMOVAL",
  "GRAYSCALE",
] as const satisfies readonly MutationAttackId[];

const mutationPass = Object.freeze(Object.fromEntries(mutationIds.map((attackId) => [attackId, "PASS"])) as Record<MutationAttackId, VerdictState>);
const mutationEvidence = Object.freeze(Object.fromEntries(mutationIds.map((attackId) => [attackId, Object.freeze([`probe:${attackId.toLowerCase()}`])])) as Record<MutationAttackId, readonly string[]>);

const distinctFingerprint = (subject = "subject-b"): StyleFingerprintV2 => ({
  ...fingerprint,
  subject,
  openingSignature: "typographic sequence",
  navigationSignature: "inline editorial navigation",
  sectionSequence: ["intro", "evidence", "decision"],
  ctaGrammar: ["direct booking"],
});

function artifact(capability: "SCREENSHOT" | "ACCESSIBILITY", browser: string, viewport: string): CaptureArtifact {
  return {
    artifactId: `artifact-${capability}-${browser}-${viewport}`,
    runId: "run-a",
    scope: { tenantId: "tenant-a", brandId: "brand-a" },
    capability,
    mediaType: capability === "SCREENSHOT" ? "image/png" : "application/json",
    digest: `sha256:${"a".repeat(64)}`,
    byteLength: 128,
    capturedAt: "2026-08-17T00:00:01.000Z",
    uri: `/evidence/${capability}-${browser}-${viewport}`,
    metadata: { browser, viewport },
  };
}

function completeArtifacts(): CaptureArtifact[] {
  return ["chromium", "webkit"].flatMap((browser) =>
    ["mobile-390", "tablet-768", "desktop-1440"].flatMap((viewport) => [
      artifact("SCREENSHOT", browser, viewport),
      artifact("ACCESSIBILITY", browser, viewport),
    ]),
  );
}

describe("NEXUS Red Team Arena", () => {
  it("passes only when creative, corpus, structural fingerprints, browser evidence and every mutation attack have executed cleanly with evidence", () => {
    const report = runRedTeamArena({
      experienceId: "experience-a",
      creativeReport,
      fingerprint,
      corpus: [distinctFingerprint()],
      artifacts: completeArtifacts(),
      mutationVerdicts: mutationPass,
      mutationEvidence,
      structuralFingerprint: structuralPass,
    });
    expect(report.verdict).toBe("PASS");
    expect(report.approved).toBe(true);
    expect(report.attacks.every((item) => item.verdict === "PASS")).toBe(true);
  });

  it("downgrades a declared mutation PASS to NOT_TESTED when no evidence is bound", () => {
    const report = runRedTeamArena({
      experienceId: "experience-a",
      creativeReport,
      fingerprint,
      corpus: [distinctFingerprint()],
      artifacts: completeArtifacts(),
      mutationVerdicts: mutationPass,
      structuralFingerprint: structuralPass,
    });
    expect(report.verdict).toBe("NOT_TESTED");
    expect(report.approved).toBe(false);
    expect(report.attacks.find((item) => item.attackId === "BRAND_SWAP")?.detail).toContain("declared PASS without evidence");
  });

  it("returns NOT_TESTED when structural fingerprint attacks were omitted", () => {
    const report = runRedTeamArena({
      experienceId: "experience-a",
      creativeReport,
      fingerprint,
      corpus: [distinctFingerprint()],
      artifacts: completeArtifacts(),
      mutationVerdicts: mutationPass,
      mutationEvidence,
    });
    expect(report.verdict).toBe("NOT_TESTED");
    expect(report.attacks.find((item) => item.attackId === "TEMPLATE_FINGERPRINT")?.verdict).toBe("NOT_TESTED");
    expect(report.attacks.find((item) => item.attackId === "AI_FINGERPRINT")?.verdict).toBe("NOT_TESTED");
  });

  it("returns NOT_TESTED when there is no originality corpus instead of inventing originality", () => {
    const report = runRedTeamArena({
      experienceId: "experience-a",
      creativeReport,
      fingerprint,
      corpus: [],
      artifacts: completeArtifacts(),
      mutationVerdicts: mutationPass,
      mutationEvidence,
      structuralFingerprint: structuralPass,
    });
    expect(report.verdict).toBe("NOT_TESTED");
    expect(report.approved).toBe(false);
    expect(report.attacks.find((item) => item.attackId === "CORPUS_ORIGINALITY")?.verdict).toBe("NOT_TESTED");
  });

  it("fails when the required Chromium/WebKit x 390/768/1440 evidence matrix is incomplete", () => {
    const artifacts = completeArtifacts().filter((item) => item.metadata?.browser !== "webkit" || item.metadata?.viewport !== "mobile-390");
    const report = runRedTeamArena({
      experienceId: "experience-a",
      creativeReport,
      fingerprint,
      corpus: [distinctFingerprint()],
      artifacts,
      mutationVerdicts: mutationPass,
      mutationEvidence,
      structuralFingerprint: structuralPass,
    });
    expect(report.verdict).toBe("FAIL");
    expect(report.attacks.filter((item) => ["BROWSER_COVERAGE", "ACCESSIBILITY_EVIDENCE"].includes(item.attackId)).every((item) => item.verdict === "FAIL")).toBe(true);
  });

  it("fails exact structural duplication against the corpus", () => {
    const report = runRedTeamArena({
      experienceId: "experience-a",
      creativeReport,
      fingerprint,
      corpus: [{ ...fingerprint, subject: "copied-subject" }],
      artifacts: completeArtifacts(),
      mutationVerdicts: mutationPass,
      mutationEvidence,
      structuralFingerprint: structuralPass,
    });
    expect(report.verdict).toBe("FAIL");
    expect(report.attacks.find((item) => item.attackId === "CORPUS_ORIGINALITY")?.verdict).toBe("FAIL");
  });

  it("fails when the measured structural AI fingerprint exposes a banned pattern", () => {
    const structuralFail: StructuralFingerprintReport = {
      ...structuralPass,
      aiFingerprint: { verdict: "FAIL", findings: ["generic card-grid"], evidence: ["gridRegularity:0.9"] },
    };
    const report = runRedTeamArena({
      experienceId: "experience-a",
      creativeReport,
      fingerprint,
      corpus: [distinctFingerprint()],
      artifacts: completeArtifacts(),
      mutationVerdicts: mutationPass,
      mutationEvidence,
      structuralFingerprint: structuralFail,
    });
    expect(report.verdict).toBe("FAIL");
    expect(report.attacks.find((item) => item.attackId === "AI_FINGERPRINT")?.verdict).toBe("FAIL");
  });

  it("cannot approve when any required mutation attack was not executed", () => {
    const mutations = { ...mutationPass, GRAYSCALE: "NOT_TESTED" as const };
    const report = runRedTeamArena({
      experienceId: "experience-a",
      creativeReport,
      fingerprint,
      corpus: [distinctFingerprint()],
      artifacts: completeArtifacts(),
      mutationVerdicts: mutations,
      mutationEvidence,
      structuralFingerprint: structuralPass,
    });
    expect(report.verdict).toBe("NOT_TESTED");
    expect(report.approved).toBe(false);
  });
});
