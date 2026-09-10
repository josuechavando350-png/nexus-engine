import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";

export class SeoAuditPlaywrightAdapterError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "NAVIGATION_DENIED" | "NAVIGATION_FAILURE" | "INTERACTION_DENIED" | "INTERACTION_FAILURE" | "BOUNDS_EXCEEDED",
    message: string,
  ) {
    super(message);
    this.name = "SeoAuditPlaywrightAdapterError";
  }
}

export interface SeoAuditPlaywrightLauncher {
  launch(): Promise<Browser>;
}

export interface SeoAuditBrowserInspectRequestLike {
  readonly url: string;
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly canonicalOrigin: string;
}

export type SeoAuditTypingActionLike =
  | Readonly<{ type: "WAIT"; ms: number }>
  | Readonly<{ type: "TYPE"; value: string }>
  | Readonly<{ type: "BACKSPACE" }>;

export interface SeoAuditTypingSimulationRequestLike {
  readonly url: string;
  readonly canonicalOrigin: string;
  readonly selector: string;
  readonly timeoutMs: number;
  readonly pointerSeed: number;
  readonly pointerSteps: number;
  readonly plan: readonly SeoAuditTypingActionLike[];
}

const defaultLauncher: SeoAuditPlaywrightLauncher = Object.freeze({ launch: () => chromium.launch({ headless: true }) });

function assertOrigin(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new SeoAuditPlaywrightAdapterError("INVALID_INPUT", "canonicalOrigin must be an absolute HTTPS origin"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new SeoAuditPlaywrightAdapterError("INVALID_INPUT", "canonicalOrigin must be an HTTPS origin");
  }
  return parsed.origin;
}

function assertFirstPartyUrl(value: string, origin: string): URL {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new SeoAuditPlaywrightAdapterError("INVALID_INPUT", "browser URL must be absolute"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.origin !== origin) {
    throw new SeoAuditPlaywrightAdapterError("NAVIGATION_DENIED", "SEO audit browser is restricted to the configured first-party HTTPS origin");
  }
  parsed.hash = "";
  return parsed;
}

function validateTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 30_000) throw new SeoAuditPlaywrightAdapterError("INVALID_INPUT", "browser timeout must be between 1000 and 30000 ms");
}

