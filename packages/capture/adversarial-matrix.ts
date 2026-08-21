import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";

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
    textCharacterCount: number;
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
    return {
      horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      visibleElementCount: visible.length,
      focusableCount: document.querySelectorAll("a[href],button,input,select,textarea,[tabindex]:not([tabindex='-1'])").length,
      mediaElementCount: document.querySelectorAll("img,picture,video,canvas,svg").length,
      textCharacterCount: (document.body.innerText ?? "").replace(/\s+/g, " ").trim().length,
    };
  });
  return Object.freeze({ ...base, focusedCount });
}

async function configureContext(probeId: AdversarialProbeId): Promise<{ context: BrowserContext; page: Page }> {
  const browser = await chromium.launch({ headless: true });
  const lowEnd = probeId === "LOW_END_ANDROID";
  const context = await browser.newContext({
    viewport: lowEnd ? { width: 360, height: 740 } : { width: 390, height: 844 },
    deviceScaleFactor: lowEnd ? 1 : 2,
    isMobile: lowEnd,
    hasTouch: lowEnd,
    reducedMotion: probeId === "REDUCED_MOTION" ? "reduce" : "no-preference",
    locale: "es-MX",
    timezoneId: "America/Mexico_City",
  });
  const page = await context.newPage();
  page.once("close", () => void browser.close());
  return { context, page };
}

async function applyProbe(page: Page, context: BrowserContext, probeId: AdversarialProbeId): Promise<number> {
  if (probeId === "TEXT_DOUBLE") {
    await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const parent = node.parentElement;
        const text = node.nodeValue?.trim() ?? "";
        if (text.length >= 4 && parent && !["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) node.nodeValue = `${text} ${text}`;
      }
    });
  } else if (probeId === "TITLE_40") {
    await page.evaluate(() => {
      for (const heading of document.querySelectorAll<HTMLElement>("h1,h2,h3")) heading.innerText = "Título editorial de cuarenta caracteres".slice(0, 40);
    });
  } else if (probeId === "NO_MEDIA") {
    await page.addStyleTag({ content: "img,picture,video,canvas,svg{visibility:hidden!important}" });
  } else if (probeId === "VERTICAL_MEDIA") {
    await page.addStyleTag({ content: "img,video,picture{aspect-ratio:3/4!important;width:min(100%,480px)!important;height:auto!important;object-fit:cover!important}" });
  } else if (probeId === "ZOOM_200") {
    await page.addStyleTag({ content: "html{zoom:2!important}" });
  } else if (probeId === "THROTTLED_3G" || probeId === "LOW_END_ANDROID") {
    const session = await context.newCDPSession(page);
    if (probeId === "THROTTLED_3G") {
      await session.send("Network.enable");
      await session.send("Network.emulateNetworkConditions", { offline: false, latency: 300, downloadThroughput: 187500, uploadThroughput: 93750, connectionType: "cellular3g" });
    } else {
      await session.send("Emulation.setCPUThrottlingRate", { rate: 6 });
    }
  } else if (probeId === "REDUCED_MOTION") {
    await page.addStyleTag({ content: "@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:0.001ms!important;animation-iteration-count:1!important;transition-duration:0.001ms!important;scroll-behavior:auto!important}}" });
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
  const outputDir = resolve(input.outputDir);
  await mkdir(outputDir, { recursive: true });
  const artifacts: AdversarialProbeArtifact[] = [];

  for (const probeId of ADVERSARIAL_PROBES) {
    const { context, page } = await configureContext(probeId);
    try {
      await page.goto(input.targetUrl, { waitUntil: "networkidle", timeout: input.navigationTimeoutMs ?? 30_000 });
      const focusedCount = await applyProbe(page, context, probeId);
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
  return Object.freeze({ authority: "NEXUS_ADVERSARIAL_MATRIX_V1", targetUrl: input.targetUrl, artifacts: Object.freeze(artifacts) });
}
