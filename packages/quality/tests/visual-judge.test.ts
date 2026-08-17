import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CaptureArtifact } from "@nexus/capture";
import { calibrateVisualReviewer, executeMultimodalVisualReview, judgeVisualEvidence, type MultimodalVisualJudgePort, type VisualReview } from "../visual-judge";

const tempDirs: string[] = [];
const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function evidenceArtifacts(): Promise<CaptureArtifact[]> {
  const dir = await mkdtemp(join(tmpdir(), "nexus-visual-judge-"));
  tempDirs.push(dir);
  const artifacts: CaptureArtifact[] = [];
  for (const browser of ["chromium", "webkit"]) {
    for (const viewport of ["mobile-390", "tablet-768", "desktop-1440"]) {
      const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(`${browser}:${viewport}`)]);
      const pngPath = join(dir, `${browser}-${viewport}.png`);
      await writeFile(pngPath, png);
      artifacts.push({
        artifactId: `png-${browser}-${viewport}`,
        runId: "run-a",
        scope: { tenantId: "tenant-a", brandId: "brand-a" },
        capability: "SCREENSHOT",
        mediaType: "image/png",
        digest: digest(png),
        byteLength: png.byteLength,
        capturedAt: "2026-08-17T00:00:00.000Z",
        uri: pngPath,
        metadata: { browser, viewport },
      });

      const genome = Buffer.from(`${JSON.stringify({ schemaVersion: 1, visibleElementCount: 8, viewport: { width: viewport === "mobile-390" ? 390 : viewport === "tablet-768" ? 768 : 1440 } })}\n`);
      const genomePath = join(dir, `${browser}-${viewport}-genome.json`);
      await writeFile(genomePath, genome);
      artifacts.push({
        artifactId: `genome-${browser}-${viewport}`,
        runId: "run-a",
        scope: { tenantId: "tenant-a", brandId: "brand-a" },
        capability: "DESIGN_GENOME",
        mediaType: "application/vnd.nexus.design-genome+json",
        digest: digest(genome),
        byteLength: genome.byteLength,
        capturedAt: "2026-08-17T00:00:00.000Z",
        uri: genomePath,
        metadata: { browser, viewport },
      });
    }
  }
  return artifacts;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("NEXUS visual judge", () => {
  it("returns NOT_TESTED when evidence is real but no human/model review was executed", async () => {
    const artifacts = await evidenceArtifacts();
    const result = await judgeVisualEvidence({ artifacts });
    expect(result.integrityVerdict).toBe("PASS");
    expect(result.reviewVerdict).toBe("NOT_TESTED");
    expect(result.verdict).toBe("NOT_TESTED");
    expect(result.approved).toBe(false);
    expect(result.verifiedArtifactIds).toHaveLength(12);
  });

  it("approves only when a traceable review references persisted evidence", async () => {
    const artifacts = await evidenceArtifacts();
    const review: VisualReview = {
      reviewerType: "HUMAN",
      reviewerId: "creative-director-1",
      rubricVersion: "nexus-visual-rubric-v1",
      verdict: "PASS",
      findings: ["hierarchy and responsive composition survived review"],
      evidenceArtifactIds: artifacts.filter((artifact) => artifact.capability === "SCREENSHOT").map((artifact) => artifact.artifactId),
      reviewedAt: "2026-08-17T00:01:00.000Z",
    };
    const result = await judgeVisualEvidence({ artifacts, review });
    expect(result.integrityVerdict).toBe("PASS");
    expect(result.reviewVerdict).toBe("PASS");
    expect(result.verdict).toBe("PASS");
    expect(result.approved).toBe(true);
  });

  it("executes a multimodal port over verified PNG bytes and seals provider provenance", async () => {
    const artifacts = await evidenceArtifacts();
    let observedImageCount = 0;
    const port: MultimodalVisualJudgePort = {
      providerId: "fixture-provider",
      modelId: "ui-specialist-fixture",
      configurationDigest: `sha256:${"c".repeat(64)}`,
      review: async ({ rubricVersion, images }) => {
        expect(rubricVersion).toBe("nexus-visual-rubric-v2");
        expect(images.every((image) => image.bytes.subarray(0, 8).toString() !== "")).toBe(true);
        expect(images.every((image) => image.digest.startsWith("sha256:"))).toBe(true);
        observedImageCount = images.length;
        return { verdict: "PASS", findings: ["synthetic port fixture reviewed persisted PNG bytes"], reviewedAt: "2026-08-17T00:01:00.000Z", requestId: "fixture-request-1" };
      },
    };
    const review = await executeMultimodalVisualReview({ artifacts, reviewerId: "visual-review-service", rubricVersion: "nexus-visual-rubric-v2", port });
    expect(observedImageCount).toBe(6);
    expect(review.providerId).toBe("fixture-provider");
    expect(review.modelId).toBe("ui-specialist-fixture");
    expect(review.providerRequestId).toBe("fixture-request-1");
    expect(review.modelIdentity).toContain("fixture-provider/ui-specialist-fixture");
    const result = await judgeVisualEvidence({ artifacts, review });
    expect(result.verdict).toBe("PASS");
  });

  it("fails closed if persisted bytes do not match the declared SHA-256 before multimodal execution", async () => {
    const artifacts = await evidenceArtifacts();
    const first = artifacts[0]!;
    await writeFile(first.uri!, Buffer.from("tampered"));
    const result = await judgeVisualEvidence({ artifacts });
    expect(result.integrityVerdict).toBe("FAIL");
    expect(result.verdict).toBe("FAIL");
    expect(result.findings.some((finding) => finding.includes(first.artifactId))).toBe(true);
    const port: MultimodalVisualJudgePort = {
      providerId: "fixture-provider",
      modelId: "ui-specialist-fixture",
      configurationDigest: `sha256:${"d".repeat(64)}`,
      review: async () => ({ verdict: "PASS", findings: [], reviewedAt: "2026-08-17T00:01:00.000Z", requestId: "must-not-run" }),
    };
    await expect(executeMultimodalVisualReview({ artifacts, reviewerId: "visual-review-service", rubricVersion: "rubric-v1", port })).rejects.toThrow(/refused unverified screenshot/);
  });

  it("refuses multimodal reviews that hide execution provenance", async () => {
    const artifacts = await evidenceArtifacts();
    const result = await judgeVisualEvidence({
      artifacts,
      review: {
        reviewerType: "MULTIMODAL_MODEL",
        reviewerId: "visual-review-service",
        rubricVersion: "nexus-visual-rubric-v1",
        verdict: "PASS",
        findings: [],
        evidenceArtifactIds: [artifacts[0]!.artifactId],
        reviewedAt: "2026-08-17T00:01:00.000Z",
        modelIdentity: "opaque-string-only",
      },
    });
    expect(result.verdict).toBe("FAIL");
    expect(result.findings).toContain("multimodal visual review must identify provider, model, configuration digest and provider request");
  });
});

describe("visual reviewer calibration", () => {
  it("computes agreement from labeled observations rather than inventing a quality score", () => {
    const report = calibrateVisualReviewer([
      { exampleId: "a", humanVerdict: "PASS", reviewerVerdict: "PASS" },
      { exampleId: "b", humanVerdict: "FAIL", reviewerVerdict: "FAIL" },
      { exampleId: "c", humanVerdict: "WARNING", reviewerVerdict: "PASS" },
      { exampleId: "d", humanVerdict: "PASS", reviewerVerdict: "PASS" },
    ]);
    expect(report.sampleCount).toBe(4);
    expect(report.exactAgreementCount).toBe(3);
    expect(report.exactAgreementRate).toBe(0.75);
    expect(report.confusion.WARNING.PASS).toBe(1);
    expect(report.disagreements).toEqual(["c"]);
  });

  it("refuses an empty calibration corpus", () => {
    expect(() => calibrateVisualReviewer([])).toThrow(/requires labeled examples/);
  });
});
