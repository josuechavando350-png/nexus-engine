import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export type AdversarialProbeId = "TEXT_DOUBLE" | "TITLE_40" | "NO_MEDIA" | "VERTICAL_MEDIA" | "THROTTLED_3G" | "LOW_END_ANDROID" | "ZOOM_200" | "KEYBOARD_ONLY" | "REDUCED_MOTION";

export const ADVERSARIAL_PROBES: readonly AdversarialProbeId[] = Object.freeze([
  "TEXT_DOUBLE",
  "TITLE_40",
  "NO_MEDIA",
  "VERTICAL_MEDIA",
  "THROTTLED_3G",
  "LOW_END_ANDROID",
  "ZOOM_200",
  "KEYBOARD_ONLY",
  "REDUCED_MOTION",
]);

export type AdversarialProbeArtifact = Readonly<{
  probeId: AdversarialProbeId;
  screenshotUri: string;
  screenshotDigest: string;
  diagnosticsUri: string;
  diagnosticsDigest: string;
  diagnostics: Readonly<{
    horizontalOverflowPx: number;
    visibleElementCount: number;
    focusableCount: number;
    focusedCount: number;
    mediaElementCount: number;
    verticalMediaCount: number;
    animatedElementCount: number;
    textCharacterCount: number;
    maximumHeadingLength: number;
    reducedMotionMatches: boolean;
    cssZoom: number;
    viewportWidth: number;
    viewportHeight: number;
  }>;
}>;

const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function diagnostics(page: Page, focusedCount = 0): Promise<AdversarialProbeArtifact["diagnostics"]> {
  const base = await page.evaluate(() => {
    const visible = [...document.querySelectorAll<HTMLElement>("body *")].filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
    const media = [...document.querySelectorAll<HTMLElement>("img,picture,video,canvas,svg")];
    const animatedElementCount = visible.filter((element) => {
      const style = getComputedStyle(element);
      const positive = (value: string) => value.split(",").some((part) => Number.parseFloat(part) > 0);
      return positive(style.animationDuration) || positive(style.transitionDuration);
    }).length;
    const headingLengths = [...document.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")].map((heading) => (heading.innerText ?? "").length);
    return {
      horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      visibleElementCount: visible.length,
      focusableCount: document.querySelectorAll("a[href],button,input,select,textarea,[tabindex]:not([tabindex='-1'])").length,
      mediaElementCount: media.length,
      verticalMediaCount: media.filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.height > rect.width && rect.width > 0;
      }).length,
      animatedElementCount,
      textCharacterCount: (document.body.innerText ?? "").replace(/\s+/g, " ").trim().length,
      maximumHeadingLength: Math.max(0, ...headingLengths),
      reducedMotionMatches: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      cssZoom: Number.parseFloat(getComputedStyle(document.documentElement).zoom || "1") || 1,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
  return Object.freeze({ ...base, focusedCount });
}

async function configureContext(browser: Browser, probeId: AdversarialProbeId): Promise<{ context: BrowserContext; page: Page }> {
  const lowEnd = probeId === "LOW_END_ANDROID";
  const context = await browser.newContext({
    viewport: lowEnd ? { width: 360, height: 740 } : { width: 390, height: 844 },
    deviceScaleFactor: lowEnd ? 1 : 2,
    isMobile: lowEnd,
    hasTouch: lowEnd,
    reducedMotion: probeId === "REDUCED_MOTION" ? "reduce" : "no-preference",
    locale: "es-MX",
    timezoneId: "America/Mexico_City",
    userAgent: lowEnd ? "Mozilla/5.0 (Linux; Android 10; Nexus-Low-End) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36" : undefined,
  });
  const page = await context.newPage();
  if (probeId === "THROTTLED_3G" || probeId === "LOW_END_ANDROID") {
    const session = await context.newCDPSession(page);
    if (probeId === "THROTTLED_3G") {
      await session.send("Network.enable");
      await session.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 400,
        downloadThroughput: 50 * 1024,
        uploadThroughput: 20 * 1024,
        connectionType: "cellular3g",
      });
    } else {
      await session.send("Emulation.setCPUThrottlingRate", { rate: 6 });
    }
  }
  return { context, page };
}

