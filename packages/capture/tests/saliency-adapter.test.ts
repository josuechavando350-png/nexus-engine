import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  captureRequestId,
  createCaptureArtifact,
  type BrowserDeviceCapturePort,
  type CaptureRequest,
  type CaptureResult,
} from "../index.js";
import { SaliencyAugmentedCaptureAdapter } from "../saliency-adapter.js";
import { validateSaliencyReport, type SaliencyReport } from "../saliency-model.js";

const capturedAt = "2026-08-31T05:40:00.000Z";
const run = Object.freeze({
  runId: "run_saliency_fixture",
  workloadId: "workload-saliency",
  workloadVersion: "1",
  workloadDigest: "wrk_fixture",
  environmentDigest: "env_fixture",
  scope: Object.freeze({ tenantId: "tenant-a", brandId: "brand-a" }),
  startedAt: "2026-08-31T05:39:00.000Z",
});

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function fixturePng(): Promise<Buffer> {
  return sharp({ create: { width: 128, height: 96, channels: 3, background: { r: 20, g: 20, b: 20 } } })
    .composite([{ input: Buffer.from('<svg width="40" height="40"><circle cx="20" cy="20" r="18" fill="white"/></svg>'), left: 76, top: 12 }])
    .png()
    .toBuffer();
}

class ScreenshotFixtureAdapter implements BrowserDeviceCapturePort {
  readonly adapterId = "test.screenshot-fixture";
  readonly adapterVersion = "1";
  constructor(private readonly path: string, private readonly bytes: Buffer, private readonly overrideDigest?: string) {}

  async capture(request: CaptureRequest): Promise<CaptureResult> {
    const artifact = createCaptureArtifact({
      runId: request.run.runId,
      scope: request.scope,
      capability: "SCREENSHOT",
      mediaType: "image/png",
      digest: this.overrideDigest ?? digest(this.bytes),
      byteLength: this.bytes.byteLength,
      capturedAt,
      uri: this.path,
      metadata: Object.freeze({ browser: "chromium", viewport: "fixture-128" }),
    });
    return Object.freeze({
      requestId: captureRequestId(request),
      outcome: "CAPTURED",
      artifacts: Object.freeze([artifact]),
      samples: Object.freeze([]),
    });
  }
}

function request(capabilities: CaptureRequest["capabilities"]): CaptureRequest {
  return Object.freeze({
    run,
    scope: run.scope,
    targetId: "https://example.com/saliency",
    capabilities,
  });
}

describe("SaliencyAugmentedCaptureAdapter", () => {
  it("consumes canonical NEXUS screenshot evidence and emits a bound MODEL_PREDICTION artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-saliency-"));
    const path = join(directory, "capture.png");
    const png = await fixturePng();
    await writeFile(path, png);
    const adapter = new SaliencyAugmentedCaptureAdapter({
      playwright: { outputDir: directory },
      baseAdapter: new ScreenshotFixtureAdapter(path, png),
    });

    const result = await adapter.capture(request(["SALIENCY"]));
    expect(result.outcome).toBe("CAPTURED");
    expect(result.artifacts).toHaveLength(1);
    const artifact = result.artifacts[0]!;
    expect(artifact.capability).toBe("SALIENCY");
    expect(artifact.metadata?.evidenceType).toBe("MODEL_PREDICTION");
    expect(artifact.metadata?.sourceScreenshotDigest).toBe(digest(png));
    expect(artifact.metadata?.visualAlgebraTermDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(artifact.uri).toBeTruthy();
    const report = JSON.parse((await readFile(artifact.uri!, "utf8"))) as SaliencyReport;
    expect(report.evidenceType).toBe("MODEL_PREDICTION");
    expect(report.screenshotDigest).toBe(digest(png));
    expect(() => validateSaliencyReport(report)).not.toThrow();
  });

  it("preserves the requested screenshot artifact when SCREENSHOT and SALIENCY are both requested", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-saliency-"));
    const path = join(directory, "capture.png");
    const png = await fixturePng();
    await writeFile(path, png);
    const adapter = new SaliencyAugmentedCaptureAdapter({
      playwright: { outputDir: directory },
      baseAdapter: new ScreenshotFixtureAdapter(path, png),
    });
    const result = await adapter.capture(request(["SCREENSHOT", "SALIENCY"]));
    expect(result.outcome).toBe("CAPTURED");
    expect(result.artifacts.map((artifact) => artifact.capability).sort()).toEqual(["SALIENCY", "SCREENSHOT"]);
  });

  it("fails closed when persisted screenshot bytes do not match the NEXUS artifact digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-saliency-"));
    const path = join(directory, "capture.png");
    const png = await fixturePng();
    await writeFile(path, png);
    const adapter = new SaliencyAugmentedCaptureAdapter({
      playwright: { outputDir: directory },
      baseAdapter: new ScreenshotFixtureAdapter(path, png, `sha256:${"0".repeat(64)}`),
    });
    const result = await adapter.capture(request(["SALIENCY"]));
    expect(result.outcome).toBe("FAILED");
    expect(result.reason).toMatch(/digest does not match persisted bytes/);
    expect(result.artifacts).toEqual([]);
  });

  it("does not invoke the saliency layer for requests that do not ask for SALIENCY", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-saliency-"));
    const path = join(directory, "capture.png");
    const png = await fixturePng();
    await writeFile(path, png);
    const base = new ScreenshotFixtureAdapter(path, png);
    const adapter = new SaliencyAugmentedCaptureAdapter({ playwright: { outputDir: directory }, baseAdapter: base });
    const result = await adapter.capture(request(["SCREENSHOT"]));
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.capability).toBe("SCREENSHOT");
  });
});
