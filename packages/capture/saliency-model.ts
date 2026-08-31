import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  createSaliencyVisualAlgebraTerm,
  projectVisualAlgebraMeasurement,
  type SaliencyVisualRegionInput,
} from "../measurement/visual-algebra.js";
import type { MeasurementScope, MetricSample } from "../measurement/index.js";

export type SaliencyEvidenceType = "MODEL_PREDICTION" | "HUMAN_OBSERVATION" | "UNAVAILABLE";

export interface SaliencyRegion {
  readonly id: string;
  readonly rank: number;
  readonly score: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SaliencyModelDescriptor {
  readonly name: "NEXUS_LOCAL_CONTRAST_CENTER_SURROUND";
  readonly version: "1.0.0";
  readonly interpretation: "PREDICTED_VISUAL_SALIENCY_NOT_EYE_TRACKING";
  readonly analysisWidth: number;
  readonly analysisHeight: number;
}

export interface SaliencySummary {
  readonly peakScore: number;
  readonly centerMass: number;
  readonly normalizedEntropy: number;
}

export interface SaliencyVisualAlgebraProjection {
  readonly termDigest: string;
  readonly samples: readonly MetricSample[];
  readonly constraintsPassed: boolean;
}

export interface SaliencyReport {
  readonly authority: "NEXUS_SALIENCY_EVIDENCE_V1";
  readonly scope: MeasurementScope;
  readonly subject: string;
  readonly evidenceType: SaliencyEvidenceType;
  readonly observedAt: string;
  readonly screenshotDigest: string | null;
  readonly screenshotBytes: number | null;
  readonly sourceDimensions: Readonly<{ width: number; height: number }> | null;
  readonly model: SaliencyModelDescriptor | null;
  readonly regions: readonly SaliencyRegion[];
  readonly summary: SaliencySummary | null;
  readonly visualAlgebra: SaliencyVisualAlgebraProjection | null;
  readonly provenance: Readonly<{
    source: "NEXUS_SCREENSHOT_BYTES" | "HUMAN_STUDY" | "UNAVAILABLE";
    observerIdDigest?: string;
    protocolId?: string;
  }>;
  readonly reason?: string;
  readonly reportDigest: string;
}

export interface SaliencyPredictionOptions {
  readonly scope: MeasurementScope;
  readonly subject: string;
  readonly observedAt?: string;
  readonly signal?: AbortSignal;
  readonly maxInputBytes?: number;
  readonly maxRegions?: number;
  readonly analysisMaxDimension?: number;
}

export interface HumanSaliencyObservationInput {
  readonly scope: MeasurementScope;
  readonly subject: string;
  readonly observedAt: string;
  readonly screenshotDigest: string;
  readonly screenshotBytes: number;
  readonly sourceDimensions: Readonly<{ width: number; height: number }>;
  readonly regions: readonly SaliencyRegion[];
  readonly observerId: string;
  readonly protocolId: string;
}

const DEFAULT_MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const DEFAULT_MAX_REGIONS = 8;
const MAX_REGIONS = 32;
const DEFAULT_ANALYSIS_MAX_DIMENSION = 96;
const MAX_ANALYSIS_DIMENSION = 192;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const PNG_SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function canonicalize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("saliency canonical JSON rejects non-finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen));
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (seen.has(object)) throw new Error("saliency canonical JSON rejects cyclic objects");
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("saliency canonical JSON requires plain objects");
    seen.add(object);
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(object).sort()) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") throw new Error(`unsafe saliency object key ${key}`);
      const item = object[key];
      if (item === undefined) throw new Error(`saliency canonical JSON rejects undefined at ${key}`);
      output[key] = canonicalize(item, seen);
    }
    seen.delete(object);
    return output;
  }
  throw new Error(`saliency canonical JSON rejects ${typeof value}`);
}

