import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  createHumanSaliencyObservation,
  predictSaliencyFromNexusScreenshot,
  validateSaliencyReport,
} from "../saliency-model.js";

const scope = Object.freeze({ tenantId: "tenant-a", brandId: "brand-a" });
const observedAt = "2026-08-31T05:30:00.000Z";

async function syntheticScreenshot(): Promise<Buffer> {
  return sharp({
    create: { width: 160, height: 120, channels: 3, background: { r: 16, g: 16, b: 16 } },
  })
    .composite([{ input: Buffer.from('<svg width="48" height="48"><rect width="48" height="48" fill="white"/></svg>'), left: 104, top: 16 }])
    .png()
    .toBuffer();
}

describe("saliency model evidence", () => {
  it("predicts saliency from actual PNG screenshot bytes without claiming eye tracking", async () => {
    const png = await syntheticScreenshot();
    const report = await predictSaliencyFromNexusScreenshot(png, {
      scope,
      subject: "synthetic-screenshot-fixture",
      observedAt,
    });

    expect(report.evidenceType).toBe("MODEL_PREDICTION");
    expect(report.provenance.source).toBe("NEXUS_SCREENSHOT_BYTES");
    expect(report.model?.interpretation).toBe("PREDICTED_VISUAL_SALIENCY_NOT_EYE_TRACKING");
    expect(report.screenshotDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(report.sourceDimensions).toEqual({ width: 160, height: 120 });
    expect(report.regions).toHaveLength(8);
    expect(report.regions.some((region) => region.x >= 80 && region.score > 0)).toBe(true);
    expect(report.visualAlgebra?.termDigest).toMatch(/^sha256:/u);
    expect(report.visualAlgebra?.samples.some((sample) => sample.name === "visual_algebra.whitespace")).toBe(true);
    expect(() => validateSaliencyReport(report)).not.toThrow();
  });

  it("is deterministic for identical screenshot bytes and explicit timestamp", async () => {
    const png = await syntheticScreenshot();
    const left = await predictSaliencyFromNexusScreenshot(png, { scope, subject: "same", observedAt });
    const right = await predictSaliencyFromNexusScreenshot(png, { scope, subject: "same", observedAt });
    expect(left.reportDigest).toBe(right.reportDigest);
    expect(left.regions).toEqual(right.regions);
    expect(left.visualAlgebra?.termDigest).toBe(right.visualAlgebra?.termDigest);
  });

  it("fails closed for non-PNG bytes", async () => {
    const report = await predictSaliencyFromNexusScreenshot(Buffer.from("not-a-png"), {
      scope,
      subject: "invalid",
      observedAt,
    });
    expect(report.evidenceType).toBe("UNAVAILABLE");
    expect(report.reason).toMatch(/PNG screenshots only/);
    expect(report.regions).toEqual([]);
    expect(report.visualAlgebra).toBeNull();
    expect(() => validateSaliencyReport(report)).not.toThrow();
  });

  it("honors cancellation before model work", async () => {
    const png = await syntheticScreenshot();
    const controller = new AbortController();
    controller.abort();
    await expect(predictSaliencyFromNexusScreenshot(png, {
      scope,
      subject: "cancelled",
      observedAt,
      signal: controller.signal,
    })).rejects.toThrow(/cancelled/);
  });

  it("detects replay tampering", async () => {
    const png = await syntheticScreenshot();
    const report = await predictSaliencyFromNexusScreenshot(png, { scope, subject: "tamper", observedAt });
    expect(report.evidenceType).toBe("MODEL_PREDICTION");
    const tampered = { ...report, subject: "changed-after-capture" };
    expect(() => validateSaliencyReport(tampered)).toThrow(/replay digest mismatch/);
  });

  it("keeps explicit human observations separate from model predictions", () => {
    const human = createHumanSaliencyObservation({
      scope,
      subject: "human-study-fixture",
      observedAt,
      screenshotDigest: `sha256:${"a".repeat(64)}`,
      screenshotBytes: 1_024,
      sourceDimensions: { width: 160, height: 120 },
      observerId: "synthetic-observer-fixture",
      protocolId: "synthetic-protocol-fixture",
      regions: [
        { id: "saliency-01", rank: 1, score: 0.9, x: 100, y: 10, width: 40, height: 40 },
      ],
    });
    expect(human.evidenceType).toBe("HUMAN_OBSERVATION");
    expect(human.model).toBeNull();
    expect(human.provenance.source).toBe("HUMAN_STUDY");
    expect(human.provenance.observerIdDigest).toMatch(/^sha256:/u);
    expect(() => validateSaliencyReport(human)).not.toThrow();
  });

  it("rejects unsafe model budgets instead of widening them", async () => {
    const png = await syntheticScreenshot();
    await expect(predictSaliencyFromNexusScreenshot(png, {
      scope,
      subject: "budget",
      observedAt,
      maxRegions: 1_000,
    })).rejects.toThrow(/maxRegions/);
    await expect(predictSaliencyFromNexusScreenshot(png, {
      scope,
      subject: "budget",
      observedAt,
      analysisMaxDimension: 1_000,
    })).rejects.toThrow(/analysisMaxDimension/);
  });
});
