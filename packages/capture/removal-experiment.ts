import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, webkit, type BrowserType, type Page } from "playwright";
import { extractDesignGenome, type DesignGenomeObservation } from "./design-genome";

export type RemovalExperimentBrowser = "chromium" | "webkit";

export interface RemovalExperimentCandidate {
  elementId: string;
  selector: string;
}

export interface RemovalExperimentDiagnostics {
  selectorCount: number;
  visibleElementCount: number;
  textCharacterCount: number;
  interactiveElementCount: number;
  focusableElementCount: number;
  headingOneCount: number;
  mainLandmarkCount: number;
  mediaElementCount: number;
  horizontalOverflowPx: number;
  scrollHeightPx: number;
  target: Readonly<{
    present: boolean;
    visible: boolean;
    tagName: string;
    textCharacterCount: number;
    interactiveElementCount: number;
    focusableElementCount: number;
    headingOneCount: number;
    mainLandmarkCount: number;
    mediaElementCount: number;
  }>;
  designGenome: DesignGenomeObservation;
}

export interface RemovalExperimentArtifact {
  elementId: string;
  selector: string;
  browser: RemovalExperimentBrowser;
  viewport: Readonly<{ width: number; height: number }>;
  beforeScreenshotUri: string;
  beforeScreenshotDigest: string;
  beforeScreenshotByteLength: number;
  afterScreenshotUri: string;
  afterScreenshotDigest: string;
  afterScreenshotByteLength: number;
  diagnosticsUri: string;
  diagnosticsDigest: string;
  removedNodeCount: number;
  before: RemovalExperimentDiagnostics;
  after: RemovalExperimentDiagnostics;
}

export interface RemovalExperimentResult {
  authority: "NEXUS_REMOVAL_EXPERIMENT_RUNNER";
  targetUrl: string;
  artifacts: readonly RemovalExperimentArtifact[];
}

const sha256 = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const browserType = (name: RemovalExperimentBrowser): BrowserType => name === "chromium" ? chromium : webkit;
const MAX_CANDIDATES = 100;
const MIN_NAVIGATION_TIMEOUT_MS = 1_000;
const MAX_NAVIGATION_TIMEOUT_MS = 180_000;

function safe(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "element";
}

function validateTarget(targetUrl: string): void {
  let parsed: URL;
  try { parsed = new URL(targetUrl); } catch { throw new Error("removal experiment target must be an absolute HTTP(S) URL"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("removal experiment target must use HTTP(S)");
}

function validateCandidates(candidates: readonly RemovalExperimentCandidate[]): readonly RemovalExperimentCandidate[] {
  if (!Array.isArray(candidates) || candidates.length === 0) throw new Error("removal experiment requires at least one candidate");
  if (candidates.length > MAX_CANDIDATES) throw new Error(`removal experiment accepts at most ${MAX_CANDIDATES} candidates`);
  const normalized = candidates.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") throw new Error(`removal candidate[${index}] must be an object`);
    const elementId = candidate.elementId?.trim();
    const selector = candidate.selector?.trim();
    if (!elementId) throw new Error(`removal candidate[${index}] elementId is required`);
    if (!selector) throw new Error(`removal candidate[${index}] selector is required`);
    if (elementId.length > 128) throw new Error(`removal candidate[${index}] elementId exceeds 128 characters`);
    if (selector.length > 512) throw new Error(`removal candidate[${index}] selector exceeds 512 characters`);
    return Object.freeze({ elementId, selector });
  });
  if (new Set(normalized.map((candidate) => candidate.elementId)).size !== normalized.length) throw new Error("removal candidate elementId values must be unique");
  if (new Set(normalized.map((candidate) => candidate.selector)).size !== normalized.length) throw new Error("removal candidate selectors must be unique");
  return Object.freeze(normalized);
}

async function semanticDiagnostics(page: Page, selector: string): Promise<Omit<RemovalExperimentDiagnostics, "designGenome">> {
  return page.evaluate((candidateSelector) => {
    const visible = (element: Element): boolean => {
      if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number.parseFloat(style.opacity || "1") > 0;
    };
    const interactiveSelector = "a[href],button,input,select,textarea,summary,[role='button'],[role='link'],[role='menuitem'],[contenteditable='true']";
    const focusableSelector = `${interactiveSelector},[tabindex]:not([tabindex='-1'])`;
    const countWithin = (root: Element, query: string): number => (root.matches(query) ? 1 : 0) + root.querySelectorAll(query).length;
    const targetNodes = [...document.querySelectorAll(candidateSelector)];
    const target = targetNodes[0];
    const bodyText = (document.body.innerText ?? "").replace(/\s+/g, " ").trim();
    return {
      selectorCount: targetNodes.length,
      visibleElementCount: [...document.querySelectorAll("body *")].filter(visible).length,
      textCharacterCount: bodyText.length,
      interactiveElementCount: document.querySelectorAll(interactiveSelector).length,
      focusableElementCount: document.querySelectorAll(focusableSelector).length,
      headingOneCount: document.querySelectorAll("h1,[role='heading'][aria-level='1']").length,
      mainLandmarkCount: document.querySelectorAll("main,[role='main']").length,
      mediaElementCount: document.querySelectorAll("img,picture,video,canvas,svg").length,
      horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      scrollHeightPx: document.documentElement.scrollHeight,
      target: target ? {
        present: true,
        visible: visible(target),
        tagName: target.tagName.toLowerCase(),
        textCharacterCount: (target.textContent ?? "").replace(/\s+/g, " ").trim().length,
        interactiveElementCount: countWithin(target, interactiveSelector),
        focusableElementCount: countWithin(target, focusableSelector),
        headingOneCount: countWithin(target, "h1,[role='heading'][aria-level='1']"),
        mainLandmarkCount: countWithin(target, "main,[role='main']"),
        mediaElementCount: countWithin(target, "img,picture,video,canvas,svg"),
      } : {
        present: false,
        visible: false,
        tagName: "",
        textCharacterCount: 0,
        interactiveElementCount: 0,
        focusableElementCount: 0,
        headingOneCount: 0,
        mainLandmarkCount: 0,
        mediaElementCount: 0,
      },
    };
  }, selector);
}

