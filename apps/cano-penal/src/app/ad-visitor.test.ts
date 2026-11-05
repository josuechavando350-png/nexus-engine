import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AD_VISIT_SESSION_KEY,
  DEFAULT_AD_MESSAGE,
  GOOGLE_ORIGIN_GREETING,
  googleTaggedMessage,
  googleTaggedWhatsappHref,
  isAdLandingSearch,
  rememberAdVisit,
  whatsappDestination,
} from "./ad-visitor";
import { classifyContactHref } from "./ads-conversions";
import { site } from "./content";

function memoryStore(throws = false) {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => { if (throws) throw new Error("blocked"); return data.get(key) ?? null; },
    setItem: (key: string, value: string) => { if (throws) throw new Error("blocked"); data.set(key, value); },
  };
}

const textOf = (href: string) => new URL(href).searchParams.get("text");

describe("CANO ad visitors: WhatsApp says the contact came from Google", () => {
  it("recognises only a landing from a Google Ads click", () => {
    for (const search of ["?gclid=abc", "?utm_source=google&gclid=abc", "?gbraid=x", "?wbraid=y"]) expect(isAdLandingSearch(search), search).toBe(true);
    for (const search of ["", "?gclid=", "?xgclid=abc", "?utm_source=google&utm_medium=cpc", "?ref=tarjeta"]) expect(isAdLandingSearch(search), search).toBe(false);
  });

  it("remembers the ad visit for the rest of the session, and never invents one", () => {
    const store = memoryStore();
    expect(rememberAdVisit("", store)).toBe(false);
    expect(rememberAdVisit("?gclid=abc", store)).toBe(true);
    expect(store.data.get(AD_VISIT_SESSION_KEY)).toBe("1");
    expect(rememberAdVisit("", store)).toBe(true);
    expect(rememberAdVisit("", memoryStore())).toBe(false);
    expect(rememberAdVisit("?gclid=abc", memoryStore(true))).toBe(true);
    expect(rememberAdVisit("", memoryStore(true))).toBe(false);
    expect(rememberAdVisit("?gclid=abc", null)).toBe(true);
  });

  it("puts the Google greeting first without doubling the hello", () => {
    expect(googleTaggedMessage("")).toBe(`${GOOGLE_ORIGIN_GREETING} ${DEFAULT_AD_MESSAGE}`);
    expect(googleTaggedMessage(null)).toBe(`${GOOGLE_ORIGIN_GREETING} ${DEFAULT_AD_MESSAGE}`);
    expect(googleTaggedMessage("Hola")).toBe(`${GOOGLE_ORIGIN_GREETING} ${DEFAULT_AD_MESSAGE}`);
    expect(googleTaggedMessage("Hola, deseo contactar a CANO Estrategia Penal.\nNombre: Ana"))
      .toBe("Hola, lo encontré en Google. Deseo contactar a CANO Estrategia Penal.\nNombre: Ana");
    expect(googleTaggedMessage("¡Hola! recibí un citatorio")).toBe("Hola, lo encontré en Google. Recibí un citatorio");
    expect(googleTaggedMessage("Necesito ayuda")).toBe("Hola, lo encontré en Google. Necesito ayuda");
    const once = googleTaggedMessage("Hola, necesito ayuda");
    expect(googleTaggedMessage(once)).toBe(once);
    expect(once.startsWith(GOOGLE_ORIGIN_GREETING)).toBe(true);
  });

  it("tags WhatsApp links and leaves every other link alone", () => {
    const plain = googleTaggedWhatsappHref(site.whatsapp);
    expect(plain.startsWith("https://wa.me/525560501901?text=")).toBe(true);
    expect(textOf(plain)).toBe(`${GOOGLE_ORIGIN_GREETING} ${DEFAULT_AD_MESSAGE}`);
    expect(plain).not.toContain("+");
    expect(classifyContactHref(plain)).toBe("whatsapp");

    const withText = googleTaggedWhatsappHref(`${site.whatsapp}?text=${encodeURIComponent("Hola, me detuvieron a un familiar")}`);
    expect(textOf(withText)).toBe("Hola, lo encontré en Google. Me detuvieron a un familiar");
    expect(googleTaggedWhatsappHref(withText)).toBe(withText);

    for (const href of ["#contacto", "/detenido-cdmx", "tel:+525560501901", "mailto:eduardo@canopenal.com", "https://maps.app.goo.gl/zMjF2TQZvfMchowx8", ""]) {
      expect(googleTaggedWhatsappHref(href)).toBe(href);
    }
  });

  it("tags the contact form message only for ad visits", () => {
    const message = "Hola, deseo contactar a CANO Estrategia Penal.";
    expect(textOf(whatsappDestination(message, false))).toBe(message);
    expect(textOf(whatsappDestination(message, true))).toBe("Hola, lo encontré en Google. Deseo contactar a CANO Estrategia Penal.");
  });

  it("is wired into the hero, every page and both forms", () => {
    const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    const chrome = readFileSync(new URL("./SiteChrome.tsx", import.meta.url), "utf8");
    const component = readFileSync(new URL("./AdVisitorWhatsapp.tsx", import.meta.url), "utf8");
    const form = readFileSync(new URL("./ContactForm.tsx", import.meta.url), "utf8");
    const enterprise = readFileSync(new URL("./evaluacion-empresarial/EnterpriseIntakeForm.tsx", import.meta.url), "utf8");
    expect(page).toContain('<Link className="cp-btn cp-btn-solid" href="#contacto" data-cp-hero-primary="">{hero.primaryCta}</Link>');
    expect(chrome).toContain("<AdVisitorWhatsapp />");
    expect(component).toContain('export const HERO_PRIMARY_ATTRIBUTE = "data-cp-hero-primary"');
    expect(component).toContain("if (!isBrowserAdVisit()) return;");
    expect(form).toContain("whatsappDestination(message, isBrowserAdVisit())");
    expect(enterprise).toContain("whatsappDestination(message, isBrowserAdVisit())");
  });
});
