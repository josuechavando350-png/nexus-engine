import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { promisify } from "node:util";
import pixelmatch from "pixelmatch";
import sharp from "sharp";
import { chromium, webkit, type Locator, type Page } from "playwright";
import { parseSsimulacra2 } from "@nexus/perceptual-images";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const playwrightPackage = require("playwright/package.json") as { version?: unknown };
const PLAYWRIGHT_VERSION = typeof playwrightPackage.version === "string" ? playwrightPackage.version : "UNKNOWN";

const MAX_SCENE_ID = 160;
const MAX_URL = 4_096;
const MAX_SELECTOR = 1_000;
const MAX_REASON = 2_000;
const MAX_APPROVAL_REFERENCE = 1_000;
const MAX_MASKS = 16;
const MAX_MASK_MATCHES = 256;
const MAX_NAVIGATION_TIMEOUT_MS = 60_000;
const MAX_PERCEPTUAL_TIMEOUT_MS = 120_000;
const MAX_STDIO = 1_000_000;
const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const BROAD_MASKS = new Set(["*", "body", "html", "main", ":root"]);

export const NON_CLAIM = "VISUAL_REGRESSION_EXECUTION_NOT_AUTOMATIC_ART_DIRECTION_APPROVAL" as const;

export type BrowserName = "chromium" | "webkit";
export type VisualVerdict = "PASS" | "FAIL" | "INCOMPATIBLE_BASELINE";

export interface MaskSpec {
  selector: string;
  reason: string;
  approvalReference: string;
}

export interface VisualPolicy {
  pixelThreshold: number;
  maximumChangedPixelRatio: number;
  minimumPerceptual: number;
  maximumMaskAreaRatio: number;
  maximumMaskAreaDriftRatio: number;
}

export interface SceneInput {
  id: string;
  url: string;
  fullPage?: boolean;
  masks?: readonly MaskSpec[];
  policy?: Partial<VisualPolicy>;
}

export interface Scene {
  id: string;
  url: string;
  fullPage: boolean;
  masks: readonly MaskSpec[];
  policy: VisualPolicy;
  digest: string;
}

export interface Viewport {
  name: string;
  width: number;
  height: number;
}

export interface MaskObservation {
  selector: string;
  count: number;
  areaRatio: number;
}

export interface RenderingEnvironment {
  browserName: BrowserName;
  browserVersion: string;
  playwrightVersion: string;
  platform: string;
  arch: string;
  timezoneId: "UTC";
  locale: "en-US";
  reducedMotion: "reduce";
  colorScheme: "light";
  deviceScaleFactor: 1;
  screenshotScale: "css";
  animations: "disabled";
  caret: "hide";
  digest: string;
}

export interface CaptureRecord {
  sceneDigest: string;
  revision: string;
  buildDigest: string;
  environment: RenderingEnvironment;
  viewport: Viewport;
  width: number;
  height: number;
  screenshotSha256: string;
  masks: readonly MaskObservation[];
  digest: string;
}

export interface CaptureArtifact {
  record: CaptureRecord;
  path: string;
}

export interface ApprovedBaseline {
  sceneDigest: string;
  buildDigest: string;
  environment: RenderingEnvironment;
  viewport: Viewport;
  width: number;
  height: number;
  screenshotSha256: string;
  masks: readonly MaskObservation[];
  captureDigest: string;
  approvalReference: string;
  nonClaim: typeof NON_CLAIM;
  digest: string;
}

export interface ComparisonReport {
  verdict: VisualVerdict;
  reasons: readonly string[];
  baselineDigest: string;
  captureDigest: string;
  changedPixels: number | null;
  ratio: number | null;
  perceptual: number | null;
  diffSha256?: string;
  diffPath?: string;
  nonClaim: typeof NON_CLAIM;
  digest: string;
}

