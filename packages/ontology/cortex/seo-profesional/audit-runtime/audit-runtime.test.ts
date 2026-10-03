import { describe, expect, it, vi } from "vitest";
import type {
  SeoAuditBrowserPort,
  SeoAuditClockPort,
  SeoAuditHttpPort,
  SeoAuditHttpResponse,
  SeoAuditPageSnapshot,
  SeoAuditTypingSimulationRequest,
} from "./contracts.js";
import { buildBezierPointerPath, buildFatigueTypingPlan } from "./human-telemetry.js";
import { SeoProfessionalAuditRuntime } from "./runtime.js";

const ORIGIN = "https://example.test";

function response(url: string, status: number, body: string): SeoAuditHttpResponse {
  return Object.freeze({ status, url, headers: Object.freeze({ "content-type": "text/plain" }), text: async () => body });
}

function snapshot(url: string, overrides: Partial<SeoAuditPageSnapshot> = {}): SeoAuditPageSnapshot {
  return Object.freeze({
    requestedUrl: url,
    finalUrl: url,
    status: 200,
    title: "A useful first-party SEO audit page title",
    description: "A sufficiently descriptive summary for a first-party SEO audit page that communicates intent clearly to search users.",
    canonical: url,
    robotsMeta: "index,follow",
    xRobotsTag: null,
    language: "es-MX",
    headings: Object.freeze([{ level: 1 as const, text: "Audit page" }]),
    links: Object.freeze([]),
    images: Object.freeze([]),
    jsonLdBlocks: Object.freeze([]),
    textLength: 800,
    responseTimeMs: 120,
    ...overrides,
  });
}

function runtime(input?: { robots?: string; sitemap?: string; browser?: SeoAuditBrowserPort }) {
  const http: SeoAuditHttpPort = Object.freeze({
    fetch: vi.fn(async (url: string) => {
      if (url === `${ORIGIN}/robots.txt`) return response(url, 200, input?.robots ?? "User-agent: *\nAllow: /\nSitemap: https://example.test/sitemap.xml\n");
      if (url === `${ORIGIN}/sitemap.xml`) return response(url, 200, input?.sitemap ?? "<urlset><url><loc>https://example.test/</loc></url></urlset>");
      return response(url, 404, "");
    }),
  });
  const browser: SeoAuditBrowserPort = input?.browser ?? Object.freeze({ inspect: vi.fn(async ({ url }: { url: string }) => snapshot(url)) });
  let now = 1_000;
  const clock: SeoAuditClockPort = Object.freeze({ now: () => now, sleep: async (ms: number) => { now += ms; } });
  return new SeoProfessionalAuditRuntime({
    config: { canonicalOrigin: ORIGIN, userAgent: "NexusSeoAuditBot", maxPages: 10, maxDepth: 2, requestTimeoutMs: 5_000, minDelayMs: 0, maxDelayMs: 0 },
    http,
    browser,
    clock,
  });
}

