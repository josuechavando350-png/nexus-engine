import { describe, expect, it } from "vitest";
import type { BrowserMutationArtifact, BrowserMutationId } from "@nexus/capture/mutation-runner";
import { evaluateBrowserMutationEvidence, type MutationVisualReview } from "../mutation-evaluator";

function artifact(id: BrowserMutationId, overrides: Partial<BrowserMutationArtifact["diagnostics"]> = {}): BrowserMutationArtifact {
  const suffix = id.toLowerCase();
  return {
    mutationId: id,
    browser: "chromium",
    viewport: { width: id === "VIEWPORT_TORTURE_NARROW" ? 320 : id === "VIEWPORT_TORTURE_WIDE" ? 1920 : 390, height: 844 },
    screenshotUri: `/tmp/${id}.png`,
    screenshotDigest: `sha256:${suffix.padEnd(64, "a").slice(0, 64).replace(/[^a-f0-9]/g, "a")}`,
    screenshotByteLength: 128,
    diagnosticsUri: `/tmp/${id}.json`,
    diagnosticsDigest: `sha256:${suffix.padEnd(64, "b").slice(0, 64).replace(/[^a-f0-9]/g, "b")}`,
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

function review(attackId: MutationVisualReview["attackId"], target: BrowserMutationArtifact): MutationVisualReview {
  return {
    attackId,
    verdict: "PASS",
    reviewerType: "HUMAN",
    reviewerId: "designer-a",
    rubricVersion: "mutation-rubric-v1",
    rubricDigest: `sha256:${"e".repeat(64)}`,
    reviewedAt: "2026-08-17T08:00:00.000Z",
    evidenceDigests: [target.screenshotDigest, target.diagnosticsDigest],
  };
}

describe("browser mutation evidence evaluator", () => {
  it("passes objective layout-resilience attacks but keeps visual identity attacks NOT_TESTED without review", () => {
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

  it("can PASS brand swap, industry transplant and grayscale only with reviews bound to exact mutation and rubric digests", () => {
    const brand = artifact("BRAND_SWAP");
    const industry = artifact("INDUSTRY_TRANSPLANT");
    const grayscale = artifact("GRAYSCALE");
    const artifacts = [...objectiveArtifacts().filter((item) => item.mutationId !== "GRAYSCALE"), grayscale, brand, industry];
    const report = evaluateBrowserMutationEvidence(artifacts, { maxHorizontalOverflowPx: 1, minimumVisibleElements: 1 }, [
      review("BRAND_SWAP", brand),
      review("INDUSTRY_TRANSPLANT", industry),
      review("GRAYSCALE", grayscale),
    ]);
    expect(report.verdicts.BRAND_SWAP).toBe("PASS");
    expect(report.verdicts.INDUSTRY_TRANSPLANT).toBe("PASS");
    expect(report.verdicts.GRAYSCALE).toBe("PASS");
    expect(report.evidence.BRAND_SWAP).toContain(brand.screenshotDigest);
    expect(report.evidence.BRAND_SWAP).toContain(`sha256:${"e".repeat(64)}`);
  });

  it("rejects stale visual review evidence instead of approving a newer mutation", () => {
    const brand = artifact("BRAND_SWAP");
    const staleReview = { ...review("BRAND_SWAP", brand), evidenceDigests: [`sha256:${"c".repeat(64)}`, brand.diagnosticsDigest] };
    const report = evaluateBrowserMutationEvidence([...objectiveArtifacts(), brand], { maxHorizontalOverflowPx: 1, minimumVisibleElements: 1 }, [staleReview]);
    expect(report.verdicts.BRAND_SWAP).toBe("FAIL");
    expect(report.findings.some((finding) => finding.includes("not bound to current mutation evidence"))).toBe(true);
  });

  it("rejects a visual review whose rubric identity is only a mutable label", () => {
    const brand = artifact("BRAND_SWAP");
    const mutableRubricReview = { ...review("BRAND_SWAP", brand), rubricDigest: "rubric-v1" as MutationVisualReview["rubricDigest"] };
    const report = evaluateBrowserMutationEvidence([...objectiveArtifacts(), brand], { maxHorizontalOverflowPx: 1, minimumVisibleElements: 1 }, [mutableRubricReview]);
    expect(report.verdicts.BRAND_SWAP).toBe("FAIL");
    expect(report.findings.some((finding) => finding.includes("rubricDigest must be a canonical SHA-256"))).toBe(true);
  });

  it("requires multimodal provenance for model-based mutation reviews", () => {
    const brand = artifact("BRAND_SWAP");
    const modelReview: MutationVisualReview = { ...review("BRAND_SWAP", brand), reviewerType: "MULTIMODAL_MODEL" };
    const report = evaluateBrowserMutationEvidence([...objectiveArtifacts(), brand], { maxHorizontalOverflowPx: 1, minimumVisibleElements: 1 }, [modelReview]);
    expect(report.verdicts.BRAND_SWAP).toBe("FAIL");
    expect(report.findings.some((finding) => finding.includes("requires provider, model"))).toBe(true);
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
