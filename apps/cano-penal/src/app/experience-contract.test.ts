import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { site } from "./content";

describe("CANO production contact and splash contract", () => {
  it("uses the current Mexico international format for calls and WhatsApp", () => {
    expect(site.phoneDisplay).toBe("+52 55 6050 1901");
    expect(site.phoneHref).toBe("tel:+525560501901");
    expect(site.whatsapp).toBe("https://wa.me/525560501901");
    expect(JSON.stringify(site)).not.toContain("5215560501901");
  });

  it("keeps the splash out of the global layout and mounts it only on home", () => {
    const layout = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");
    const home = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

    expect(layout).not.toContain("cp-splash");
    expect(home).toContain("<HomeSplash />");
  });

  it("does not keep the deprecated Mexico mobile prefix in the home page", () => {
    const home = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    expect(home).not.toContain("5215560501901");
    expect(home).toContain("525560501901");
  });
});


describe("CANO organic integration contract", () => {
  it("imports commercial, fiscal and area-specific styles before preview", () => {
    const layout = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");
    for (const css of ["organic-core.css", "organic-editorial.css", "fiscal-calendar.css", "areas-unique.css"]) {
      expect(layout).toContain('import "./' + css + '";');
    }
  });

  it("keeps the fixed header readable on pale and dark interior heroes", () => {
    const chrome = readFileSync(new URL("./chrome.css", import.meta.url), "utf8");
    expect(chrome).toContain("body:not(:has(.cp-hero)) .cp-header");
    expect(chrome).toContain("background:#0c1116");
  });

  it("replaces the inoperative homepage form and links into the acquisition routes", () => {
    const home = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    const nav = readFileSync(new URL("./content.ts", import.meta.url), "utf8");
    expect(home).toContain("<ContactForm compact />");
    expect(home).not.toContain('<form className="cp-form">');
    expect(home).toContain('href="/detenido-cdmx"');
    expect(home).toContain('href="/diagnostico-penal"');
    expect(nav).toContain('["Calendario fiscal", "/herramientas/calendario-fiscal"]');
  });

  it("displays the approved informative fiscal notice prominently", () => {
    const calendar = readFileSync(new URL("./FiscalCalendar.tsx", import.meta.url), "utf8");
    const stylesheet = readFileSync(new URL("./fiscal-calendar.css", import.meta.url), "utf8");
    expect(calendar).toContain('className="cp-cal-disclaimer"');
    expect(calendar).toContain("exclusivamente informativa y orientativa");
    expect(calendar).toContain("plazos exactos y la atención de cada caso deben verificarse individualmente");
    expect(calendar).toContain("no sustituye una asesoría fiscal o jurídica personalizada");
    expect(stylesheet).toContain(".cp-cal-disclaimer{");
  });

  it("makes all eight new consultation routes discoverable while leaving calendar in its section", () => {
    const home = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    const nav = readFileSync(new URL("./content.ts", import.meta.url), "utf8");
    const paths = [
      "/detenido-cdmx",
      "/citatorio-ministerio-publico-cdmx",
      "/audiencia-inicial-control-detencion-cdmx",
      "/diagnostico-penal",
      "/guias/requerimiento-sat-riesgo-penal",
      "/guias/responsabilidad-penal-representante-legal-contador",
      "/guias/defensa-penal-empresa-delitos-financieros",
      "/guias/honorarios-abogado-penalista-cdmx",
    ];
    expect(home).toContain('className="cp-route-index"');
    for (const path of paths) expect(home).toContain('href="' + path + '"');
    expect(home).not.toContain('className="cp-organic-bridge"');
    expect(nav).toContain('["Calendario fiscal", "/herramientas/calendario-fiscal"]');
  });

  it("keeps fiscal deadlines unlisted until evidence and fiscal approval exist", () => {
    const data = readFileSync(new URL("./fiscal-calendar-data.ts", import.meta.url), "utf8");
    const route = readFileSync(new URL("./herramientas/calendario-fiscal/page.tsx", import.meta.url), "utf8");
    const sitemap = readFileSync(new URL("./sitemap.ts", import.meta.url), "utf8");
    expect(data).toContain("Object.freeze([])");
    const calendar = readFileSync(new URL("./FiscalCalendar.tsx", import.meta.url), "utf8");
    expect(calendar).toContain("https://www.sat.gob.mx/portal/public/calendario");
    expect(data).not.toContain("day: 17");
    expect(route).toContain("robots: { index: false, follow: false }");
    expect(sitemap).not.toContain('/herramientas/calendario-fiscal');
  });

  it("never renders decorative 01/02/03 labels across public editorial pages", () => {
    const app = new URL("./", import.meta.url);
    const pageFiles = [
      "page.tsx",
      "AreaExperience.tsx",
      "InteriorSections.tsx",
      "acerca-de-mi/page.tsx",
      "casos/page.tsx",
      "detenido-cdmx/page.tsx",
      "diagnostico-penal/page.tsx",
      "citatorio-ministerio-publico-cdmx/page.tsx",
      "audiencia-inicial-control-detencion-cdmx/page.tsx",
      "guias/requerimiento-sat-riesgo-penal/page.tsx",
      "guias/responsabilidad-penal-representante-legal-contador/page.tsx",
      "guias/defensa-penal-empresa-delitos-financieros/page.tsx",
      "guias/honorarios-abogado-penalista-cdmx/page.tsx",
    ];
    for (const path of pageFiles) {
      const page = readFileSync(new URL(path, app), "utf8");
      expect(page, path).not.toMatch(/>(?:0[1-9]|00[1-9])(?:\s*(?:\/|—|-)|<)/);
      expect(page, path).not.toMatch(/"(?:0[1-9])"\s*,/);
      expect(page, path).not.toMatch(/(?:0[1-9])\s*(?:\/|—)\s*(?:[A-ZÁÉÍÓÚ])/);
      expect(page, path).not.toMatch(/0\{i\s*\+\s*1\}/);
    }
    const interior = readFileSync(new URL("./interior.css", import.meta.url), "utf8");
    expect(interior).not.toContain("decimal-leading-zero");
    const routeIndex = readFileSync(new URL("./organic-core.css", import.meta.url), "utf8");
    expect(routeIndex).toContain(".cp-route-index-group-title::before");
  });

  it("provides a distinct composition for each approved practice area", () => {
    const page = readFileSync(new URL("./areas/[slug]/page.tsx", import.meta.url), "utf8");
    const experience = readFileSync(new URL("./AreaExperience.tsx", import.meta.url), "utf8");
    expect(page).toContain("<AreaExperience slug={slug}");
    for (const slug of [
      "delitos-fiscales-y-financieros",
      "delitos-patrimoniales-y-fraude",
      "homicidio-y-delitos-violentos",
      "delitos-sexuales",
      "corrupcion-y-administracion-publica",
      "despojo-y-defensa-de-victimas",
      "justicia-penal-para-adolescentes",
      "amparo-recursos-y-apelaciones",
    ]) {
      expect(experience).toContain('case "' + slug + '":');
    }
  });
});
