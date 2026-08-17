import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, webkit, type BrowserType } from "playwright";

export type BrowserMutationId = "GRAYSCALE" | "MOTION_REMOVAL" | "VIEWPORT_TORTURE_NARROW" | "VIEWPORT_TORTURE_WIDE" | "CONTENT_STRESS" | "ASSET_DEGRADATION";
export type MutationBrowser = "chromium" | "webkit";

export interface BrowserMutationArtifact {
  mutationId: BrowserMutationId;
  browser: MutationBrowser;
  viewport: Readonly<{ width: number; height: number }>;
  screenshotUri: string;
  screenshotDigest: string;
  screenshotByteLength: number;
  diagnosticsUri: string;
  diagnosticsDigest: string;
  diagnostics: Readonly<{
    horizontalOverflowPx: number;
    scrollHeightPx: number;
    visibleElementCount: number;
    textCharacterCount: number;
    mediaElementCount: number;
    animatedElementCount: number;
  }>;
}

export interface BrowserMutationSuiteResult {
  authority: "NEXUS_BROWSER_MUTATION_RUNNER";
  targetUrl: string;
  artifacts: readonly BrowserMutationArtifact[];
}

const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const browserType = (name: MutationBrowser): BrowserType => name === "chromium" ? chromium : webkit;

function safe(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "mutation";
}

function validateTarget(targetUrl: string): void {
  let parsed: URL;
  try { parsed = new URL(targetUrl); } catch { throw new Error("mutation target must be an absolute HTTP(S) URL"); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("mutation target must use HTTP(S)");
}

async function diagnostics(page: import("playwright").Page): Promise<BrowserMutationArtifact["diagnostics"]> {
  return page.evaluate(() => {
    const visible = [...document.querySelectorAll<HTMLElement>("body *")].filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
    const animatedElementCount = visible.filter((element) => {
      const style = getComputedStyle(element);
      const duration = (value: string) => value.split(",").some((part) => Number.parseFloat(part) > 0);
      return duration(style.transitionDuration) || duration(style.animationDuration);
    }).length;
    return {
      horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      scrollHeightPx: document.documentElement.scrollHeight,
      visibleElementCount: visible.length,
      textCharacterCount: (document.body.innerText ?? "").replace(/\s+/g, " ").trim().length,
      mediaElementCount: document.querySelectorAll("img,picture,video,canvas,svg").length,
      animatedElementCount,
    };
  });
}

async function applyMutation(page: import("playwright").Page, mutationId: BrowserMutationId): Promise<void> {
  if (mutationId === "GRAYSCALE") {
    await page.addStyleTag({ content: "html { filter: grayscale(1) !important; }" });
    return;
  }
  if (mutationId === "MOTION_REMOVAL") {
    await page.addStyleTag({ content: "*,*::before,*::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }" });
    return;
  }
  if (mutationId === "CONTENT_STRESS") {
    await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const text = node.nodeValue?.replace(/\s+/g, " ").trim() ?? "";
        const parent = node.parentElement;
        if (text.length >= 4 && parent && !["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) nodes.push(node);
      }
      for (const node of nodes.slice(0, 80)) {
        const original = node.nodeValue?.trim() ?? "";
        node.nodeValue = `${original} — ${original} — ${original}`;
      }
    });
    return;
  }
  if (mutationId === "ASSET_DEGRADATION") {
    await page.evaluate(() => {
      const transparentGif = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
      for (const image of document.querySelectorAll<HTMLImageElement>("img")) {
        image.removeAttribute("srcset");
        image.src = transparentGif;
        image.style.background = "rgb(128 128 128)";
      }
      for (const video of document.querySelectorAll<HTMLVideoElement>("video")) {
        video.pause();
        video.removeAttribute("src");
        video.removeAttribute("poster");
        video.style.background = "rgb(128 128 128)";
      }
      for (const picture of document.querySelectorAll("picture source")) picture.remove();
    });
  }
}

export async function runBrowserMutationSuite(input: {
  targetUrl: string;
  outputDir: string;
  browser?: MutationBrowser;
  navigationTimeoutMs?: number;
}): Promise<BrowserMutationSuiteResult> {
  validateTarget(input.targetUrl);
  if (!input.outputDir.trim()) throw new Error("mutation outputDir is required");
  const browserName = input.browser ?? "chromium";
  const outputDir = resolve(input.outputDir);
  await mkdir(outputDir, { recursive: true });
  const browser = await browserType(browserName).launch({ headless: true });
  const mutationSpecs: readonly Readonly<{ id: BrowserMutationId; width: number; height: number; reducedMotion?: "reduce" }>[] = [
    { id: "GRAYSCALE", width: 390, height: 844 },
    { id: "MOTION_REMOVAL", width: 390, height: 844, reducedMotion: "reduce" },
    { id: "VIEWPORT_TORTURE_NARROW", width: 320, height: 568 },
    { id: "VIEWPORT_TORTURE_WIDE", width: 1920, height: 1080 },
    { id: "CONTENT_STRESS", width: 390, height: 844 },
    { id: "ASSET_DEGRADATION", width: 390, height: 844 },
  ];
  const artifacts: BrowserMutationArtifact[] = [];
  try {
    for (const spec of mutationSpecs) {
      const context = await browser.newContext({ viewport: { width: spec.width, height: spec.height }, reducedMotion: spec.reducedMotion ?? "no-preference", locale: "en-US", timezoneId: "UTC" });
      try {
        const page = await context.newPage();
        await page.goto(input.targetUrl, { waitUntil: "networkidle", timeout: input.navigationTimeoutMs ?? 30_000 });
        if (!spec.id.startsWith("VIEWPORT_TORTURE")) await applyMutation(page, spec.id);
        await page.evaluate(() => new Promise<void>((resolveAnimation) => requestAnimationFrame(() => requestAnimationFrame(() => resolveAnimation()))));
        const observed = await diagnostics(page);
        const png = await page.screenshot({ fullPage: true, animations: "disabled", type: "png" });
        const stem = `${browserName}-${safe(spec.id.toLowerCase())}-${spec.width}x${spec.height}`;
        const screenshotUri = resolve(outputDir, `${stem}.png`);
        const diagnosticsUri = resolve(outputDir, `${stem}.json`);
        const diagnosticsBytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, mutationId: spec.id, browser: browserName, viewport: { width: spec.width, height: spec.height }, diagnostics: observed }, null, 2)}\n`);
        await writeFile(screenshotUri, png);
        await writeFile(diagnosticsUri, diagnosticsBytes);
        artifacts.push(Object.freeze({
          mutationId: spec.id,
          browser: browserName,
          viewport: Object.freeze({ width: spec.width, height: spec.height }),
          screenshotUri,
          screenshotDigest: sha256(png),
          screenshotByteLength: png.byteLength,
          diagnosticsUri,
          diagnosticsDigest: sha256(diagnosticsBytes),
          diagnostics: Object.freeze(observed),
        }));
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return Object.freeze({ authority: "NEXUS_BROWSER_MUTATION_RUNNER", targetUrl: input.targetUrl, artifacts: Object.freeze(artifacts) });
}
