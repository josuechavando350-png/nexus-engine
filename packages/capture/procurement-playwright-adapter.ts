import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";

export class ProcurementPlaywrightAdapterError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "NAVIGATION_DENIED" | "NAVIGATION_FAILURE" | "BOUNDS_EXCEEDED", message: string) {
    super(message);
    this.name = "ProcurementPlaywrightAdapterError";
  }
}

export interface ProcurementBrowserPageResult {
  readonly finalUrl: string;
  readonly status: number;
  readonly title: string;
  readonly text: string;
  readonly links: readonly string[];
}

export interface ProcurementBrowserPageRequest {
  readonly tenantId: string;
  readonly url: string;
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly maxTextBytes: number;
  readonly authorizeUrl: (url: URL) => Promise<void>;
}

export interface PlaywrightBrowserLauncher {
  launch(): Promise<Browser>;
}

const defaultLauncher: PlaywrightBrowserLauncher = Object.freeze({
  launch: () => chromium.launch({ headless: true }),
});

function assertRequest(input: ProcurementBrowserPageRequest): URL {
  if (!input || typeof input.tenantId !== "string" || !input.tenantId.trim() || typeof input.userAgent !== "string" || !input.userAgent.trim() ||
    !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > 30_000 ||
    !Number.isSafeInteger(input.maxTextBytes) || input.maxTextBytes < 1_024 || input.maxTextBytes > 4 * 1024 * 1024 || typeof input.authorizeUrl !== "function") {
    throw new ProcurementPlaywrightAdapterError("INVALID_INPUT", "procurement browser request is invalid");
  }
  const url = new URL(input.url);
  if (url.protocol !== "https:" || url.username || url.password) throw new ProcurementPlaywrightAdapterError("INVALID_INPUT", "procurement browser URL must be HTTPS without credentials");
  return url;
}

export class PlaywrightPublicProcurementBrowserAdapter {
  constructor(private readonly launcher: PlaywrightBrowserLauncher = defaultLauncher) {
    if (!launcher || typeof launcher.launch !== "function") throw new ProcurementPlaywrightAdapterError("INVALID_INPUT", "Playwright launcher is invalid");
  }

  async fetchPublicPage(input: ProcurementBrowserPageRequest): Promise<ProcurementBrowserPageResult> {
    const initial = assertRequest(input);
    await input.authorizeUrl(initial);
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    try {
      browser = await this.launcher.launch();
      context = await browser.newContext({
        userAgent: input.userAgent,
        acceptDownloads: false,
        serviceWorkers: "block",
        javaScriptEnabled: true,
      });
      const page: Page = await context.newPage();
      await page.route("**/*", async (route: Route) => {
        const requestUrl = new URL(route.request().url());
        if ((requestUrl.protocol !== "https:" && requestUrl.protocol !== "http:") || requestUrl.origin !== initial.origin) {
          await route.abort("blockedbyclient");
          return;
        }
        try {
          await input.authorizeUrl(requestUrl);
          await route.continue();
        } catch {
          await route.abort("blockedbyclient");
        }
      });
      const response = await page.goto(initial.toString(), { waitUntil: "domcontentloaded", timeout: input.timeoutMs });
      if (!response) throw new ProcurementPlaywrightAdapterError("NAVIGATION_FAILURE", "Playwright navigation returned no main response");
      const finalUrl = new URL(page.url());
      if (finalUrl.origin !== initial.origin) throw new ProcurementPlaywrightAdapterError("NAVIGATION_DENIED", "cross-origin redirect is forbidden for procurement crawling");
      await input.authorizeUrl(finalUrl);
      const snapshot = await page.evaluate(() => ({
        title: document.title ?? "",
        text: document.body?.innerText ?? "",
        links: Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).slice(0, 512).map((anchor) => anchor.href),
      }));
      const bytes = new TextEncoder().encode(snapshot.text).byteLength;
      if (bytes > input.maxTextBytes) throw new ProcurementPlaywrightAdapterError("BOUNDS_EXCEEDED", "procurement page text exceeds the configured byte bound");
      return Object.freeze({ finalUrl: finalUrl.toString(), status: response.status(), title: snapshot.title.slice(0, 2_000), text: snapshot.text, links: Object.freeze(snapshot.links.slice(0, 256)) });
    } catch (error) {
      if (error instanceof ProcurementPlaywrightAdapterError) throw error;
      throw new ProcurementPlaywrightAdapterError("NAVIGATION_FAILURE", `Playwright procurement crawl failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      if (context) await context.close().catch(() => undefined);
      if (browser) await browser.close().catch(() => undefined);
    }
  }
}
