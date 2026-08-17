import { describe, expect, it } from "vitest";
import type { BrowserMutationArtifact, BrowserMutationId } from "@nexus/capture/mutation-runner";
import { evaluateBrowserMutationEvidence } from "../mutation-evaluator";

function artifact(id: BrowserMutationId, overrides: Partial<BrowserMutationArtifact["diagnostics"]> = {}): BrowserMutationArtifact {
  return {
    mutationId: id,
    browser: "chromium",
    viewport: { width: id === "VIEWPORT_TORTURE_NARROW" ? 320 : id === "VIEWPORT_TORTURE_WIDE" ? 1920 : 390, height: 844 },
    screenshotUri: `/tmp/${id}.png`,
    screenshotDigest: `sha256:${"a".repeat(64)}`,
    screenshotByteLength: 128,
    diagnosticsUri: `/tmp/${id}.json`,
    diagnosticsDigest: `sha256:${"b".repeat(64)}`,
    diagnostics: {
      horizontalOverflowPx: 0,
      scrollHeightPx: 1200,
      visibleElementCount: 12,
      textCharacterCount: 200,
      mediaElementCount: 2,
      animatedElementCount: id === "MOTION_REMOVAL" ? 0 : 1,
      replacementCount: id === "BRAND_SWAP" || id === "INDUSTRY_TRANSPLANT" ? 2 : 0,
      ...overrides,
    },
  };
}

const objectiveArtifacts = (): BrowserMutationArtifact[] => [
  artifact("GRAYSCALE"),
  artifact("MOTION_REMOVAL"),
  artifact("VIEWPORT_TORTURE_NARROW"),
  artifact("VIEWPORT_TORTURE_WIDE"),
  artifact("CONTENT_STRESS"),
  artifact("ASSET_DEGRADATION"),
];

describe("browser mutation evidence evaluator", () => {
  it("passes objective layout-resilience attacks but keeps visual identity attacks NOT_TESTED", () => {
    const report = evaluateBrowserMutationEvidence(objectiveArtifacts());
    expect(report.verdicts.CONTENT_STRESS).toBe("PASS");
    expect(report.verdicts.ASSET_DEGRADATION).toBe("PASS");
    expect(report.verdicts.VIEWPORT_TORTURE).toBe("PASS");
    expect(report.verdicts.MOTION_REMOVAL).toBe("PASS");
    expect(report.verdicts.GRAYSCALE).toBe("NOT_TESTED");
    expect(report.verdicts.BRAND_SWAP).toBe("NOT_TESTED");
    expect(report.verdicts.INDUSTRY_TRANSPLANT).toBe("NOT_TESTED");
    expect(report.findings.some((finding) => finding.includes("identity survival requires"))).toBe(true);
  });

  it("binds explicit brand and industry mutation artifacts without pretending they visually passed", () => {
    const report = evaluateBrowserMutationEvidence([...objectiveArtifacts(), artifact("BRAND_SWAP"), artifact("INDUSTRY_TRANSPLANT")]);
    expect(report.verdicts.BRAND_SWAP).toBe("NOT_TESTED");
    expect(report.verdicts.INDUSTRY_TRANSPLANT).toBe("NOT_TESTED");
    expect(report.evidence.BRAND_SWAP).toHaveLength(2);
    expect(report.evidence.INDUSTRY_TRANSPLANT).toHaveLength(2);
    expect(report.findings.some((finding) => finding.includes("executed 2 explicit"))).toBe(true);
  });

  it("fails an identity mutation artifact that claims no replacement happened", () => {
    const report = evaluateBrowserMutationEvidence([...objectiveArtifacts(), artifact("BRAND_SWAP", { replacementCount: 0 })]);
    expect(report.verdicts.BRAND_SWAP).toBe("FAIL");
    expect(report.findings.some((finding) => finding.includes("matched no rendered content"))).toBe(true);
  });

  it("fails content stress on measured horizontal overflow", () => {
    const artifacts = objectiveArtifacts().map((item) => item.mutationId === "CONTENT_STRESS" ? artifact("CONTENT_STRESS", { horizontalOverflowPx: 48 }) : item);
    const report = evaluateBrowserMutationEvidence(artifacts);
    expect(report.verdicts.CONTENT_STRESS).toBe("FAIL");
    expect(report.findings.some((finding) => finding.includes("48px"))).toBe(true);
  });

  it("requires both narrow and ultrawide viewport torture evidence", () => {
    const artifacts = objectiveArtifacts().filter((item) => item.mutationId !== "VIEWPORT_TORTURE_WIDE");
    const report = evaluateBrowserMutationEvidence(artifacts);
    expect(report.verdicts.VIEWPORT_TORTURE).toBe("NOT_TESTED");
  });

  it("fails motion removal if animation survives the mutation", () => {
    const artifacts = objectiveArtifacts().map((item) => item.mutationId === "MOTION_REMOVAL" ? artifact("MOTION_REMOVAL", { animatedElementCount: 2 }) : item);
    const report = evaluateBrowserMutationEvidence(artifacts);
    expect(report.verdicts.MOTION_REMOVAL).toBe("FAIL");
  });

  it("rejects malformed digests instead of treating the artifact as measured evidence", () => {
    const artifacts = objectiveArtifacts();
    const index = artifacts.findIndex((item) => item.mutationId === "ASSET_DEGRADATION");
    artifacts[index] = { ...artifacts[index]!, diagnosticsDigest: "not-a-digest" };
    const report = evaluateBrowserMutationEvidence(artifacts);
    expect(report.verdicts.ASSET_DEGRADATION).toBe("FAIL");
  });
});
