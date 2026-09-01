import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { chromium, webkit, type Locator, type Page } from "playwright";
import {
  createViewport,
  digest,
  validateCaptureRecord,
  type BrowserName,
  type CaptureArtifact,
  type MaskObservation,
  type RenderingEnvironment,
  type Scene,
  type Viewport,
} from "./index.js";

const require = createRequire(import.meta.url);
const playwrightPackage = require("playwright/package.json") as { version?: unknown };
const PLAYWRIGHT_VERSION = typeof playwrightPackage.version === "string" ? playwrightPackage.version : "UNKNOWN";
const MAX_NAVIGATION_TIMEOUT_MS = 60_000;
const MAX_MASK_MATCHES = 256;

export interface RuntimeCaptureArtifact extends CaptureArtifact {
  navigationUrl: string;
}

function cleanUrl(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4_096) throw new Error("navigationUrl must be a bounded non-empty URL");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("navigationUrl must be a valid HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("navigationUrl must use HTTP(S)");
  if (parsed.username || parsed.password) throw new Error("navigationUrl must not contain credentials");
  parsed.hash = "";
  return parsed.toString();
}

function positiveTimeout(value: number | undefined): number {
  const timeout = value ?? 30_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_NAVIGATION_TIMEOUT_MS) throw new Error(`navigationTimeoutMs must be an integer in [1, ${MAX_NAVIGATION_TIMEOUT_MS}]`);
  return timeout;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function environment(browserName: BrowserName, browserVersion: string): RenderingEnvironment {
  if (!browserVersion.trim()) throw new Error("browserVersion is required");
  const core = {
    browserName,
    browserVersion: browserVersion.trim(),
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

export async function captureSceneAtNavigationUrl(input: {
  scene: Scene;
  navigationUrl: string;
  browserName: BrowserName;
  viewport: Viewport;
  revision: string;
  buildDigest: string;
  outDir: string;
  navigationTimeoutMs?: number;
}): Promise<RuntimeCaptureArtifact> {
  const navigationUrl = cleanUrl(input.navigationUrl);
  if (typeof input.revision !== "string" || !input.revision.trim() || input.revision.length > 500) throw new Error("revision must be a bounded non-empty string");
  if (!/^[a-f0-9]{64}$/u.test(input.buildDigest)) throw new Error("buildDigest must be lowercase sha256 hex");
  const viewport = createViewport(input.viewport.name, input.viewport.width, input.viewport.height);
  const timeout = positiveTimeout(input.navigationTimeoutMs);
  const browserType = input.browserName === "chromium" ? chromium : input.browserName === "webkit" ? webkit : null;
  if (!browserType) throw new Error("unsupported browserName");

  const browser = await browserType.launch({ headless: true });
  try {
    const renderingEnvironment = environment(input.browserName, browser.version());
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
      await page.goto(navigationUrl, { waitUntil: "load", timeout });
      await settle(page);

      const dimensions = await page.evaluate(() => ({
        width: Math.max(document.documentElement.scrollWidth, innerWidth),
        height: Math.max(document.documentElement.scrollHeight, innerHeight),
      }));
      if (!Number.isInteger(dimensions.width) || dimensions.width <= 0 || !Number.isInteger(dimensions.height) || dimensions.height <= 0) throw new Error("capture document dimensions are invalid");
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
      if (maskedArea / totalArea > input.scene.policy.maximumMaskAreaRatio) throw new Error("mask area exceeds scene policy");

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
        revision: input.revision.trim(),
        buildDigest: input.buildDigest,
        environment: renderingEnvironment,
        viewport,
        width: dimensions.width,
        height: dimensions.height,
        screenshotSha256: sha256(png),
        masks: observations.sort((left, right) => left.selector.localeCompare(right.selector, "en")),
      };
      const record = { ...core, digest: digest(core) };
      validateCaptureRecord(record);
      return Object.freeze({ record, path, navigationUrl });
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