export type PerceptualComparator = (baselinePath: string, currentPath: string) => Promise<number>;
export type CommandRunner = (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;

type JsonRecord = Record<string, unknown>;

const DEFAULT_POLICY: VisualPolicy = {
  pixelThreshold: 0.1,
  maximumChangedPixelRatio: 0.001,
  minimumPerceptual: 98,
  maximumMaskAreaRatio: 0.05,
  maximumMaskAreaDriftRatio: 0.005,
};

function asRecord(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
  return value as JsonRecord;
}

function canonicalize(value: unknown, seen = new WeakSet<object>(), path = "$" ): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`non-finite number at ${path}`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error(`cyclic value at ${path}`);
    seen.add(value);
    const output = value.map((item, index) => canonicalize(item, seen, `${path}[${index}]`));
    seen.delete(value);
    return output;
  }
  if (typeof value === "object") {
    const record = asRecord(value, path);
    if (seen.has(value)) throw new Error(`cyclic value at ${path}`);
    seen.add(value);
    const output: JsonRecord = Object.create(null);
    for (const key of Object.keys(record).sort()) {
      if (RESERVED_KEYS.has(key)) throw new Error(`reserved key ${key} at ${path}`);
      const item = record[key];
      if (item === undefined) throw new Error(`undefined at ${path}.${key}`);
      output[key] = canonicalize(item, seen, `${path}.${key}`);
    }
    seen.delete(value);
    return output;
  }
  throw new Error(`unsupported canonical value ${typeof value} at ${path}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  return sha256Bytes(await readFile(path));
}

function cleanString(label: string, value: unknown, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  if (normalized.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return normalized;
}

function sha256Hex(label: string, value: unknown): string {
  const text = cleanString(label, value, 64);
  if (!/^[a-f0-9]{64}$/u.test(text)) throw new Error(`${label} must be lowercase sha256 hex`);
  return text;
}

function safeUrl(value: unknown): string {
  const raw = cleanString("scene.url", value, MAX_URL);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("scene.url must be a valid HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scene.url must use HTTP(S)");
  if (parsed.username || parsed.password) throw new Error("scene.url must not contain credentials");
  parsed.hash = "";
  return parsed.toString();
}

function finiteRange(label: string, value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be finite and in [${minimum}, ${maximum}]`);
  }
  return value;
}

