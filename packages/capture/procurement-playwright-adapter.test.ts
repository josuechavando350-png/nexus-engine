import { describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext, Page, Response, Route } from "playwright";
import { PlaywrightPublicProcurementBrowserAdapter } from "./procurement-playwright-adapter.js";

function fakeBrowser() {
  let routeHandler: ((route: Route) => Promise<void>) | undefined;
  const route = vi.fn(async (_pattern: string, handler: (route: Route) => Promise<void>) => { routeHandler = handler; });
  const page = {
    route,
    goto: vi.fn(async (url: string) => {
      const fakeRoute = {
        request: () => ({ url: () => url }),
        continue: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
      } as unknown as Route;
      await routeHandler?.(fakeRoute);
      return { status: () => 200 } as unknown as Response;
    }),
    url: vi.fn(() => "https://compras.example/rfp/1"),
    evaluate: vi.fn(async () => ({ title: "RFP pública", text: "seguridad administrada", links: ["https://compras.example/docs/a.pdf"] })),
  } as unknown as Page;
  const closeContext = vi.fn(async () => undefined);
  const context = { newPage: vi.fn(async () => page), close: closeContext } as unknown as BrowserContext;
  const closeBrowser = vi.fn(async () => undefined);
  const browser = { newContext: vi.fn(async () => context), close: closeBrowser } as unknown as Browser;
  return { browser, closeContext, closeBrowser };
}

describe("PlaywrightPublicProcurementBrowserAdapter", () => {
  it("creates and destroys a fresh BrowserContext for every tenant crawl and re-authorizes navigation URLs", async () => {
    const first = fakeBrowser();
    const second = fakeBrowser();
    const launch = vi.fn().mockResolvedValueOnce(first.browser).mockResolvedValueOnce(second.browser);
    const authorizeUrl = vi.fn(async () => undefined);
    const adapter = new PlaywrightPublicProcurementBrowserAdapter({ launch });
    for (const tenantId of ["tenant-one", "tenant-two"]) {
      const result = await adapter.fetchPublicPage({ tenantId, url: "https://compras.example/rfp/1", userAgent: "NexusProcurementBot", timeoutMs: 5_000, maxTextBytes: 64 * 1024, authorizeUrl });
      expect(result.status).toBe(200);
    }
    expect(launch).toHaveBeenCalledTimes(2);
    expect(first.closeContext).toHaveBeenCalledOnce();
    expect(second.closeContext).toHaveBeenCalledOnce();
    expect(authorizeUrl.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
});
