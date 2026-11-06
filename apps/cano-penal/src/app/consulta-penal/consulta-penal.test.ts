import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { googleTaggedWhatsappHref, GOOGLE_ORIGIN_GREETING } from "../ad-visitor";
import { classifyContactHref } from "../ads-conversions";
import { FLOATING_WA_GUARDED_SELECTOR } from "../ClientInteractions";
import { site } from "../content";
import { CONSULTA_PHONE_LABEL, CONSULTA_SITUATIONS, whatsappWith } from "./landing";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const page = read("./page.tsx");
const landing = read("./landing.ts");
const css = read("../consulta-penal.css");

describe("/consulta-penal: the Google Ads landing page", () => {
  it("stays out of organic search and never competes with the site's pages", () => {
    expect(page).toContain("robots: { index: false, follow: false }");
    expect(page).toContain('canonical: "https://canopenal.com/consulta-penal"');
    expect(read("../sitemap.ts")).not.toContain("consulta-penal");
  });

  it("opens WhatsApp with the situation already written, and counts every tap as a contact", () => {
    for (const situation of CONSULTA_SITUATIONS) {
      const href = whatsappWith(situation.message);
      expect(classifyContactHref(href), situation.id).toBe("whatsapp");
      expect(new URL(href).searchParams.get("text")).toBe(situation.message);
    }
    expect(classifyContactHref(site.whatsapp)).toBe("whatsapp");
    expect(classifyContactHref(site.phoneHref)).toBe("phone");
    expect(CONSULTA_PHONE_LABEL).toBe("55 6050 1901");
  });

  it("tells the lic the visitor came from Google without losing the situation", () => {
    for (const situation of CONSULTA_SITUATIONS) {
      const text = new URL(googleTaggedWhatsappHref(whatsappWith(situation.message))).searchParams.get("text") ?? "";
      expect(text.startsWith(GOOGLE_ORIGIN_GREETING), situation.id).toBe(true);
      expect(text.toLowerCase()).toContain(situation.message.replace(/^Hola,\s*/u, "").toLowerCase());
    }
  });

  it("gives every button the class the floating WhatsApp button already steps aside for", () => {
    expect(FLOATING_WA_GUARDED_SELECTOR).toContain("main .cp-btn");
    const anchors = page.match(/<a\s[^>]*>/gu) ?? [];
    expect(anchors.length >= 3).toBe(true);
    for (const anchor of anchors) expect(anchor, anchor).toMatch(/className="cp-btn[ "]/u);
  });

  it("styles only itself, and is loaded after the rules it refines", () => {
    const selectors = css.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/@media[^{]*\{/gu, "").match(/[^{}]+(?=\{)/gu) ?? [];
    expect(selectors.length).toBeGreaterThan(20);
    for (const group of selectors) for (const selector of group.split(",")) expect(selector.trim(), selector).toMatch(/^\.cp-lp/u);
    const layout = read("../layout.tsx");
    expect(layout.indexOf('import "./consulta-penal.css"')).toBeGreaterThan(layout.indexOf('import "./vip-polish.css"'));
  });

  it("promises no outcome", () => {
    for (const source of [page, landing]) expect(source).not.toMatch(/garantiz|aseguramos|100\s*%|ganamos|libertad segura|éxito asegurado/iu);
  });
});