function positiveInteger(label: string, value: unknown, maximum = 100_000): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} must be an integer in [1, ${maximum}]`);
  }
  return value;
}

function normalizePolicy(input: Partial<VisualPolicy> | undefined): VisualPolicy {
  const policy = { ...DEFAULT_POLICY, ...(input ?? {}) };
  return {
    pixelThreshold: finiteRange("policy.pixelThreshold", policy.pixelThreshold, 0, 1),
    maximumChangedPixelRatio: finiteRange("policy.maximumChangedPixelRatio", policy.maximumChangedPixelRatio, 0, 1),
    minimumPerceptual: finiteRange("policy.minimumPerceptual", policy.minimumPerceptual, 0, 100),
    maximumMaskAreaRatio: finiteRange("policy.maximumMaskAreaRatio", policy.maximumMaskAreaRatio, 0, 0.25),
    maximumMaskAreaDriftRatio: finiteRange("policy.maximumMaskAreaDriftRatio", policy.maximumMaskAreaDriftRatio, 0, 0.25),
  };
}

function normalizeMask(input: MaskSpec): MaskSpec {
  const selector = cleanString("mask.selector", input.selector, MAX_SELECTOR);
  const normalizedSelector = selector.toLocaleLowerCase("en-US").replace(/\s+/gu, " ");
  if (BROAD_MASKS.has(normalizedSelector) || normalizedSelector.includes("*")) throw new Error(`broad mask selector rejected: ${selector}`);
  return {
    selector,
    reason: cleanString("mask.reason", input.reason, MAX_REASON),
    approvalReference: cleanString("mask.approvalReference", input.approvalReference, MAX_APPROVAL_REFERENCE),
  };
}

export function createScene(input: SceneInput): Scene {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("scene input must be an object");
  const masks = (input.masks ?? []).map(normalizeMask).sort((left, right) => left.selector.localeCompare(right.selector, "en"));
  if (masks.length > MAX_MASKS) throw new Error(`scene exceeds ${MAX_MASKS} masks`);
  if (new Set(masks.map((mask) => mask.selector)).size !== masks.length) throw new Error("scene contains duplicate mask selectors");
  const core = {
    id: cleanString("scene.id", input.id, MAX_SCENE_ID),
    url: safeUrl(input.url),
    fullPage: input.fullPage ?? true,
    masks,
    policy: normalizePolicy(input.policy),
  };
  if (typeof core.fullPage !== "boolean") throw new Error("scene.fullPage must be boolean");
  return { ...core, digest: digest(core) };
}

export function createViewport(name: string, width: number, height: number): Viewport {
  return {
    name: cleanString("viewport.name", name, 100),
    width: positiveInteger("viewport.width", width, 10_000),
    height: positiveInteger("viewport.height", height, 10_000),
  };
}

function renderingEnvironment(browserName: BrowserName, browserVersion: string): RenderingEnvironment {
  const core = {
    browserName,
    browserVersion: cleanString("browserVersion", browserVersion, 200),
    playwrightVersion: PLAYWRIGHT_VERSION,
    platform: process.platform,
    arch: process.arch,
    timezoneId: "UTC" as const,
    locale: "en-US" as const,
    reducedMotion: "reduce" as const,
    colorScheme: "light" as const,
    deviceScaleFactor: 1 as const,
    screenshotScale: "css" as const,
    animations: "disabled" as const,
    caret: "hide" as const,
  };
  return { ...core, digest: digest(core) };
}

function validateEnvironment(environment: RenderingEnvironment): void {
  const { digest: environmentDigest, ...core } = environment;
  sha256Hex("environment.digest", environmentDigest);
  if (digest(core) !== environmentDigest) throw new Error("rendering environment digest mismatch");
}

function captureCore(record: CaptureRecord): Omit<CaptureRecord, "digest"> {
  return {
    sceneDigest: record.sceneDigest,
    revision: record.revision,
    buildDigest: record.buildDigest,
    environment: record.environment,
    viewport: record.viewport,
    width: record.width,
    height: record.height,
    screenshotSha256: record.screenshotSha256,
    masks: record.masks,
  };
}

export function validateCaptureRecord(record: CaptureRecord): void {
  sha256Hex("capture.digest", record.digest);
  sha256Hex("capture.sceneDigest", record.sceneDigest);
  sha256Hex("capture.buildDigest", record.buildDigest);
  sha256Hex("capture.screenshotSha256", record.screenshotSha256);
  validateEnvironment(record.environment);
  createViewport(record.viewport.name, record.viewport.width, record.viewport.height);
  positiveInteger("capture.width", record.width, 100_000);
  positiveInteger("capture.height", record.height, 100_000);
  cleanString("capture.revision", record.revision, 500);
  for (const mask of record.masks) {
    cleanString("capture.mask.selector", mask.selector, MAX_SELECTOR);
    positiveInteger("capture.mask.count", mask.count, MAX_MASK_MATCHES);
    finiteRange("capture.mask.areaRatio", mask.areaRatio, 0, 1);
  }
  if (digest(captureCore(record)) !== record.digest) throw new Error("capture record digest mismatch");
}

async function settle(page: Page): Promise<void> {
  await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}html{scroll-behavior:auto!important}" });
  await page.evaluate(async () => {
    if (document.fonts) await document.fonts.ready;
    await Promise.all([...document.images].map(async (image) => {
      if (typeof image.decode === "function") await image.decode().catch(() => undefined);
    }));
    await new Promise<void>((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())));
  });
}

export async function captureScene(input: {
  scene: Scene;
  browserName: BrowserName;
  viewport: Viewport;
  revision: string;
  buildDigest: string;
  outDir: string;
  navigationTimeoutMs?: number;
}): Promise<CaptureArtifact> {
  const revision = cleanString("revision", input.revision, 500);
  const buildDigest = sha256Hex("buildDigest", input.buildDigest);
  const viewport = createViewport(input.viewport.name, input.viewport.width, input.viewport.height);
  const timeout = positiveInteger("navigationTimeoutMs", input.navigationTimeoutMs ?? 30_000, MAX_NAVIGATION_TIMEOUT_MS);
  const browserType = input.browserName === "chromium" ? chromium : input.browserName === "webkit" ? webkit : null;
  if (!browserType) throw new Error("unsupported browserName");
  const browser = await browserType.launch({ headless: true });
  try {
    const environment = renderingEnvironment(input.browserName, browser.version());
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1,
      timezoneId: "UTC",
      locale: "en-US",
      reducedMotion: "reduce",
      colorScheme: "light",
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(timeout);
      await page.goto(input.scene.url, { waitUntil: "load", timeout });
      await settle(page);

      const dimensions = await page.evaluate(() => ({
        width: Math.max(document.documentElement.scrollWidth, innerWidth),
        height: Math.max(document.documentElement.scrollHeight, innerHeight),
      }));
      positiveInteger("capture document width", dimensions.width, 100_000);
      positiveInteger("capture document height", dimensions.height, 100_000);
      const totalArea = dimensions.width * dimensions.height;
      if (!Number.isSafeInteger(totalArea) || totalArea <= 0) throw new Error("capture document area is invalid");

      const locators: Locator[] = [];
      const observations: MaskObservation[] = [];
      let maskedArea = 0;
      for (const mask of input.scene.masks) {
        const locator = page.locator(mask.selector);
        const count = await locator.count();
        if (count <= 0) throw new Error(`mask missing: ${mask.selector}`);
        if (count > MAX_MASK_MATCHES) throw new Error(`mask exceeds ${MAX_MASK_MATCHES} matches: ${mask.selector}`);
        const boxes = await locator.evaluateAll((elements) => elements.map((element) => {
          const rect = element.getBoundingClientRect();
          return { width: Math.max(0, rect.width), height: Math.max(0, rect.height) };
        }));
        const area = boxes.reduce((sum, box) => sum + box.width * box.height, 0);
        maskedArea += area;
        observations.push({ selector: mask.selector, count, areaRatio: Math.round((area / totalArea) * 1e12) / 1e12 });
        locators.push(locator);
      }
      const maskAreaRatio = maskedArea / totalArea;
      if (maskAreaRatio > input.scene.policy.maximumMaskAreaRatio) {
        throw new Error(`mask area ratio ${maskAreaRatio} exceeds ${input.scene.policy.maximumMaskAreaRatio}`);
      }

      const png = await page.screenshot({
        type: "png",
        fullPage: input.scene.fullPage,
        animations: "disabled",
        caret: "hide",
        scale: "css",
        mask: locators,
        maskColor: "#FF00FF",
      });
      await mkdir(input.outDir, { recursive: true });
      const path = resolve(input.outDir, `${input.scene.id}.${input.browserName}.${viewport.name}.png`);
      await writeFile(path, png);
      const core = {
        sceneDigest: input.scene.digest,
        revision,
        buildDigest,
        environment,
        viewport,
        width: dimensions.width,
        height: dimensions.height,
        screenshotSha256: sha256Bytes(png),
        masks: observations.sort((left, right) => left.selector.localeCompare(right.selector, "en")),
      };
      return { record: { ...core, digest: digest(core) }, path };
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

export function approveBaseline(record: CaptureRecord, approvalReference: string): ApprovedBaseline {
  validateCaptureRecord(record);
  const core = {
    sceneDigest: record.sceneDigest,
    buildDigest: record.buildDigest,
    environment: record.environment,
    viewport: record.viewport,
    width: record.width,
    height: record.height,
    screenshotSha256: record.screenshotSha256,
    masks: record.masks,
    captureDigest: record.digest,
    approvalReference: cleanString("approvalReference", approvalReference, MAX_APPROVAL_REFERENCE),
    nonClaim: NON_CLAIM,
  };
  return { ...core, digest: digest(core) };
}

export function validateBaseline(baseline: ApprovedBaseline): void {
  sha256Hex("baseline.digest", baseline.digest);
  sha256Hex("baseline.sceneDigest", baseline.sceneDigest);
  sha256Hex("baseline.buildDigest", baseline.buildDigest);
  sha256Hex("baseline.screenshotSha256", baseline.screenshotSha256);
  sha256Hex("baseline.captureDigest", baseline.captureDigest);
  cleanString("baseline.approvalReference", baseline.approvalReference, MAX_APPROVAL_REFERENCE);
  if (baseline.nonClaim !== NON_CLAIM) throw new Error("baseline non-claim marker mismatch");
  validateEnvironment(baseline.environment);
  createViewport(baseline.viewport.name, baseline.viewport.width, baseline.viewport.height);
  positiveInteger("baseline.width", baseline.width, 100_000);
  positiveInteger("baseline.height", baseline.height, 100_000);
  for (const mask of baseline.masks) {
    cleanString("baseline.mask.selector", mask.selector, MAX_SELECTOR);
    positiveInteger("baseline.mask.count", mask.count, MAX_MASK_MATCHES);
    finiteRange("baseline.mask.areaRatio", mask.areaRatio, 0, 1);
  }
  const core = Object.fromEntries(Object.entries(baseline).filter(([key]) => key !== "digest"));
  if (digest(core) !== baseline.digest) throw new Error("baseline digest mismatch");
}

function viewportEquals(left: Viewport, right: Viewport): boolean {
  return left.name === right.name && left.width === right.width && left.height === right.height;
}

function environmentEquals(left: RenderingEnvironment, right: RenderingEnvironment): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function maskDriftReasons(baseline: ApprovedBaseline, current: CaptureRecord, policy: VisualPolicy): string[] {
  const reasons: string[] = [];
  const baselineBySelector = new Map(baseline.masks.map((mask) => [mask.selector, mask] as const));
  const currentBySelector = new Map(current.masks.map((mask) => [mask.selector, mask] as const));
  if (baselineBySelector.size !== currentBySelector.size) reasons.push("MASK_SET_DRIFT");
  for (const [selector, expected] of baselineBySelector) {
    const observed = currentBySelector.get(selector);
    if (!observed || observed.count !== expected.count) {
      reasons.push("MASK_MATCH_COUNT_DRIFT");
      continue;
    }
    if (Math.abs(observed.areaRatio - expected.areaRatio) > policy.maximumMaskAreaDriftRatio) reasons.push("MASK_AREA_DRIFT");
  }
  return [...new Set(reasons)].sort();
}

function reportCore(input: Omit<ComparisonReport, "digest" | "diffPath">): Omit<ComparisonReport, "digest" | "diffPath"> {
  return input;
}

export async function compareCapture(input: {
  baseline: ApprovedBaseline;
  baselinePath: string;
  current: CaptureArtifact;
  policy: VisualPolicy;
  perceptual: PerceptualComparator;
  outDir: string;
}): Promise<ComparisonReport> {
  validateBaseline(input.baseline);
  validateCaptureRecord(input.current.record);
  const policy = normalizePolicy(input.policy);
  const baselineFile = await stat(input.baselinePath);
  const currentFile = await stat(input.current.path);
  if (!baselineFile.isFile() || !currentFile.isFile()) throw new Error("comparison inputs must be files");
  if (await sha256File(input.baselinePath) !== input.baseline.screenshotSha256) throw new Error("baseline screenshot hash mismatch");
  if (await sha256File(input.current.path) !== input.current.record.screenshotSha256) throw new Error("current screenshot hash mismatch");

  const incompatibilities: string[] = [];
  if (input.baseline.sceneDigest !== input.current.record.sceneDigest) incompatibilities.push("SCENE_SPEC_MISMATCH");
  if (!environmentEquals(input.baseline.environment, input.current.record.environment)) incompatibilities.push("RENDERING_ENVIRONMENT_MISMATCH");
  if (!viewportEquals(input.baseline.viewport, input.current.record.viewport)) incompatibilities.push("VIEWPORT_MISMATCH");
  if (incompatibilities.length) {
    const core = reportCore({
      verdict: "INCOMPATIBLE_BASELINE",
      reasons: incompatibilities.sort(),
      baselineDigest: input.baseline.digest,
      captureDigest: input.current.record.digest,
      changedPixels: null,
      ratio: null,
      perceptual: null,
      nonClaim: NON_CLAIM,
    });
    return { ...core, digest: digest(core) };
  }

  const maskReasons = maskDriftReasons(input.baseline, input.current.record, policy);
  if (maskReasons.length) {
    const core = reportCore({
      verdict: "FAIL",
      reasons: maskReasons,
      baselineDigest: input.baseline.digest,
      captureDigest: input.current.record.digest,
      changedPixels: null,
      ratio: null,
      perceptual: null,
      nonClaim: NON_CLAIM,
    });
    return { ...core, digest: digest(core) };
  }

  const baselineRaw = await sharp(input.baselinePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const currentRaw = await sharp(input.current.path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (baselineRaw.info.width !== currentRaw.info.width || baselineRaw.info.height !== currentRaw.info.height) {
    const core = reportCore({
      verdict: "FAIL",
      reasons: ["DIMENSION_MISMATCH"],
      baselineDigest: input.baseline.digest,
      captureDigest: input.current.record.digest,
      changedPixels: null,
      ratio: null,
      perceptual: null,
      nonClaim: NON_CLAIM,
    });
    return { ...core, digest: digest(core) };
  }

  const totalPixels = baselineRaw.info.width * baselineRaw.info.height;
  const diff = Buffer.alloc(totalPixels * 4);
  const changedPixels = pixelmatch(
    baselineRaw.data,
    currentRaw.data,
    diff,
    baselineRaw.info.width,
    baselineRaw.info.height,
    { threshold: policy.pixelThreshold, includeAA: false },
  );
  const ratio = changedPixels / totalPixels;
  const perceptual = await input.perceptual(input.baselinePath, input.current.path);
  if (!Number.isFinite(perceptual) || perceptual > 100) {
    throw new Error("perceptual score must be finite and <= 100");
  }
  const reasons: string[] = [];
  if (ratio > policy.maximumChangedPixelRatio) reasons.push("PIXEL_REGRESSION");
  if (perceptual < policy.minimumPerceptual) reasons.push("PERCEPTUAL_REGRESSION");

  await mkdir(input.outDir, { recursive: true });
  const diffPath = resolve(input.outDir, `diff-${input.current.record.digest.slice(0, 16)}.png`);
  await sharp(diff, { raw: { width: baselineRaw.info.width, height: baselineRaw.info.height, channels: 4 } }).png().toFile(diffPath);
  const core = reportCore({
    verdict: reasons.length ? "FAIL" : "PASS",
    reasons,
    baselineDigest: input.baseline.digest,
    captureDigest: input.current.record.digest,
    changedPixels,
    ratio: Math.round(ratio * 1e12) / 1e12,
    perceptual: Math.round(perceptual * 1e12) / 1e12,
    diffSha256: await sha256File(diffPath),
    nonClaim: NON_CLAIM,
  });
  return { ...core, diffPath, digest: digest(core) };
}

export function validateComparison(report: ComparisonReport): void {
  sha256Hex("comparison.digest", report.digest);
  sha256Hex("comparison.baselineDigest", report.baselineDigest);
  sha256Hex("comparison.captureDigest", report.captureDigest);
  if (report.nonClaim !== NON_CLAIM) throw new Error("comparison non-claim marker mismatch");
  const core = Object.fromEntries(Object.entries(report).filter(([key]) => key !== "digest" && key !== "diffPath"));
  if (digest(core) !== report.digest) throw new Error("comparison digest mismatch");
}

export function createSsimulacra2Comparator(
  executablePath: string,
  runner?: CommandRunner,
  timeoutMs = 30_000,
): PerceptualComparator {
  const tool = cleanString("ssimulacra2 executablePath", executablePath, 4_096);
  const timeout = positiveInteger("ssimulacra2 timeoutMs", timeoutMs, MAX_PERCEPTUAL_TIMEOUT_MS);
  const execute: CommandRunner = runner ?? (async (file, args) => {
    const result = await execFileAsync(file, [...args], { timeout, maxBuffer: MAX_STDIO, encoding: "utf8" });
    return { stdout: result.stdout, stderr: result.stderr };
  });
  return async (baselinePath, currentPath) => {
    const result = await execute(tool, [baselinePath, currentPath]);
    return parseSsimulacra2(`${result.stdout}\n${result.stderr}`);
  };
}