async function installReadOnlyFirstPartyBoundary(page: Page, origin: string): Promise<void> {
  await page.route("**/*", async (route: Route) => {
    const request = route.request();
    let requestUrl: URL;
    try { requestUrl = new URL(request.url()); } catch { await route.abort("blockedbyclient"); return; }
    const method = request.method().toUpperCase();
    if (requestUrl.protocol !== "https:" || requestUrl.origin !== origin || (method !== "GET" && method !== "HEAD")) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
}

function seeded(seed: number): () => number {
  if (!Number.isSafeInteger(seed)) throw new SeoAuditPlaywrightAdapterError("INVALID_INPUT", "pointer seed must be a safe integer");
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pointerPath(endX: number, endY: number, steps: number, seed: number): readonly Readonly<{ x: number; y: number }>[] {
  if (!Number.isFinite(endX) || !Number.isFinite(endY) || !Number.isSafeInteger(steps) || steps < 2 || steps > 120) {
    throw new SeoAuditPlaywrightAdapterError("INVALID_INPUT", "pointer trajectory is invalid");
  }
  const random = seeded(seed);
  const controlX = endX * (0.1 + random() * 0.8) + Math.floor(random() * 81) - 40;
  const controlY = endY * (0.1 + random() * 0.8) + Math.floor(random() * 81) - 40;
  const points: Array<Readonly<{ x: number; y: number }>> = [];
  for (let index = 0; index < steps; index += 1) {
    const t = index / (steps - 1);
    points.push(Object.freeze({ x: Math.round(2 * (1 - t) * t * controlX + t ** 2 * endX), y: Math.round(2 * (1 - t) * t * controlY + t ** 2 * endY) }));
  }
  return Object.freeze(points);
}

export class PlaywrightSeoAuditBrowserAdapter {
  constructor(private readonly launcher: SeoAuditPlaywrightLauncher = defaultLauncher) {
    if (!launcher || typeof launcher.launch !== "function") throw new SeoAuditPlaywrightAdapterError("INVALID_INPUT", "Playwright launcher is invalid");
  }

  async inspect(input: SeoAuditBrowserInspectRequestLike) {
    if (!input || typeof input.userAgent !== "string" || !input.userAgent.trim()) throw new SeoAuditPlaywrightAdapterError("INVALID_INPUT", "SEO audit browser request is invalid");
    validateTimeout(input.timeoutMs);
    const origin = assertOrigin(input.canonicalOrigin);
    const initial = assertFirstPartyUrl(input.url, origin);
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    const startedAt = Date.now();
    try {
      browser = await this.launcher.launch();
      context = await browser.newContext({ userAgent: input.userAgent, acceptDownloads: false, serviceWorkers: "block", javaScriptEnabled: true });
      const page = await context.newPage();
      await installReadOnlyFirstPartyBoundary(page, origin);
      const response = await page.goto(initial.toString(), { waitUntil: "domcontentloaded", timeout: input.timeoutMs });
      if (!response) throw new SeoAuditPlaywrightAdapterError("NAVIGATION_FAILURE", "SEO audit navigation returned no main response");
      const finalUrl = assertFirstPartyUrl(page.url(), origin);
      const snapshot = await page.evaluate(() => {
        const meta = (name: string) => document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? null;
        const headings = Array.from(document.querySelectorAll<HTMLHeadingElement>("h1,h2,h3,h4,h5,h6")).slice(0, 512).map((heading) => ({ level: Number.parseInt(heading.tagName.slice(1), 10), text: (heading.textContent ?? "").trim().slice(0, 2_000) }));
        const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).slice(0, 2_000).map((anchor) => ({ href: anchor.href, rel: anchor.rel ?? "", text: (anchor.textContent ?? "").trim().slice(0, 1_000) }));
        const images = Array.from(document.querySelectorAll<HTMLImageElement>("img")).slice(0, 2_000).map((image) => ({ src: image.currentSrc || image.src, alt: image.hasAttribute("alt") ? image.getAttribute("alt") : null }));
        const jsonLdBlocks = Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')).slice(0, 64).map((node) => node.textContent ?? "");
        const robotValues = [meta("robots"), meta("googlebot")].filter((value): value is string => Boolean(value));
        return {
          title: document.title ?? "",
          description: meta("description"),
          canonical: document.querySelector<HTMLLinkElement>('link[rel~="canonical"]')?.href ?? null,
          robotsMeta: robotValues.length > 0 ? robotValues.join(",") : null,
          language: document.documentElement.lang || null,
          headings,
          links,
          images,
          jsonLdBlocks,
          textLength: (document.body?.innerText ?? "").trim().length,
        };
      });
      return Object.freeze({
        requestedUrl: initial.toString(),
        finalUrl: finalUrl.toString(),
        status: response.status(),
        title: snapshot.title.slice(0, 2_000),
        description: snapshot.description?.slice(0, 4_000) ?? null,
        canonical: snapshot.canonical?.slice(0, 8_000) ?? null,
        robotsMeta: snapshot.robotsMeta?.slice(0, 2_000) ?? null,
        xRobotsTag: response.headers()["x-robots-tag"]?.slice(0, 2_000) ?? null,
        language: snapshot.language?.slice(0, 128) ?? null,
        headings: Object.freeze(snapshot.headings.map((heading) => Object.freeze({ level: heading.level as 1 | 2 | 3 | 4 | 5 | 6, text: heading.text }))),
        links: Object.freeze(snapshot.links.map((link) => Object.freeze(link))),
        images: Object.freeze(snapshot.images.map((image) => Object.freeze(image))),
        jsonLdBlocks: Object.freeze(snapshot.jsonLdBlocks.map((block) => block.slice(0, 512 * 1024))),
        textLength: snapshot.textLength,
        responseTimeMs: Date.now() - startedAt,
      });
    } catch (error) {
      if (error instanceof SeoAuditPlaywrightAdapterError) throw error;
      throw new SeoAuditPlaywrightAdapterError("NAVIGATION_FAILURE", `Playwright SEO audit failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      if (context) await context.close().catch(() => undefined);
      if (browser) await browser.close().catch(() => undefined);
    }
  }

  async simulateTyping(input: SeoAuditTypingSimulationRequestLike) {
    if (!input || typeof input.selector !== "string" || !input.selector.trim() || input.selector.length > 256 || !Array.isArray(input.plan) || input.plan.length === 0 || input.plan.length > 10_000) {
      throw new SeoAuditPlaywrightAdapterError("INVALID_INPUT", "UX typing simulation request is invalid");
    }
    validateTimeout(input.timeoutMs);
    const origin = assertOrigin(input.canonicalOrigin);
    const initial = assertFirstPartyUrl(input.url, origin);
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    const startedAt = Date.now();
    let typedCharacters = 0;
    let corrections = 0;
    try {
      browser = await this.launcher.launch();
      context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block", javaScriptEnabled: true });
      const page = await context.newPage();
      await installReadOnlyFirstPartyBoundary(page, origin);
      const response = await page.goto(initial.toString(), { waitUntil: "domcontentloaded", timeout: input.timeoutMs });
      if (!response) throw new SeoAuditPlaywrightAdapterError("NAVIGATION_FAILURE", "UX telemetry navigation returned no main response");
      const finalUrl = assertFirstPartyUrl(page.url(), origin);
      const locator = page.locator(input.selector).first();
      if (!(await locator.isVisible()) || !(await locator.isEditable())) throw new SeoAuditPlaywrightAdapterError("INTERACTION_DENIED", "UX telemetry target must be a visible editable first-party control");
      const box = await locator.boundingBox();
      if (!box) throw new SeoAuditPlaywrightAdapterError("INTERACTION_DENIED", "UX telemetry target has no visible bounding box");
      for (const point of pointerPath(box.x + box.width / 2, box.y + box.height / 2, input.pointerSteps, input.pointerSeed)) await page.mouse.move(point.x, point.y);
      await locator.focus();
      for (const action of input.plan) {
        if (action.type === "WAIT") {
          if (!Number.isSafeInteger(action.ms) || action.ms < 0 || action.ms > 5_000) throw new SeoAuditPlaywrightAdapterError("BOUNDS_EXCEEDED", "UX telemetry wait is outside bounds");
          await page.waitForTimeout(action.ms);
        } else if (action.type === "TYPE") {
          if (typeof action.value !== "string" || action.value.length < 1 || action.value.length > 8) throw new SeoAuditPlaywrightAdapterError("BOUNDS_EXCEEDED", "UX telemetry key chunk is outside bounds");
          await page.keyboard.type(action.value);
          typedCharacters += action.value.length;
        } else if (action.type === "BACKSPACE") {
          await page.keyboard.press("Backspace");
          corrections += 1;
        } else {
          throw new SeoAuditPlaywrightAdapterError("INVALID_INPUT", "UX telemetry action is unsupported");
        }
      }
      return Object.freeze({ url: finalUrl.toString(), selector: input.selector, typedCharacters, corrections, elapsedMs: Date.now() - startedAt, submitted: false as const });
    } catch (error) {
      if (error instanceof SeoAuditPlaywrightAdapterError) throw error;
      throw new SeoAuditPlaywrightAdapterError("INTERACTION_FAILURE", `Playwright UX telemetry failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      if (context) await context.close().catch(() => undefined);
      if (browser) await browser.close().catch(() => undefined);
    }
  }
}
