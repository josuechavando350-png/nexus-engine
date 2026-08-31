import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectUrlWithSearchConsole } from "../url-inspection-adapter.js";

const clock = () => new Date("2026-08-31T05:00:00.000Z");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Search Console URL Inspection adapter", () => {
  it("returns UNAVAILABLE without credentials and never contacts Google", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const evidence = await inspectUrlWithSearchConsole({
      inspectionUrl: "https://example.com/page",
      siteUrl: "https://example.com/",
    }, { clock });
    expect(evidence.status).toBe("UNAVAILABLE");
    expect(evidence.reason).toMatch(/access token is not configured/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("parses a synthetic transport fixture without leaking the OAuth token", async () => {
    const token = "test-only-secret-token";
    const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      const requestBody = JSON.parse(String(init?.body)) as Record<string, string>;
      expect(requestBody).toEqual({ inspectionUrl: "https://example.com/page", languageCode: "en-US", siteUrl: "https://example.com/" });
      return new Response(JSON.stringify({
        inspectionResult: {
          inspectionResultLink: "https://search.google.com/search-console/inspect?resource_id=https://example.com/",
          indexStatusResult: {
            verdict: "PASS",
            coverageState: "Submitted and indexed",
            robotsTxtState: "ALLOWED",
            indexingState: "INDEXING_ALLOWED",
            lastCrawlTime: "2026-08-30T23:00:00Z",
            pageFetchState: "SUCCESSFUL",
            crawledAs: "MOBILE",
            googleCanonical: "https://example.com/page",
            userCanonical: "https://example.com/page",
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const evidence = await inspectUrlWithSearchConsole({
      inspectionUrl: "https://example.com/page",
      siteUrl: "https://example.com/",
    }, { accessToken: token, clock });

    expect(evidence.status).toBe("GOOGLE_API_OBSERVED");
    expect(evidence.source).toBe("GOOGLE_SEARCH_CONSOLE_API");
    expect(evidence.apiPayloadDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(evidence.htmlDigest).toBeNull();
    expect(evidence.screenshotDigest).toBeNull();
    expect(evidence.metadata).toMatchObject({ verdict: "PASS", crawledAs: "MOBILE", pageFetchState: "SUCCESSFUL" });
    expect(JSON.stringify(evidence)).not.toContain(token);
    expect(evidence.metadata?.evidenceMeaning).toMatch(/not a live URL render test/);
  });

  it("fails closed on authorization errors instead of fabricating Google evidence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("forbidden", { status: 403 })));
    const evidence = await inspectUrlWithSearchConsole({
      inspectionUrl: "https://example.com/page",
      siteUrl: "https://example.com/",
    }, { accessToken: "synthetic-test-token", clock });
    expect(evidence.status).toBe("UNAVAILABLE");
    expect(evidence.apiPayloadDigest).toBeNull();
    expect(evidence.reason).toContain("HTTP 403");
  });

  it("rejects tenant-target drift at the Search Console property boundary before network access", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(inspectUrlWithSearchConsole({
      inspectionUrl: "https://other.example.net/page",
      siteUrl: "https://example.com/",
    }, { accessToken: "synthetic-test-token", clock })).rejects.toThrow(/outside the Search Console URL-prefix property/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("bounds API response bytes before parsing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ inspectionResult: { padding: "x".repeat(4_096) } }), { status: 200 })));
    const evidence = await inspectUrlWithSearchConsole({
      inspectionUrl: "https://example.com/page",
      siteUrl: "https://example.com/",
    }, { accessToken: "synthetic-test-token", clock, maxResponseBytes: 256 });
    expect(evidence.status).toBe("UNAVAILABLE");
    expect(evidence.reason).toMatch(/exceeds 256 bytes/);
    expect(evidence.apiPayloadDigest).toBeNull();
  });
});
