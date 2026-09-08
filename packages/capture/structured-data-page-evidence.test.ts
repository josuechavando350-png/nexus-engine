import { describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext, Locator, Page, Response, Route } from "playwright";
import { PlaywrightStructuredDataPageEvidenceClient } from "./structured-data-page-evidence.js";

function fakeBrowser(finalUrl = "https://example.test/about", text = "Nexus Example Empresa") {
  let routeHandler: ((route: Route) => Promise<void>) | undefined;
  const triggerRoute = async (url: string) => {
    const continued = vi.fn(async () => undefined);
    const aborted = vi.fn(async () => undefined);
    const fakeRoute = {
      request: () => ({ url: () => url }),
      continue: continued,
      abort: aborted,
    } as unknown as Route;
    await routeHandler?.(fakeRoute);
    return { continued, aborted };
  };
  const page = {
    route: vi.fn(async (_pattern: string, handler: (route: Route) => Promise<void>) => { routeHandler = handler; }),
    goto: vi.fn(async (url: string) => {
      await triggerRoute(url);
      return { status: () => 200 } as unknown as Response;
    }),
    url: vi.fn(() => finalUrl),
    locator: vi.fn(() => ({ innerText: vi.fn(async () => text) } as unknown as Locator)),
  } as unknown as Page;
  const closeContext = vi.fn(async () => undefined);
  const context = { newPage: vi.fn(async () => page), close: closeContext } as unknown as BrowserContext;
  const closeBrowser = vi.fn(async () => undefined);
  const browser = { newContext: vi.fn(async () => context), close: closeBrowser } as unknown as Browser;
  return { browser, closeContext, closeBrowser, triggerRoute };
}

describe("PlaywrightStructuredDataPageEvidenceClient", () => {
  it("captures bounded rendered first-party text in a fresh browser context", async () => {
    const fake = fakeBrowser();
    const client = new PlaywrightStructuredDataPageEvidenceClient("https://example.test", { launch: vi.fn(async () => fake.browser) }, () => Date.parse("2026-09-08T18:30:00.000Z"));
    await expect(client.capture("https://example.test/about")).resolves.toEqual({
      pageUrl: "https://example.test/about",
      finalUrl: "https://example.test/about",
      capturedAt: "2026-09-08T18:30:00.000Z",
      source: "PLAYWRIGHT_RENDERED_DOM",
      textContent: "Nexus Example Empresa",
    });
    expect(fake.closeContext).toHaveBeenCalledOnce();
    expect(fake.closeBrowser).toHaveBeenCalledOnce();
  });

  it("blocks blob resources whose embedded origin is not the verified publisher", async () => {
    const fake = fakeBrowser();
    const client = new PlaywrightStructuredDataPageEvidenceClient("https://example.test", { launch: vi.fn(async () => fake.browser) });
    await client.capture("https://example.test/about");
    const route = await fake.triggerRoute("blob:https://other.example/8b31a8e0");
    expect(route.aborted).toHaveBeenCalledWith("blockedbyclient");
    expect(route.continued).not.toHaveBeenCalled();
  });

  it("fails closed on cross-origin redirects", async () => {
    const fake = fakeBrowser("https://other.example/about");
    const client = new PlaywrightStructuredDataPageEvidenceClient("https://example.test", { launch: vi.fn(async () => fake.browser) });
    await expect(client.capture("https://example.test/about")).rejects.toMatchObject({ code: "NAVIGATION_DENIED" });
  });
});