async function diagnostics(page: Page, selector: string): Promise<RemovalExperimentDiagnostics> {
  const [semantic, designGenome] = await Promise.all([semanticDiagnostics(page, selector), extractDesignGenome(page)]);
  return Object.freeze({ ...semantic, target: Object.freeze({ ...semantic.target }), designGenome });
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

export async function runRemovalExperiments(input: {
  targetUrl: string;
  outputDir: string;
  candidates: readonly RemovalExperimentCandidate[];
  browser?: RemovalExperimentBrowser;
  viewport?: Readonly<{ width: number; height: number }>;
  navigationTimeoutMs?: number;
}): Promise<RemovalExperimentResult> {
  validateTarget(input.targetUrl);
  if (!input.outputDir.trim()) throw new Error("removal experiment outputDir is required");
  const candidates = validateCandidates(input.candidates);
  const browserName = input.browser ?? "chromium";
  if (browserName !== "chromium" && browserName !== "webkit") throw new Error(`unsupported removal experiment browser: ${String(browserName)}`);
  const viewport = Object.freeze({ ...(input.viewport ?? { width: 390, height: 844 }) });
  if (!Number.isInteger(viewport.width) || viewport.width < 240 || viewport.width > 4096 || !Number.isInteger(viewport.height) || viewport.height < 240 || viewport.height > 4096) {
    throw new Error("removal experiment viewport must use integer dimensions in [240,4096]");
  }
  const navigationTimeoutMs = input.navigationTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(navigationTimeoutMs) || navigationTimeoutMs < MIN_NAVIGATION_TIMEOUT_MS || navigationTimeoutMs > MAX_NAVIGATION_TIMEOUT_MS) {
    throw new Error(`removal experiment navigationTimeoutMs must be an integer in [${MIN_NAVIGATION_TIMEOUT_MS},${MAX_NAVIGATION_TIMEOUT_MS}]`);
  }
  const outputDir = resolve(input.outputDir);
  await mkdir(outputDir, { recursive: true });
  const browser = await browserType(browserName).launch({ headless: true });
  const artifacts: RemovalExperimentArtifact[] = [];
  try {
    for (const [candidateIndex, candidate] of candidates.entries()) {
      const context = await browser.newContext({ viewport, locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce" });
      try {
        const page = await context.newPage();
        await page.goto(input.targetUrl, { waitUntil: "networkidle", timeout: navigationTimeoutMs });
        await settle(page);
        const before = await diagnostics(page, candidate.selector);
        if (before.selectorCount !== 1) throw new Error(`removal candidate ${candidate.elementId} selector must resolve exactly one node; got ${before.selectorCount}`);

        const beforePng = await page.screenshot({ fullPage: true, animations: "disabled", type: "png" });
        const removedNodeCount = await page.evaluate((selector) => {
          const nodes = [...document.querySelectorAll(selector)];
          if (nodes.length !== 1) return 0;
          nodes[0]?.remove();
          return 1;
        }, candidate.selector);
        if (removedNodeCount !== 1) throw new Error(`removal candidate ${candidate.elementId} could not remove exactly one node`);
        await settle(page);
        const after = await diagnostics(page, candidate.selector);
        if (after.selectorCount !== 0 || after.target.present) throw new Error(`removal candidate ${candidate.elementId} remained present after removal`);
        const afterPng = await page.screenshot({ fullPage: true, animations: "disabled", type: "png" });

        const candidateDigest = createHash("sha256").update(candidate.elementId).digest("hex").slice(0, 12);
        const stem = `${browserName}-${String(candidateIndex).padStart(3, "0")}-${safe(candidate.elementId)}-${candidateDigest}-${viewport.width}x${viewport.height}`;
        const beforeScreenshotUri = resolve(outputDir, `${stem}-before.png`);
        const afterScreenshotUri = resolve(outputDir, `${stem}-after.png`);
        const diagnosticsUri = resolve(outputDir, `${stem}.json`);
        const diagnosticsBytes = Buffer.from(`${JSON.stringify({
          schemaVersion: 1,
          authority: "NEXUS_REMOVAL_EXPERIMENT_RUNNER",
          elementId: candidate.elementId,
          selector: candidate.selector,
          browser: browserName,
          viewport,
          removedNodeCount,
          before,
          after,
        }, null, 2)}\n`);
        await writeFile(beforeScreenshotUri, beforePng);
        await writeFile(afterScreenshotUri, afterPng);
        await writeFile(diagnosticsUri, diagnosticsBytes);
        artifacts.push(Object.freeze({
          elementId: candidate.elementId,
          selector: candidate.selector,
          browser: browserName,
          viewport,
          beforeScreenshotUri,
          beforeScreenshotDigest: sha256(beforePng),
          beforeScreenshotByteLength: beforePng.byteLength,
          afterScreenshotUri,
          afterScreenshotDigest: sha256(afterPng),
          afterScreenshotByteLength: afterPng.byteLength,
          diagnosticsUri,
          diagnosticsDigest: sha256(diagnosticsBytes),
          removedNodeCount,
          before,
          after,
        }));
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return Object.freeze({ authority: "NEXUS_REMOVAL_EXPERIMENT_RUNNER", targetUrl: input.targetUrl, artifacts: Object.freeze(artifacts) });
}
