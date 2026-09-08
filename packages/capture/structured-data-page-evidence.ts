import { chromium, type Browser, type BrowserContext, type Page, type Response, type Route } from "playwright";

export class StructuredDataPageEvidenceError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "NAVIGATION_DENIED" | "NAVIGATION_FAILURE" | "BOUNDS_EXCEEDED",
    message: string,
  ) {
    super(message);
    this.name = "StructuredDataPageEvidenceError";
  }
}

export interface StructuredDataRenderedPageEvidence {
  readonly pageUrl: string;
  readonly finalUrl: string;
  readonly capturedAt: string;
  readonly source: "PLAYWRIGHT_RENDERED_DOM";
  readonly textContent: string;
}

export interface StructuredDataPageEvidenceRequest {
  readonly pageUrl: string;
  readonly timeoutMs?: number;
  readonly maxTextBytes?: number;
}

export interface StructuredDataBrowserLauncher {
  launch(): Promise<Browser>;
}

const defaultLauncher: StructuredDataBrowserLauncher = Object.freeze({
  launch: () => chromium.launch({ headless: true }),
});

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_TEXT_BYTES = 512 * 1024;

function canonicalPage(value: string, origin?: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new StructuredDataPageEvidenceError("INVALID_INPUT", "structured-data page URL must be absolute"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new StructuredDataPageEvidenceError("INVALID_INPUT", "structured-data page URL must be canonical HTTPS without credentials, query, or fragment");
  }
  if (origin !== undefined && url.origin !== origin) {
    throw new StructuredDataPageEvidenceError("NAVIGATION_DENIED", "structured-data page must remain on the configured publisher origin");
  }
  return url;
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export class PlaywrightStructuredDataPageEvidenceClient {
  private readonly origin: string;

  constructor(
    publisherWebsiteOrigin: string,
    private readonly launcher: StructuredDataBrowserLauncher = defaultLauncher,
    private readonly now: () => number = Date.now,
  ) {
    const origin = canonicalPage(`${publisherWebsiteOrigin.replace(/\/+$/u, "")}/`);
    if (origin.pathname !== "/") throw new StructuredDataPageEvidenceError("INVALID_INPUT", "publisherWebsiteOrigin must be an origin");
    if (!launcher || typeof launcher.launch !== "function") throw new StructuredDataPageEvidenceError("INVALID_INPUT", "Playwright launcher is invalid");
    this.origin = origin.origin;
  }

  async capture(input: StructuredDataPageEvidenceRequest | string): Promise<StructuredDataRenderedPageEvidence> {
    const request = typeof input === "string" ? { pageUrl: input } : input;
    if (!request || typeof request !== "object") throw new StructuredDataPageEvidenceError("INVALID_INPUT", "structured-data page evidence request is required");
    const pageUrl = canonicalPage(request.pageUrl, this.origin);
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxTextBytes = request.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
      throw new StructuredDataPageEvidenceError("INVALID_INPUT", "timeoutMs must be 1000..30000");
    }
    if (!Number.isSafeInteger(maxTextBytes) || maxTextBytes < 1_024 || maxTextBytes > 2 * 1024 * 1024) {
      throw new StructuredDataPageEvidenceError("INVALID_INPUT", "maxTextBytes must be 1024..2097152");
    }

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    try {
      browser = await this.launcher.launch();
      context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block", javaScriptEnabled: true });
      const page: Page = await context.newPage();
      await page.route("**/*", async (route: Route) => {
        let requestUrl: URL;
        try { requestUrl = new URL(route.request().url()); }
        catch { await route.abort("blockedbyclient"); return; }
        if (requestUrl.protocol === "data:") {
          await route.continue();
          return;
        }
        if (requestUrl.protocol === "blob:") {
          if (requestUrl.origin === this.origin) await route.continue();
          else await route.abort("blockedbyclient");
          return;
        }
        if ((requestUrl.protocol !== "https:" && requestUrl.protocol !== "http:") || requestUrl.origin !== this.origin) {
          await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
      });
      const response: Response | null = await page.goto(pageUrl.href, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      if (!response) throw new StructuredDataPageEvidenceError("NAVIGATION_FAILURE", "Playwright navigation returned no main response");
      if (response.status() >= 400) throw new StructuredDataPageEvidenceError("NAVIGATION_FAILURE", `structured-data page returned HTTP ${response.status()}`);
      const finalUrl = canonicalPage(page.url(), this.origin);
      if (finalUrl.href !== pageUrl.href) throw new StructuredDataPageEvidenceError("NAVIGATION_DENIED", "structured-data evidence requires the canonical final URL to equal the requested page URL");
      const textContent = normalizedText(await page.locator("body").innerText({ timeout: timeoutMs }));
      if (!textContent) throw new StructuredDataPageEvidenceError("NAVIGATION_FAILURE", "rendered page has no visible body text");
      if (new TextEncoder().encode(textContent).byteLength > maxTextBytes) {
        throw new StructuredDataPageEvidenceError("BOUNDS_EXCEEDED", "rendered page text exceeds the configured byte bound");
      }
      const capturedAtMs = this.now();
      if (!Number.isFinite(capturedAtMs)) throw new StructuredDataPageEvidenceError("NAVIGATION_FAILURE", "page evidence clock returned a non-finite value");
      return Object.freeze({
        pageUrl: pageUrl.href,
        finalUrl: finalUrl.href,
        capturedAt: new Date(capturedAtMs).toISOString(),
        source: "PLAYWRIGHT_RENDERED_DOM" as const,
        textContent,
      });
    } catch (error) {
      if (error instanceof StructuredDataPageEvidenceError) throw error;
      throw new StructuredDataPageEvidenceError("NAVIGATION_FAILURE", `Playwright structured-data evidence capture failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      if (context) await context.close().catch(() => undefined);
      if (browser) await browser.close().catch(() => undefined);
    }
  }
}
