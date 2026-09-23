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

  it("keeps fiscal deadlines unlisted until evidence and fiscal approval exist", () => {
    const data = readFileSync(new URL("./fiscal-calendar-data.ts", import.meta.url), "utf8");
    const route = readFileSync(new URL("./herramientas/calendario-fiscal/page.tsx", import.meta.url), "utf8");
    const sitemap = readFileSync(new URL("./sitemap.ts", import.meta.url), "utf8");
    expect(data).toContain("Object.freeze([])");
    expect(data).not.toContain("day: 17");
    expect(route).toContain("robots: { index: false, follow: false }");
    expect(sitemap).not.toContain('/herramientas/calendario-fiscal');
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
