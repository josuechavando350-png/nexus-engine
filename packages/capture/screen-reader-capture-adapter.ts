import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  captureRequestId,
  createCaptureArtifact,
  validateCaptureRequest,
  validateCaptureResult,
  type BrowserDeviceCapturePort,
  type CaptureRequest,
  type CaptureResult,
} from "./index.js";
import {
  JawsScreenReaderAdapter,
  NvdaScreenReaderAdapter,
  VoiceOverScreenReaderAdapter,
  validateScreenReaderEvidence,
  type ScreenReaderAdapterOptions,
  type ScreenReaderEvidence,
  type ScreenReaderKind,
} from "./screen-reader.js";

export interface ScreenReaderCaptureOptions {
  readonly outputDir: string;
  readonly nvda?: ScreenReaderAdapterOptions;
  readonly jaws?: ScreenReaderAdapterOptions;
  readonly voiceOver?: ScreenReaderAdapterOptions;
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function requestedReader(request: CaptureRequest): ScreenReaderKind {
  const raw = request.metadata?.screenReader?.trim().toUpperCase();
  if (raw === "NVDA" || raw === "JAWS" || raw === "VOICEOVER") return raw;
  throw new Error("SCREEN_READER capture requires metadata.screenReader=NVDA|JAWS|VOICEOVER");
}

function evidenceBytes(evidence: ScreenReaderEvidence): Buffer {
  return Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

export class ScreenReaderCaptureAdapter implements BrowserDeviceCapturePort {
  readonly adapterId = "nexus.native-screen-reader-capture";
  readonly adapterVersion = "1.0.0";
  private readonly options: ScreenReaderCaptureOptions;

  constructor(options: ScreenReaderCaptureOptions) {
    if (!options.outputDir.trim()) throw new Error("screen reader capture outputDir is required");
    this.options = options;
  }

  async capture(request: CaptureRequest): Promise<CaptureResult> {
    validateCaptureRequest(request);
    const requestId = captureRequestId(request);
    if (!request.capabilities.includes("SCREEN_READER")) {
      const result: CaptureResult = Object.freeze({
        requestId,
        outcome: "UNSUPPORTED",
        artifacts: Object.freeze([]),
        samples: Object.freeze([]),
        reason: "ScreenReaderCaptureAdapter only handles SCREEN_READER requests",
      });
      validateCaptureResult(request, result);
      return result;
    }

    try {
      const reader = requestedReader(request);
      const adapter = reader === "NVDA"
        ? new NvdaScreenReaderAdapter(this.options.nvda)
        : reader === "JAWS"
          ? new JawsScreenReaderAdapter(this.options.jaws)
          : new VoiceOverScreenReaderAdapter(this.options.voiceOver);
      const evidence = await adapter.observe({ scope: request.scope, targetUrl: request.targetId });
      validateScreenReaderEvidence(evidence);

      if (evidence.status === "UNAVAILABLE") {
        const result: CaptureResult = Object.freeze({
          requestId,
          outcome: "UNSUPPORTED",
          artifacts: Object.freeze([]),
          samples: Object.freeze([]),
          reason: evidence.reason ?? `${reader} native infrastructure is unavailable`,
        });
        validateCaptureResult(request, result);
        return result;
      }
      if (evidence.status !== "OBSERVED") {
        const result: CaptureResult = Object.freeze({
          requestId,
          outcome: "FAILED",
          artifacts: Object.freeze([]),
          samples: Object.freeze([]),
          reason: evidence.status === "SYNTHETIC"
            ? "synthetic screen reader fixtures cannot satisfy a production SCREEN_READER capture"
            : evidence.reason ?? `${reader} evidence is not verified`,
        });
        validateCaptureResult(request, result);
        return result;
      }

      const outputDir = resolve(this.options.outputDir);
      await mkdir(outputDir, { recursive: true });
      const bytes = evidenceBytes(evidence);
      const outputPath = resolve(outputDir, `${requestId}-${reader.toLowerCase()}.screen-reader.json`);
      if (!outputPath.startsWith(`${outputDir}/`) && outputPath !== outputDir) throw new Error("screen reader evidence path escaped outputDir");
      await writeFile(outputPath, bytes, { flag: "wx" });
      const artifact = createCaptureArtifact({
        runId: request.run.runId,
        scope: request.scope,
        capability: "SCREEN_READER",
        mediaType: "application/vnd.nexus.screen-reader-evidence+json",
        digest: digest(bytes),
        byteLength: bytes.byteLength,
        capturedAt: evidence.observedAt,
        uri: outputPath,
        metadata: Object.freeze({
          screenReader: reader,
          readerVersion: evidence.readerVersion ?? "unknown",
          evidenceStatus: evidence.status,
          evidenceDigest: evidence.evidenceDigest,
          harnessDigest: evidence.harness?.executableDigest ?? "unavailable",
        }),
      });
      const result: CaptureResult = Object.freeze({
        requestId,
        outcome: "CAPTURED",
        artifacts: Object.freeze([artifact]),
        samples: Object.freeze([]),
      });
      validateCaptureResult(request, result);
      return result;
    } catch (error) {
      const result: CaptureResult = Object.freeze({
        requestId,
        outcome: "FAILED",
        artifacts: Object.freeze([]),
        samples: Object.freeze([]),
        reason: error instanceof Error ? error.message : "screen reader capture failed",
      });
      validateCaptureResult(request, result);
      return result;
    }
  }
}