describe("SeoProfessionalAuditRuntime", () => {
  it("is disabled by default and requires explicit activation", async () => {
    const audit = runtime();
    expect(audit.snapshot().active).toBe(false);
    await expect(audit.run({ startUrls: [`${ORIGIN}/`] })).rejects.toMatchObject({ code: "NOT_ACTIVE" });
    const receipt = audit.activate({ requestedBy: "operator", reason: "technical SEO review" });
    expect(receipt.activationId).toContain("seo-audit-");
    expect(audit.snapshot().active).toBe(true);
    audit.deactivate();
    expect(audit.snapshot().active).toBe(false);
  });

  it("crawls only the first-party origin, uses sitemap seeds, and reports metadata/indexability", async () => {
    const inspect = vi.fn(async ({ url }: { url: string }) => {
      if (url === `${ORIGIN}/`) {
        return snapshot(url, { title: "", canonical: null, links: Object.freeze([
          { href: `${ORIGIN}/about`, rel: "", text: "About" },
          { href: "https://third-party.test/out", rel: "", text: "External" },
        ]) });
      }
      return snapshot(url);
    });
    const audit = runtime({
      sitemap: "<urlset><url><loc>https://example.test/</loc></url><url><loc>https://example.test/contact</loc></url></urlset>",
      browser: Object.freeze({ inspect }),
    });
    audit.activate({ requestedBy: "operator", reason: "crawl/indexability test" });
    const report = await audit.run({ startUrls: [`${ORIGIN}/`] });
    expect(report.summary.crawledPages).toBe(3);
    expect(report.pages.map((page) => page.url)).toEqual(expect.arrayContaining([`${ORIGIN}/`, `${ORIGIN}/contact`, `${ORIGIN}/about`]));
    expect(report.issues.some((item) => item.code === "TITLE_MISSING")).toBe(true);
    expect(report.issues.some((item) => item.code === "CANONICAL_MISSING")).toBe(true);
    expect(inspect.mock.calls.flat().join(" ")).not.toContain("third-party.test");
  });

  it("respects robots.txt and does not inspect disallowed paths", async () => {
    const inspect = vi.fn(async ({ url }: { url: string }) => snapshot(url));
    const audit = runtime({ robots: "User-agent: NexusSeoAuditBot\nDisallow: /private\nAllow: /\n", sitemap: "<urlset></urlset>", browser: Object.freeze({ inspect }) });
    audit.activate({ requestedBy: "operator", reason: "robots contract test" });
    const report = await audit.run({ startUrls: [`${ORIGIN}/private`] });
    expect(inspect).not.toHaveBeenCalled();
    expect(report.summary.crawledPages).toBe(0);
    expect(report.issues.some((item) => item.code === "ROBOTS_DISALLOW")).toBe(true);
  });

  it("runs bounded UX typing telemetry without submitting forms", async () => {
    let received: SeoAuditTypingSimulationRequest | null = null;
    const browser: SeoAuditBrowserPort = Object.freeze({
      inspect: vi.fn(async ({ url }: { url: string }) => snapshot(url)),
      simulateTyping: vi.fn(async (request: SeoAuditTypingSimulationRequest) => {
        received = request;
        return Object.freeze({
          url: request.url,
          selector: request.selector,
          typedCharacters: request.plan.filter((action) => action.type === "TYPE").length,
          corrections: request.plan.filter((action) => action.type === "BACKSPACE").length,
          elapsedMs: 500,
          submitted: false as const,
        });
      }),
    });
    const audit = runtime({ browser });
    audit.activate({ requestedBy: "operator", reason: "first-party UX fatigue telemetry" });
    const report = await audit.run({
      startUrls: [`${ORIGIN}/`],
      uxScenarios: [{ url: `${ORIGIN}/contact`, selector: "#message", text: "Hola Nexus", seed: 42, profile: { correctionRate: 0, minKeyDelayMs: 10, maxKeyDelayMs: 20 } }],
    });
    expect(received).not.toBeNull();
    expect(received!.plan.some((action) => action.type === "WAIT")).toBe(true);
    expect(report.uxTelemetry).toHaveLength(1);
    expect(report.uxTelemetry[0]?.submitted).toBe(false);
  });
});

describe("UX telemetry planning", () => {
  it("produces deterministic timing plans and bounded Bézier paths", () => {
    const left = buildFatigueTypingPlan("abc", 7, { correctionRate: 0, minKeyDelayMs: 10, maxKeyDelayMs: 20 });
    const right = buildFatigueTypingPlan("abc", 7, { correctionRate: 0, minKeyDelayMs: 10, maxKeyDelayMs: 20 });
    expect(left).toEqual(right);
    const path = buildBezierPointerPath({ x: 0, y: 0 }, { x: 100, y: 50 }, 10, 9);
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path.at(-1)).toEqual({ x: 100, y: 50 });
  });
});
