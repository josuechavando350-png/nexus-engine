import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { googleTaggedWhatsappHref, GOOGLE_ORIGIN_GREETING } from "../ad-visitor";
import { classifyContactHref } from "../ads-conversions";
import { FLOATING_WA_GUARDED_SELECTOR } from "../ClientInteractions";
import { site } from "../content";
import { CONSULTA_MAPS_URL, CONSULTA_PHONE_LABEL, CONSULTA_SITUATIONS, CONSULTA_STEPS, whatsappWith } from "./landing";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const page = read("./page.tsx");
const chrome = read("./LandingChrome.tsx");
const fonts = read("./fonts.ts");
const landing = read("./landing.ts");
const css = read("./consulta-penal.css");

describe("/consulta-penal: the Google Ads landing page", () => {
  it("stays out of organic search and never competes with the site's pages", () => {
    expect(page).toContain("robots: { index: false, follow: false }");
    expect(page).toContain('canonical: "https://canopenal.com/consulta-penal"');
    expect(read("../sitemap.ts")).not.toContain("consulta-penal");
  });

  it("keeps the site's client behaviour: ad tagging, floating WhatsApp, header and the skip-link target", () => {
    for (const piece of ["<ClientInteractions />", "<AdVisitorWhatsapp />", "<SiteFooter />", "<LandingHeader />", 'id="main-content"']) expect(page, piece).toContain(piece);
    expect(chrome).toContain('className="cp-header cp-lp-header"');
    expect(chrome).toContain("href={site.phoneHref}");
  });

  it("opens WhatsApp with the situation already written, and counts every tap as a contact", () => {
    expect(CONSULTA_SITUATIONS.map((situation) => situation.id)).toEqual(["detenido", "citatorio-orden", "me-acusan", "victima", "otro"]);
    for (const situation of CONSULTA_SITUATIONS) {
      const href = whatsappWith(situation.message);
      expect(classifyContactHref(href), situation.id).toBe("whatsapp");
      expect(new URL(href).searchParams.get("text")).toBe(situation.message);
    }
    expect(classifyContactHref(site.whatsapp)).toBe("whatsapp");
    expect(classifyContactHref(site.phoneHref)).toBe("phone");
    expect(classifyContactHref(CONSULTA_MAPS_URL)).toBe(null);
    expect(CONSULTA_PHONE_LABEL).toBe("55 6050 1901");
  });

  it("tells the lic the visitor came from Google without losing the situation", () => {
    for (const situation of CONSULTA_SITUATIONS) {
      const text = new URL(googleTaggedWhatsappHref(whatsappWith(situation.message))).searchParams.get("text") ?? "";
      expect(text.startsWith(GOOGLE_ORIGIN_GREETING), situation.id).toBe(true);
      expect(text.toLowerCase()).toContain(situation.message.replace(/^Hola,\s*/u, "").toLowerCase());
    }
  });

  it("gives every link in the page content the class the floating WhatsApp button steps aside for", () => {
    expect(FLOATING_WA_GUARDED_SELECTOR).toContain("main .cp-btn");
    // The header lives in LandingChrome.tsx, outside <main>; every anchor in page.tsx renders inside <main>.
    const anchors = page.match(/<a\s[^>]*>/gu) ?? [];
    expect(anchors.length >= 3).toBe(true);
    for (const anchor of anchors) expect(anchor, anchor).toMatch(/className="cp-btn[ "]/u);
    expect(page).toContain("<ContactButtons placement=\"hero\" />");
  });

  it("styles only itself and is loaded by its own page", () => {
    const rules = css.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/gu, "").replace(/@media[^{]*\{/gu, "");
    const selectors = rules.match(/[^{}]+(?=\{)/gu) ?? [];
    expect(selectors.length > 40).toBe(true);
    for (const group of selectors) for (const selector of group.split(",")) expect(selector.trim(), selector).toMatch(/^\.cp-lp/u);
    expect(css).not.toContain("!important");
    expect(page).toContain('import "./consulta-penal.css";');
    expect(read("../layout.tsx")).not.toContain("consulta-penal");
  });

  it("self-hosts its typeface so the build stays hermetic", () => {
    expect(fonts).toContain('from "next/font/local"');
    const files = [...fonts.matchAll(/"\.\/fonts\/([^"]+\.woff2)"/gu)].map((match) => match[1]);
    expect(files.length).toBe(5);
    for (const file of files) {
      const url = new URL(`./fonts/${file}`, import.meta.url);
      expect(existsSync(url), file).toBe(true);
      expect(statSync(url).size < 40_000, file).toBe(true);
    }
    expect(existsSync(new URL("./fonts/OFL.txt", import.meta.url))).toBe(true);
  });

  it("promises no outcome and avoids the decorations the client rejected", () => {
    const copy = [page, landing, chrome].join("\n");
    expect(copy).not.toMatch(/garantiz|aseguramos|100\s*%|ganamos|libertad segura|éxito asegurado/iu);
    expect(copy).not.toMatch(/→|\b0[1-9]\b/u);
    expect(CONSULTA_STEPS.length).toBe(3);
  });
});
