import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium, webkit, type BrowserType, type Page } from "playwright";
import type { MetricSample } from "../measurement/index";
import { measureApca } from "./apca-audit";
import { extractDesignGenome } from "./design-genome";
import { collectWebVitals, installWebVitalsObservers } from "./web-vitals";
import {
  captureRequestId,
  createCaptureArtifact,
  validateCaptureRequest,
  type BrowserDeviceCapturePort,
  type CaptureArtifact,
  type CaptureRequest,
  type CaptureResult,
} from "./index";

export type SupportedBrowser = "chromium" | "webkit";
export type CaptureViewport = Readonly<{ name: string; width: number; height: number }>;

export interface PlaywrightCaptureOptions {
  outputDir: string;
  browsers?: readonly SupportedBrowser[];
  viewports?: readonly CaptureViewport[];
  navigationTimeoutMs?: number;
  clock?: () => string;
}

const DEFAULT_VIEWPORTS: readonly CaptureViewport[] = Object.freeze([
  Object.freeze({ name: "mobile-390", width: 390, height: 844 }),
  Object.freeze({ name: "tablet-768", width: 768, height: 1024 }),
  Object.freeze({ name: "desktop-1440", width: 1440, height: 1000 }),
]);

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function browserType(name: SupportedBrowser): BrowserType {
  return name === "chromium" ? chromium : webkit;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "capture";
}

function validateUrl(targetId: string): URL {
  let target: URL;
  try {
    target = new URL(targetId);
  } catch {
    throw new Error("Playwright capture targetId must be an absolute HTTP(S) URL");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("Playwright capture targetId must use HTTP(S)");
  return target;
}

async function performanceSamples(page: Page, prefix: string): Promise<MetricSample[]> {
  const observed = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const paint = performance.getEntriesByName("first-contentful-paint")[0];
    const scriptResources = resources.filter((entry) => entry.initiatorType === "script");
    return {
      navigationDurationMs: navigation?.duration ?? 0,
      domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? 0,
      loadEventEndMs: navigation?.loadEventEnd ?? 0,
      firstContentfulPaintMs: paint?.startTime ?? 0,
      resourceCount: resources.length,
      scriptTransferBytes: scriptResources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
    };
  });
  return [
    { name: `${prefix}.navigation_duration`, unit: "ms", value: observed.navigationDurationMs },
    { name: `${prefix}.dom_content_loaded`, unit: "ms", value: observed.domContentLoadedMs },
    { name: `${prefix}.load_event_end`, unit: "ms", value: observed.loadEventEndMs },
    { name: `${prefix}.first_contentful_paint`, unit: "ms", value: observed.firstContentfulPaintMs },
    { name: `${prefix}.resource_count`, unit: "count", value: observed.resourceCount },
    { name: `${prefix}.script_transfer_bytes`, unit: "bytes", value: observed.scriptTransferBytes },
  ];
}

export class PlaywrightBrowserDeviceCaptureAdapter implements BrowserDeviceCapturePort {
  readonly adapterId = "nexus.playwright-browser-capture";
  readonly adapterVersion = "1.3.0";
  private readonly outputDir: string;
  private readonly browsers: readonly SupportedBrowser[];
  private readonly viewports: readonly CaptureViewport[];
  private readonly navigationTimeoutMs: number;
  private readonly clock: () => string;

  constructor(options: PlaywrightCaptureOptions) {
    if (!options.outputDir.trim()) throw new Error("outputDir is required");
    this.outputDir = resolve(options.outputDir);
    this.browsers = Object.freeze([...(options.browsers ?? ["chromium", "webkit"])]);
    this.viewports = Object.freeze([...(options.viewports ?? DEFAULT_VIEWPORTS)]);
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? 30_000;
    this.clock = options.clock ?? (() => new Date().toISOString());
    if (!this.browsers.length) throw new Error("at least one browser is required");
    if (!this.viewports.length) throw new Error("at least one viewport is required");
    for (const viewport of this.viewports) {
      if (!viewport.name.trim() || !Number.isInteger(viewport.width) || !Number.isInteger(viewport.height) || viewport.width < 240 || viewport.height < 240) throw new Error("capture viewports require a name and integer dimensions >= 240px");
    }
  }