async function applyPostNavigationProbe(page: Page, probeId: AdversarialProbeId): Promise<number> {
  if (probeId === "TEXT_DOUBLE") {
    await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const parent = node.parentElement;
        const text = node.nodeValue?.trim() ?? "";
        if (text.length >= 4 && parent && !["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA"].includes(parent.tagName)) node.nodeValue = `${text} ${text}`;
      }
    });
  } else if (probeId === "TITLE_40") {
    await page.evaluate(() => {
      const exactForty = "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCD";
      for (const heading of document.querySelectorAll<HTMLElement>("h1,h2,h3")) heading.innerText = exactForty;
    });
  } else if (probeId === "NO_MEDIA") {
    await page.evaluate(() => document.querySelectorAll("img,picture,video,canvas,svg").forEach((node) => node.remove()));
  } else if (probeId === "VERTICAL_MEDIA") {
    await page.evaluate(() => {
      const verticalSvg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='540' height='960'%3E%3Crect width='540' height='960' fill='%23999'/%3E%3C/svg%3E";
      for (const image of document.querySelectorAll<HTMLImageElement>("img")) {
        image.removeAttribute("srcset");
        image.src = verticalSvg;
        image.style.width = "min(100%, 360px)";
        image.style.height = "640px";
        image.style.objectFit = "cover";
      }
      for (const source of document.querySelectorAll("picture source")) source.remove();
    });
  } else if (probeId === "ZOOM_200") {
    await page.addStyleTag({ content: "html{zoom:2!important}" });
  } else if (probeId === "REDUCED_MOTION") {
    await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}" });
  }

  if (probeId !== "KEYBOARD_ONLY") return 0;
  let focusedCount = 0;
  for (let index = 0; index < 20; index += 1) {
    await page.keyboard.press("Tab");
    const tag = await page.evaluate(() => document.activeElement?.tagName ?? "BODY");
    if (tag !== "BODY") focusedCount += 1;
  }
  return focusedCount;
}

export async function runAdversarialMatrix(input: { targetUrl: string; outputDir: string; navigationTimeoutMs?: number }): Promise<Readonly<{ authority: "NEXUS_ADVERSARIAL_MATRIX_V1"; targetUrl: string; artifacts: readonly AdversarialProbeArtifact[] }>> {
  const parsed = new URL(input.targetUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("adversarial target must use HTTP(S)");
  if (!input.outputDir.trim()) throw new Error("adversarial outputDir is required");
  const outputDir = resolve(input.outputDir);
  await mkdir(outputDir, { recursive: true });
  const artifacts: AdversarialProbeArtifact[] = [];
  const browser = await chromium.launch({ headless: true });

  try {
    for (const probeId of ADVERSARIAL_PROBES) {
      const { context, page } = await configureContext(browser, probeId);
      try {
        await page.goto(input.targetUrl, { waitUntil: "networkidle", timeout: input.navigationTimeoutMs ?? 30_000 });
        const focusedCount = await applyPostNavigationProbe(page, probeId);
        await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
        const observed = await diagnostics(page, focusedCount);
        const png = await page.screenshot({ fullPage: true, animations: "disabled", type: "png" });
        const stem = `adversarial-${probeId.toLowerCase().replaceAll("_", "-")}`;
        const screenshotUri = resolve(outputDir, `${stem}.png`);
        const diagnosticsUri = resolve(outputDir, `${stem}.json`);
        const diagnosticsBytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, probeId, diagnostics: observed }, null, 2)}\n`);
        await writeFile(screenshotUri, png);
        await writeFile(diagnosticsUri, diagnosticsBytes);
        artifacts.push(Object.freeze({ probeId, screenshotUri, screenshotDigest: sha256(png), diagnosticsUri, diagnosticsDigest: sha256(diagnosticsBytes), diagnostics: observed }));
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  return Object.freeze({ authority: "NEXUS_ADVERSARIAL_MATRIX_V1", targetUrl: input.targetUrl, artifacts: Object.freeze(artifacts) });
}
