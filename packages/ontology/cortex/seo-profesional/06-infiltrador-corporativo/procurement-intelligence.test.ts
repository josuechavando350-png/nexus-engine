import { describe, expect, it, vi } from "vitest";
import { PublicProcurementIntelligenceEngine } from "./procurement-intelligence.js";
import { PublicProcurementUrlPolicy } from "./public-url-policy.js";

const ORIGIN = "https://compras.example";

function policy() {
  return new PublicProcurementUrlPolicy([ORIGIN], { resolve: async () => ["8.8.8.8"] });
}

function profile() {
  return { tenantId: "tenant-acme", canonicalWebsiteOrigin: "https://seller.example", capabilityPhrases: ["seguridad administrada", "respuesta incidentes"], minimumMatchScore: 0.5 } as const;
}

describe("PublicProcurementIntelligenceEngine", () => {
  it("uses OCDS before browser scraping and creates a first-party handoff only for matching opportunities", async () => {
    const browser = { fetchPublicPage: vi.fn(async () => { throw new Error("browser should not run for OCDS"); }) };
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { status: 200 });
      return new Response(JSON.stringify({ releases: [{ id: "r1", tender: { title: "Seguridad administrada y respuesta a incidentes", status: "active" } }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const engine = new PublicProcurementIntelligenceEngine({ profile: profile(), urlPolicy: policy(), browser, fetchImpl, now: () => Date.parse("2026-09-08T12:00:00.000Z") });
    const result = await engine.scan({ sourceId: "portal-ocds", kind: "OCDS_JSON", url: `${ORIGIN}/ocds.json` });
    expect(browser.fetchPublicPage).not.toHaveBeenCalled();
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.handoffUrl).toMatch(/^https:\/\/seller\.example\/procurement-opportunity\?opportunity=ocds_/u);
  });

  it("honors robots.txt before starting a browser context", async () => {
    const browser = { fetchPublicPage: vi.fn(async () => ({ finalUrl: `${ORIGIN}/private`, status: 200, title: "RFP", text: "seguridad administrada", links: [] })) };
    const fetchImpl: typeof fetch = vi.fn(async () => new Response("User-agent: *\nDisallow: /private\n", { status: 200 }));
    const engine = new PublicProcurementIntelligenceEngine({ profile: profile(), urlPolicy: policy(), browser, fetchImpl });
    await expect(engine.scan({ sourceId: "portal-html", kind: "PUBLIC_HTML", url: `${ORIGIN}/private` })).rejects.toThrow(/robots\.txt denies/u);
    expect(browser.fetchPublicPage).not.toHaveBeenCalled();
  });

  it("uses the browser port only for allowlisted public HTML and never emits third-party document links", async () => {
    const browser = { fetchPublicPage: vi.fn(async (input: { authorizeUrl: (url: URL) => Promise<void> }) => {
      await input.authorizeUrl(new URL(`${ORIGIN}/rfp/1`));
      return { finalUrl: `${ORIGIN}/rfp/1`, status: 200, title: "RFP seguridad administrada", text: "respuesta incidentes y seguridad administrada", links: [`${ORIGIN}/docs/rfp.pdf`, "https://tracking.example/doc"] };
    }) };
    const fetchImpl: typeof fetch = vi.fn(async () => new Response("User-agent: *\nAllow: /\n", { status: 200 }));
    const engine = new PublicProcurementIntelligenceEngine({ profile: profile(), urlPolicy: policy(), browser, fetchImpl, now: () => Date.parse("2026-09-08T12:00:00.000Z") });
    const result = await engine.scan({ sourceId: "portal-html", kind: "PUBLIC_HTML", url: `${ORIGIN}/rfp/1` });
    expect(result.opportunities[0]?.documentUrls).toEqual([`${ORIGIN}/docs/rfp.pdf`]);
    expect(result.matches).toHaveLength(1);
  });
  it("discovers a bounded same-origin notice set from an allowlisted public listing page", async () => {
    const pages = new Map([
      [`${ORIGIN}/tenders`, { finalUrl: `${ORIGIN}/tenders`, status: 200, title: "Licitaciones", text: "Listado", links: [`${ORIGIN}/tenders/1`, `${ORIGIN}/tenders/2`, "https://other.example/tenders/3"] }],
      [`${ORIGIN}/tenders/1`, { finalUrl: `${ORIGIN}/tenders/1`, status: 200, title: "Seguridad administrada", text: "respuesta incidentes", links: [] }],
      [`${ORIGIN}/tenders/2`, { finalUrl: `${ORIGIN}/tenders/2`, status: 200, title: "Papelería", text: "suministro oficina", links: [] }],
    ]);
    const browser = { fetchPublicPage: vi.fn(async (input: { url: string }) => pages.get(input.url)!) };
    const fetchImpl: typeof fetch = vi.fn(async () => new Response("User-agent: *\nAllow: /tenders\n", { status: 200 }));
    const engine = new PublicProcurementIntelligenceEngine({ profile: profile(), urlPolicy: policy(), browser, fetchImpl, now: () => Date.parse("2026-09-08T12:00:00.000Z") });
    const result = await engine.scan({ sourceId: "portal-list", kind: "PUBLIC_HTML", url: `${ORIGIN}/tenders`, noticePathPrefixes: ["/tenders/"] });
    expect(result.opportunities).toHaveLength(2);
    expect(result.matches).toHaveLength(1);
    expect(browser.fetchPublicPage).toHaveBeenCalledTimes(3);
  });

});