  async capture(request: CaptureRequest): Promise<CaptureResult> {
    validateCaptureRequest(request);
    validateUrl(request.targetId);
    const requestId = captureRequestId(request);
    const artifacts: CaptureArtifact[] = [];
    const samples: MetricSample[] = [];
    await mkdir(this.outputDir, { recursive: true });

    try {
      for (const browserName of this.browsers) {
        const browser = await browserType(browserName).launch({ headless: true });
        try {
          for (const viewport of this.viewports) {
            const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC" });
            try {
              const page = await context.newPage();
              if (request.capabilities.includes("PERFORMANCE")) await installWebVitalsObservers(page);
              await page.goto(request.targetId, { waitUntil: "networkidle", timeout: this.navigationTimeoutMs });
              const prefix = `${browserName}-${safeSegment(viewport.name)}`;

              if (request.capabilities.includes("SCREENSHOT")) {
                const png = await page.screenshot({ fullPage: true, animations: "disabled", type: "png" });
                const path = resolve(this.outputDir, `${safeSegment(requestId)}-${prefix}.png`);
                await writeFile(path, png);
                artifacts.push(createCaptureArtifact({ runId: request.run.runId, scope: request.scope, capability: "SCREENSHOT", mediaType: "image/png", digest: sha256(png), byteLength: png.byteLength, capturedAt: this.clock(), uri: path, metadata: Object.freeze({ browser: browserName, viewport: viewport.name, width: String(viewport.width), height: String(viewport.height) }) }));
              }

              if (request.capabilities.includes("ACCESSIBILITY")) {
                const axe = await new AxeBuilder({ page }).analyze();
                const bytes = Buffer.from(`${JSON.stringify({ url: axe.url, violations: axe.violations, incomplete: axe.incomplete, passes: axe.passes }, null, 2)}\n`, "utf8");
                const path = resolve(this.outputDir, `${safeSegment(requestId)}-${prefix}-axe.json`);
                await writeFile(path, bytes);
                artifacts.push(createCaptureArtifact({ runId: request.run.runId, scope: request.scope, capability: "ACCESSIBILITY", mediaType: "application/json", digest: sha256(bytes), byteLength: bytes.byteLength, capturedAt: this.clock(), uri: path, metadata: Object.freeze({ browser: browserName, viewport: viewport.name, violationCount: String(axe.violations.length) }) }));
                samples.push({ name: `${prefix}.axe_violations`, unit: "count", value: axe.violations.length });
              }

              if (request.capabilities.includes("DESIGN_GENOME")) {
                const genome = await extractDesignGenome(page);
                const bytes = Buffer.from(`${JSON.stringify(genome, null, 2)}\n`, "utf8");
                const path = resolve(this.outputDir, `${safeSegment(requestId)}-${prefix}-design-genome.json`);
                await writeFile(path, bytes);
                artifacts.push(createCaptureArtifact({ runId: request.run.runId, scope: request.scope, capability: "DESIGN_GENOME", mediaType: "application/vnd.nexus.design-genome+json", digest: sha256(bytes), byteLength: bytes.byteLength, capturedAt: this.clock(), uri: path, metadata: Object.freeze({ browser: browserName, viewport: viewport.name, visibleElementCount: String(genome.visibleElementCount), fontFamilyCount: String(genome.typography.familyCount), animatedElementCount: String(genome.motion.animatedElementCount) }) }));
                samples.push({ name: `${prefix}.genome_visible_elements`, unit: "count", value: genome.visibleElementCount });
                samples.push({ name: `${prefix}.genome_font_families`, unit: "count", value: genome.typography.familyCount });
                samples.push({ name: `${prefix}.genome_media_area_ratio`, unit: "ratio", value: genome.media.mediaAreaRatio });
              }

              if (request.capabilities.includes("CONTRAST")) {
                const contrast = await measureApca(page);
                const bytes = Buffer.from(`${JSON.stringify(contrast, null, 2)}\n`, "utf8");
                const path = resolve(this.outputDir, `${safeSegment(requestId)}-${prefix}-apca.json`);
                await writeFile(path, bytes);
                artifacts.push(createCaptureArtifact({ runId: request.run.runId, scope: request.scope, capability: "CONTRAST", mediaType: "application/vnd.nexus.apca+json", digest: sha256(bytes), byteLength: bytes.byteLength, capturedAt: this.clock(), uri: path, metadata: Object.freeze({ browser: browserName, viewport: viewport.name, algorithm: contrast.algorithm, library: `${contrast.library}@${contrast.libraryVersion}`, observationCount: String(contrast.observations.length), unsupportedCount: String(contrast.unsupportedCount) }) }));
                samples.push({ name: `${prefix}.apca_observations`, unit: "count", value: contrast.observations.length });
                samples.push({ name: `${prefix}.apca_unsupported`, unit: "count", value: contrast.unsupportedCount });
              }

              if (request.capabilities.includes("PERFORMANCE")) {
                const vitals = await collectWebVitals(page);
                const bytes = Buffer.from(`${JSON.stringify(vitals, null, 2)}\n`, "utf8");
                const path = resolve(this.outputDir, `${safeSegment(requestId)}-${prefix}-performance.json`);
                await writeFile(path, bytes);
                artifacts.push(createCaptureArtifact({ runId: request.run.runId, scope: request.scope, capability: "PERFORMANCE", mediaType: "application/vnd.nexus.web-vitals+json", digest: sha256(bytes), byteLength: bytes.byteLength, capturedAt: this.clock(), uri: path, metadata: Object.freeze({ browser: browserName, viewport: viewport.name, lcpState: vitals.lcp.state, clsState: vitals.cls.state, inpState: vitals.inp.state }) }));
                samples.push(...await performanceSamples(page, prefix));
                if (vitals.lcp.state === "MEASURED") samples.push({ name: `${prefix}.lcp`, unit: "ms", value: vitals.lcp.value! });
                if (vitals.cls.state === "MEASURED") samples.push({ name: `${prefix}.cls`, unit: "score", value: vitals.cls.value! });
                if (vitals.inp.state === "MEASURED") samples.push({ name: `${prefix}.inp`, unit: "ms", value: vitals.inp.value! });
              }
            } finally {
              await context.close();
            }
          }
        } finally {
          await browser.close();
        }
      }
      return { requestId, outcome: "CAPTURED", artifacts, samples };
    } catch (error) {
      return { requestId, outcome: "FAILED", artifacts: [], samples: [], reason: error instanceof Error ? error.message : "unknown Playwright capture failure" };
    }
  }
}
