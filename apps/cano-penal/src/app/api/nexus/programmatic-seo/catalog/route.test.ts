import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { POST } from "./route";

const TOKEN = "catalog-token-0000000000000000000000000000";
const URL = "https://canopenal.com/api/nexus/programmatic-seo/catalog";

function request(body: string, token = TOKEN, contentType = "application/json"): Request {
  return new Request(URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": contentType },
    body,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("CANO approved programmatic SEO catalog endpoint", () => {
  it("fails closed when the catalog token is absent and rejects wrong credentials", async () => {
    expect((await POST(request(JSON.stringify({ siteId: "cano-penal" })))).status).toBe(503);
    vi.stubEnv("NEXUS_CORTEX_PROGRAMMATIC_SEO_CATALOG_TOKEN", TOKEN);
    expect((await POST(request(JSON.stringify({ siteId: "cano-penal" }), "x".repeat(40)))).status).toBe(401);
  });

  it("returns only the approved CANO catalog with a fresh observation timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T04:30:00.000Z"));
    vi.stubEnv("NEXUS_CORTEX_PROGRAMMATIC_SEO_CATALOG_TOKEN", TOKEN);
    const response = await POST(request(JSON.stringify({ siteId: "cano-penal" })));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      sourceId: "cano-approved-repository-content",
      siteId: "cano-penal",
      baseUrl: "https://canopenal.com/",
      observedAt: "2026-09-06T04:30:00.000Z",
    });
    const pages = body.pages as Array<Record<string, unknown>>;
    expect(pages).toHaveLength(9);
    expect(pages.map((page) => page.pageId)).toContain("delitos-fiscales-y-financieros");
    expect(pages.every((page) => Array.isArray(page.evidenceRefs) && (page.evidenceRefs as unknown[]).length > 0)).toBe(true);
  });

  it("requires the exact request contract and enforces the streaming body bound", async () => {
    vi.stubEnv("NEXUS_CORTEX_PROGRAMMATIC_SEO_CATALOG_TOKEN", TOKEN);
    expect((await POST(request(JSON.stringify({ siteId: "other" })))).status).toBe(400);
    expect((await POST(request(JSON.stringify({ siteId: "cano-penal", extra: true })))).status).toBe(400);
    expect((await POST(request(JSON.stringify({ siteId: "cano-penal" }), TOKEN, "text/plain"))).status).toBe(400);
    expect((await POST(request(JSON.stringify({ siteId: "cano-penal", padding: "x".repeat(5 * 1024) })))).status).toBe(400);
  });
});