export function saliencyCanonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function saliencyDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(saliencyCanonicalJson(value)).digest("hex")}`;
}

function bytesDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function safeText(value: string, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw new Error(`${field} must be between 1 and ${max} characters`);
  for (const character of trimmed) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) throw new Error(`${field} contains control characters`);
  }
  return trimmed;
}

function canonicalTimestamp(value: string): string {
  const safe = safeText(value, "observedAt", 64);
  const parsed = new Date(safe);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== safe) throw new Error("observedAt must be canonical ISO-8601 UTC");
  return safe;
}

function safeScope(scope: MeasurementScope): MeasurementScope {
  return Object.freeze({
    tenantId: safeText(scope.tenantId, "scope.tenantId", 128),
    brandId: safeText(scope.brandId, "scope.brandId", 128),
  });
}

function boundedInteger(value: number | undefined, fallback: number, field: string, min: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) throw new Error(`${field} must be an integer from ${min} to ${max}`);
  return resolved;
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("saliency prediction cancelled");
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.byteLength >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

function reportCore(input: Omit<SaliencyReport, "reportDigest">): SaliencyReport {
  const frozen = Object.freeze({ ...input });
  return Object.freeze({ ...frozen, reportDigest: saliencyDigest(frozen) });
}

function unavailableReport(
  scope: MeasurementScope,
  subject: string,
  observedAt: string,
  reason: string,
  screenshotDigest: string | null = null,
  screenshotBytes: number | null = null,
): SaliencyReport {
  return reportCore({
    authority: "NEXUS_SALIENCY_EVIDENCE_V1",
    scope,
    subject,
    evidenceType: "UNAVAILABLE",
    observedAt,
    screenshotDigest,
    screenshotBytes,
    sourceDimensions: null,
    model: null,
    regions: Object.freeze([]),
    summary: null,
    visualAlgebra: null,
    provenance: Object.freeze({ source: "UNAVAILABLE" }),
    reason: safeText(reason, "reason", 1_024),
  });
}

function normalized(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function localSaliency(gray: Uint8Array, width: number, height: number, signal: AbortSignal | undefined): Float64Array {
  const values = new Float64Array(width * height);
  for (let y = 0; y < height; y += 1) {
    if ((y & 7) === 0) checkAbort(signal);
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const current = gray[index]!;
      let sum = 0;
      let count = 0;
      for (let dy = -2; dy <= 2; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -2; dx <= 2; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          sum += gray[ny * width + nx]!;
          count += 1;
        }
      }
      const mean = count === 0 ? current : sum / count;
      const contrast = Math.abs(current - mean) / 255;
      const horizontal = x + 1 < width ? Math.abs(current - gray[index + 1]!) / 255 : 0;
      const vertical = y + 1 < height ? Math.abs(current - gray[index + width]!) / 255 : 0;
      const gradient = (horizontal + vertical) / 2;
      const nx = width <= 1 ? 0 : (x / (width - 1)) * 2 - 1;
      const ny = height <= 1 ? 0 : (y / (height - 1)) * 2 - 1;
      const center = 1 - Math.min(1, Math.sqrt(nx * nx + ny * ny) / Math.SQRT2);
      const base = 0.72 * contrast + 0.28 * gradient;
      values[index] = base * (0.92 + 0.08 * center);
    }
  }
  return values;
}

interface GridCell {
  readonly gx: number;
  readonly gy: number;
  readonly score: number;
}

function aggregateGrid(values: Float64Array, width: number, height: number): readonly GridCell[] {
  let peak = 0;
  for (const value of values) peak = Math.max(peak, value);
  const divisor = peak > 1e-12 ? peak : 1;
  const gridX = Math.min(8, width);
  const gridY = Math.min(8, height);
  const cells: GridCell[] = [];
  for (let gy = 0; gy < gridY; gy += 1) {
    const y0 = Math.floor((gy * height) / gridY);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / gridY));
    for (let gx = 0; gx < gridX; gx += 1) {
      const x0 = Math.floor((gx * width) / gridX);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / gridX));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < Math.min(y1, height); y += 1) {
        for (let x = x0; x < Math.min(x1, width); x += 1) {
          sum += values[y * width + x]! / divisor;
          count += 1;
        }
      }
      cells.push(Object.freeze({ gx, gy, score: normalized(count === 0 ? 0 : sum / count) }));
    }
  }
  return Object.freeze(cells);
}

function mapRegions(
  cells: readonly GridCell[],
  sourceWidth: number,
  sourceHeight: number,
  analysisWidth: number,
  analysisHeight: number,
  maxRegions: number,
): readonly SaliencyRegion[] {
  const gridX = Math.min(8, analysisWidth);
  const gridY = Math.min(8, analysisHeight);
  const sorted = [...cells].sort((left, right) => right.score - left.score || left.gy - right.gy || left.gx - right.gx).slice(0, maxRegions);
  return Object.freeze(sorted.map((cell, index) => {
    const x0 = Math.floor((cell.gx * sourceWidth) / gridX);
    const x1 = Math.max(x0 + 1, Math.ceil(((cell.gx + 1) * sourceWidth) / gridX));
    const y0 = Math.floor((cell.gy * sourceHeight) / gridY);
    const y1 = Math.max(y0 + 1, Math.ceil(((cell.gy + 1) * sourceHeight) / gridY));
    return Object.freeze({
      id: `saliency-${String(index + 1).padStart(2, "0")}`,
      rank: index + 1,
      score: cell.score,
      x: x0,
      y: y0,
      width: Math.min(sourceWidth, x1) - x0,
      height: Math.min(sourceHeight, y1) - y0,
    });
  }));
}

function summaryFromCells(cells: readonly GridCell[], analysisWidth: number, analysisHeight: number): SaliencySummary {
  const gridX = Math.min(8, analysisWidth);
  const gridY = Math.min(8, analysisHeight);
  const total = cells.reduce((sum, cell) => sum + cell.score, 0);
  const center = cells.reduce((sum, cell) => {
    const centerX = (cell.gx + 0.5) / gridX;
    const centerY = (cell.gy + 0.5) / gridY;
    return centerX >= 0.25 && centerX <= 0.75 && centerY >= 0.25 && centerY <= 0.75 ? sum + cell.score : sum;
  }, 0);
  let entropy = 0;
  if (total > 1e-12 && cells.length > 1) {
    for (const cell of cells) {
      const probability = cell.score / total;
      if (probability > 0) entropy -= probability * Math.log(probability);
    }
    entropy /= Math.log(cells.length);
  }
  return Object.freeze({
    peakScore: cells.reduce((peak, cell) => Math.max(peak, cell.score), 0),
    centerMass: normalized(total > 1e-12 ? center / total : 0),
    normalizedEntropy: normalized(entropy),
  });
}

function visualProjection(subject: string, width: number, height: number, regions: readonly SaliencyRegion[], evidenceType: "MODEL_PREDICTION" | "HUMAN_OBSERVATION"): SaliencyVisualAlgebraProjection {
  const inputs: readonly SaliencyVisualRegionInput[] = regions.map((region) => Object.freeze({ ...region }));
  const term = createSaliencyVisualAlgebraTerm({
    subject,
    evidenceType,
    canvasWidth: width,
    canvasHeight: height,
    regions: inputs,
  });
  const projection = projectVisualAlgebraMeasurement(term);
  return Object.freeze({
    termDigest: term.digest,
    samples: projection.samples,
    constraintsPassed: projection.constraintsPassed,
  });
}

export async function predictSaliencyFromNexusScreenshot(screenshot: Uint8Array, options: SaliencyPredictionOptions): Promise<SaliencyReport> {
  const scope = safeScope(options.scope);
  const subject = safeText(options.subject, "subject", 256);
  const observedAt = canonicalTimestamp(options.observedAt ?? new Date().toISOString());
  const maxInputBytes = boundedInteger(options.maxInputBytes, DEFAULT_MAX_INPUT_BYTES, "maxInputBytes", 1_024, MAX_INPUT_BYTES);
  const maxRegions = boundedInteger(options.maxRegions, DEFAULT_MAX_REGIONS, "maxRegions", 1, MAX_REGIONS);
  const analysisMaxDimension = boundedInteger(options.analysisMaxDimension, DEFAULT_ANALYSIS_MAX_DIMENSION, "analysisMaxDimension", 16, MAX_ANALYSIS_DIMENSION);
  checkAbort(options.signal);

  if (!(screenshot instanceof Uint8Array)) throw new Error("screenshot must be Uint8Array bytes");
  if (screenshot.byteLength === 0) return unavailableReport(scope, subject, observedAt, "screenshot input is empty");
  if (screenshot.byteLength > maxInputBytes) return unavailableReport(scope, subject, observedAt, `screenshot exceeds ${maxInputBytes} bytes`);
  const screenshotDigest = bytesDigest(screenshot);
  if (!isPng(screenshot)) return unavailableReport(scope, subject, observedAt, "saliency model accepts NEXUS PNG screenshots only", screenshotDigest, screenshot.byteLength);

  try {
    const image = sharp(screenshot, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" });
    const metadata = await image.metadata();
    checkAbort(options.signal);
    if (metadata.format !== "png" || !metadata.width || !metadata.height) {
      return unavailableReport(scope, subject, observedAt, "PNG screenshot dimensions are unavailable", screenshotDigest, screenshot.byteLength);
    }
    const width = metadata.width;
    const height = metadata.height;
    if (width * height > MAX_INPUT_PIXELS) return unavailableReport(scope, subject, observedAt, `screenshot exceeds ${MAX_INPUT_PIXELS} pixels`, screenshotDigest, screenshot.byteLength);

    const scale = Math.min(1, analysisMaxDimension / Math.max(width, height));
    const analysisWidth = Math.max(1, Math.round(width * scale));
    const analysisHeight = Math.max(1, Math.round(height * scale));
    const decoded = await sharp(screenshot, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
      .greyscale()
      .resize({ width: analysisWidth, height: analysisHeight, fit: "fill", kernel: sharp.kernel.lanczos3 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    checkAbort(options.signal);
    if (decoded.info.channels !== 1 || decoded.data.byteLength !== analysisWidth * analysisHeight) {
      return unavailableReport(scope, subject, observedAt, "decoded saliency analysis buffer has unexpected dimensions", screenshotDigest, screenshot.byteLength);
    }

    const local = localSaliency(decoded.data, analysisWidth, analysisHeight, options.signal);
    const cells = aggregateGrid(local, analysisWidth, analysisHeight);
    const regions = mapRegions(cells, width, height, analysisWidth, analysisHeight, maxRegions);
    if (regions.length === 0) return unavailableReport(scope, subject, observedAt, "saliency model produced no bounded regions", screenshotDigest, screenshot.byteLength);
    const summary = summaryFromCells(cells, analysisWidth, analysisHeight);
    const visualAlgebra = visualProjection(subject, width, height, regions, "MODEL_PREDICTION");
    return reportCore({
      authority: "NEXUS_SALIENCY_EVIDENCE_V1",
      scope,
      subject,
      evidenceType: "MODEL_PREDICTION",
      observedAt,
      screenshotDigest,
      screenshotBytes: screenshot.byteLength,
      sourceDimensions: Object.freeze({ width, height }),
      model: Object.freeze({
        name: "NEXUS_LOCAL_CONTRAST_CENTER_SURROUND",
        version: "1.0.0",
        interpretation: "PREDICTED_VISUAL_SALIENCY_NOT_EYE_TRACKING",
        analysisWidth,
        analysisHeight,
      }),
      regions,
      summary,
      visualAlgebra,
      provenance: Object.freeze({ source: "NEXUS_SCREENSHOT_BYTES" }),
    });
  } catch (error) {
    return unavailableReport(
      scope,
      subject,
      observedAt,
      error instanceof Error ? error.message : "saliency model could not process screenshot",
      screenshotDigest,
      screenshot.byteLength,
    );
  }
}

function validateRegion(region: SaliencyRegion, width: number, height: number, expectedRank: number): SaliencyRegion {
  if (region.id !== `saliency-${String(expectedRank).padStart(2, "0")}` && !region.id.trim()) throw new Error("human saliency region id is required");
  if (region.rank !== expectedRank) throw new Error("human saliency regions must use contiguous rank order");
  if (!Number.isFinite(region.score) || region.score < 0 || region.score > 1) throw new Error("human saliency region score must be in [0,1]");
  for (const [field, value] of Object.entries({ x: region.x, y: region.y, width: region.width, height: region.height })) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`human saliency region ${field} must be finite and non-negative`);
  }
  if (region.width <= 0 || region.height <= 0 || region.x + region.width > width || region.y + region.height > height) throw new Error("human saliency region must fit within screenshot bounds");
  return Object.freeze({ ...region });
}

export function createHumanSaliencyObservation(input: HumanSaliencyObservationInput): SaliencyReport {
  const scope = safeScope(input.scope);
  const subject = safeText(input.subject, "subject", 256);
  const observedAt = canonicalTimestamp(input.observedAt);
  if (!SHA256.test(input.screenshotDigest)) throw new Error("human saliency observation requires a sha256 screenshot digest");
  const screenshotBytes = boundedInteger(input.screenshotBytes, input.screenshotBytes, "screenshotBytes", 1, MAX_INPUT_BYTES);
  const width = boundedInteger(input.sourceDimensions.width, input.sourceDimensions.width, "sourceDimensions.width", 1, 100_000);
  const height = boundedInteger(input.sourceDimensions.height, input.sourceDimensions.height, "sourceDimensions.height", 1, 100_000);
  const observerId = safeText(input.observerId, "observerId", 256);
  const protocolId = safeText(input.protocolId, "protocolId", 256);
  if (input.regions.length === 0 || input.regions.length > MAX_REGIONS) throw new Error(`human saliency observation requires 1 to ${MAX_REGIONS} regions`);
  const regions = Object.freeze(input.regions.map((region, index) => validateRegion(region, width, height, index + 1)));
  const visualAlgebra = visualProjection(subject, width, height, regions, "HUMAN_OBSERVATION");
  const peakScore = regions.reduce((peak, region) => Math.max(peak, region.score), 0);
  return reportCore({
    authority: "NEXUS_SALIENCY_EVIDENCE_V1",
    scope,
    subject,
    evidenceType: "HUMAN_OBSERVATION",
    observedAt,
    screenshotDigest: input.screenshotDigest,
    screenshotBytes,
    sourceDimensions: Object.freeze({ width, height }),
    model: null,
    regions,
    summary: Object.freeze({ peakScore, centerMass: 0, normalizedEntropy: 0 }),
    visualAlgebra,
    provenance: Object.freeze({
      source: "HUMAN_STUDY",
      observerIdDigest: saliencyDigest(observerId),
      protocolId,
    }),
  });
}

export function validateSaliencyReport(report: SaliencyReport): void {
  if (report.authority !== "NEXUS_SALIENCY_EVIDENCE_V1") throw new Error("unsupported saliency evidence authority");
  safeScope(report.scope);
  safeText(report.subject, "subject", 256);
  canonicalTimestamp(report.observedAt);
  const { reportDigest, ...core } = report;
  if (saliencyDigest(core) !== reportDigest) throw new Error("saliency evidence replay digest mismatch");

  if (report.evidenceType === "UNAVAILABLE") {
    if (!report.reason?.trim()) throw new Error("UNAVAILABLE saliency evidence requires a reason");
    if (report.model !== null || report.regions.length !== 0 || report.summary !== null || report.visualAlgebra !== null || report.provenance.source !== "UNAVAILABLE") {
      throw new Error("UNAVAILABLE saliency evidence cannot contain prediction or observation results");
    }
    return;
  }

  if (!report.screenshotDigest || !SHA256.test(report.screenshotDigest) || report.screenshotBytes === null || report.sourceDimensions === null) {
    throw new Error(`${report.evidenceType} requires screenshot provenance`);
  }
  if (report.regions.length === 0 || report.summary === null || report.visualAlgebra === null) throw new Error(`${report.evidenceType} requires regions and Visual Algebra projection`);
  if (report.evidenceType === "MODEL_PREDICTION") {
    if (report.model === null || report.model.interpretation !== "PREDICTED_VISUAL_SALIENCY_NOT_EYE_TRACKING" || report.provenance.source !== "NEXUS_SCREENSHOT_BYTES") {
      throw new Error("MODEL_PREDICTION must remain explicitly model-derived and not eye-tracking evidence");
    }
  } else if (report.model !== null || report.provenance.source !== "HUMAN_STUDY" || !report.provenance.observerIdDigest || !report.provenance.protocolId) {
    throw new Error("HUMAN_OBSERVATION requires explicit human-study provenance and cannot contain a model descriptor");
  }
}
