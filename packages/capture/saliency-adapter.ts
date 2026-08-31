import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  captureRequestId,
  createCaptureArtifact,
  validateCaptureRequest,
  validateCaptureResult,
  type BrowserDeviceCapturePort,
  type CaptureArtifact,
  type CaptureCapability,
  type CaptureRequest,
  type CaptureResult,
} from "./index.js";
import { PlaywrightBrowserDeviceCaptureAdapter, type PlaywrightCaptureOptions } from "./playwright-adapter.js";
import { predictSaliencyFromNexusScreenshot, validateSaliencyReport } from "./saliency-model.js";

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function saliencyJson(report: Awaited<ReturnType<typeof predictSaliencyFromNexusScreenshot>>): Buffer {
  return Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function innerCapabilities(capabilities: readonly CaptureCapability[]): readonly CaptureCapability[] {
  const values = new Set<CaptureCapability>(capabilities.filter((capability) => capability !== "SALIENCY"));
  values.add("SCREENSHOT");
  return Object.freeze([...values]);
}

function metadataPrefix(artifact: CaptureArtifact): string {
  const browser = artifact.metadata?.browser ?? "browser";
  const viewport = artifact.metadata?.viewport ?? "viewport";
  return `${browser}-${viewport}`.replace(/[^a-zA-Z0-9._-]+/gu, "-");
}

function safeSaliencyPath(uri: string): string {
  const resolved = resolve(uri);
  return `${resolved}.saliency.json`;
}

export interface SaliencyAugmentedCaptureOptions {
  readonly playwright: PlaywrightCaptureOptions;
  readonly baseAdapter?: BrowserDeviceCapturePort;
}

/**
 * Augments the canonical Playwright capture path. Saliency is computed only from
 * SCREENSHOT artifacts emitted by a NEXUS capture adapter and cryptographically
 * rebound to the screenshot bytes before inference.
 */
export class SaliencyAugmentedCaptureAdapter implements BrowserDeviceCapturePort {
  readonly adapterId = "nexus.saliency-augmented-browser-capture";
  readonly adapterVersion = "1.0.0";
  private readonly base: BrowserDeviceCapturePort;

  constructor(options: SaliencyAugmentedCaptureOptions) {
    this.base = options.baseAdapter ?? new PlaywrightBrowserDeviceCaptureAdapter(options.playwright);
  }

  async capture(request: CaptureRequest): Promise<CaptureResult> {
    validateCaptureRequest(request);
    if (!request.capabilities.includes("SALIENCY")) return this.base.capture(request);

    const requestId = captureRequestId(request);
    const baseRequest: CaptureRequest = Object.freeze({
      ...request,
      capabilities: innerCapabilities(request.capabilities),
    });

    try {
      const baseResult = await this.base.capture(baseRequest);
      validateCaptureResult(baseRequest, baseResult);
      if (baseResult.outcome !== "CAPTURED") {
        return Object.freeze({
          requestId,
          outcome: baseResult.outcome,
          artifacts: Object.freeze([]),
          samples: Object.freeze([]),
          reason: baseResult.reason ?? "base capture did not produce screenshot evidence",
        });
      }

      const screenshotArtifacts = baseResult.artifacts.filter((artifact) => artifact.capability === "SCREENSHOT");
      if (screenshotArtifacts.length === 0) {
        return Object.freeze({ requestId, outcome: "FAILED", artifacts: Object.freeze([]), samples: Object.freeze([]), reason: "saliency requires canonical SCREENSHOT artifacts" });
      }

      const saliencyArtifacts: CaptureArtifact[] = [];
      const saliencySamples = [] as { name: string; unit: string; value: number }[];
      for (const artifact of screenshotArtifacts) {
        if (!artifact.uri) throw new Error("screenshot artifact URI is required for saliency analysis");
        if (artifact.mediaType !== "image/png") throw new Error("saliency requires image/png SCREENSHOT artifacts");
        if (artifact.scope.tenantId !== request.scope.tenantId || artifact.scope.brandId !== request.scope.brandId || artifact.runId !== request.run.runId) {
          throw new Error("screenshot artifact scope or run does not match saliency request");
        }
        const bytes = await readFile(resolve(artifact.uri));
        if (bytes.byteLength !== artifact.byteLength) throw new Error("screenshot artifact byte length does not match persisted bytes");
        if (sha256(bytes) !== artifact.digest) throw new Error("screenshot artifact digest does not match persisted bytes");

        const report = await predictSaliencyFromNexusScreenshot(bytes, {
          scope: request.scope,
          subject: `${request.targetId}:${artifact.metadata?.browser ?? "browser"}:${artifact.metadata?.viewport ?? "viewport"}`,
          observedAt: artifact.capturedAt,
        });
        validateSaliencyReport(report);
        if (report.screenshotDigest !== artifact.digest) throw new Error("saliency report screenshot digest is not bound to capture artifact");
        const reportBytes = saliencyJson(report);
        const outputPath = safeSaliencyPath(artifact.uri);
        await writeFile(outputPath, reportBytes);
        saliencyArtifacts.push(createCaptureArtifact({
          runId: request.run.runId,
          scope: request.scope,
          capability: "SALIENCY",
          mediaType: "application/vnd.nexus.saliency-evidence+json",
          digest: sha256(reportBytes),
          byteLength: reportBytes.byteLength,
          capturedAt: artifact.capturedAt,
          uri: outputPath,
          metadata: Object.freeze({
            browser: artifact.metadata?.browser ?? "unknown",
            viewport: artifact.metadata?.viewport ?? "unknown",
            evidenceType: report.evidenceType,
            sourceScreenshotDigest: artifact.digest,
            model: report.model ? `${report.model.name}@${report.model.version}` : "none",
            visualAlgebraTermDigest: report.visualAlgebra?.termDigest ?? "unavailable",
          }),
        }));

        if (report.evidenceType === "MODEL_PREDICTION" && report.summary !== null) {
          const prefix = metadataPrefix(artifact);
          saliencySamples.push(
            { name: `${prefix}.saliency_peak`, unit: "ratio", value: report.summary.peakScore },
            { name: `${prefix}.saliency_center_mass`, unit: "ratio", value: report.summary.centerMass },
            { name: `${prefix}.saliency_entropy`, unit: "ratio", value: report.summary.normalizedEntropy },
            { name: `${prefix}.saliency_regions`, unit: "count", value: report.regions.length },
          );
        }
      }

      const requestedBaseArtifacts = baseResult.artifacts.filter((artifact) => request.capabilities.includes(artifact.capability));
      const result: CaptureResult = Object.freeze({
        requestId,
        outcome: "CAPTURED",
        artifacts: Object.freeze([...requestedBaseArtifacts, ...saliencyArtifacts]),
        samples: Object.freeze([...baseResult.samples, ...saliencySamples]),
      });
      validateCaptureResult(request, result);
      return result;
    } catch (error) {
      return Object.freeze({
        requestId,
        outcome: "FAILED",
        artifacts: Object.freeze([]),
        samples: Object.freeze([]),
        reason: error instanceof Error ? error.message : "saliency-augmented capture failed",
      });
    }
  }
}
