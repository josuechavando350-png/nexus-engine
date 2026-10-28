import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AD_CLICK_PARAMS, SPLASH_SCRIPT } from "./HomeSplash";

type Visit = {
  attributes: Set<string>;
  htmlClasses: Set<string>;
  timers: Array<{ callback: () => void; delayMs: number }>;
  storage: Map<string, string>;
};

function visit(search: string, options: { storage?: Map<string, string>; storageThrows?: boolean } = {}): Visit {
  const attributes = new Set<string>();
  const htmlClasses = new Set<string>();
  const timers: Visit["timers"] = [];
  const storage = options.storage ?? new Map<string, string>();
  const splash = { setAttribute: (name: string) => { attributes.add(name); } };
  const document = {
    currentScript: { previousElementSibling: splash },
    documentElement: { classList: { add: (name: string) => htmlClasses.add(name), remove: (name: string) => htmlClasses.delete(name) } },
  };
  const window = { location: { search }, matchMedia: () => ({ matches: false }) };
  const sessionStorage = {
    getItem: (key: string) => { if (options.storageThrows) throw new Error("blocked"); return storage.get(key) ?? null; },
    setItem: (key: string, value: string) => { if (options.storageThrows) throw new Error("blocked"); storage.set(key, value); },
  };
  const setTimeout = (callback: () => void, delayMs: number) => { timers.push({ callback, delayMs }); };
  new Function("document", "window", "sessionStorage", "setTimeout", SPLASH_SCRIPT)(document, window, sessionStorage, setTimeout);
  return { attributes, htmlClasses, timers, storage };
}

describe("CANO home splash: full splash for everyone except Google Ads clicks", () => {
  it("only recognises Google Ads auto-tagging click identifiers", () => {
    expect(AD_CLICK_PARAMS).toEqual(["gclid", "gbraid", "wbraid"]);
  });

  it("plays the full splash for a normal first visit", () => {
    for (const search of ["", "?utm_source=instagram", "?ref=tarjeta", "?gclid=", "?xgclid=abc"]) {
      const result = visit(search);
      expect(result.attributes.has("data-skip"), search).toBe(false);
      expect(result.attributes.has("data-ad"), search).toBe(false);
      expect(result.htmlClasses.has("cp-splash-lock"), search).toBe(true);
      expect(result.timers).toHaveLength(1);
      result.timers[0].callback();
      expect(result.attributes.has("data-done")).toBe(true);
      expect(result.htmlClasses.has("cp-splash-lock")).toBe(false);
    }
  });

  it("skips the full-screen splash and shows the in-hero brand mark for an ad click", () => {
    for (const search of ["?gclid=Cj0KCQ", "?utm_source=google&gclid=abc", "?gbraid=0AAAA", "?wbraid=Cl0K"]) {
      const result = visit(search);
      expect(result.attributes.has("data-ad"), search).toBe(true);
      expect(result.attributes.has("data-skip"), search).toBe(true);
      expect(result.htmlClasses.has("cp-splash-lock"), search).toBe(false);
      expect(result.timers, search).toHaveLength(0);
    }
  });

  it("does not show the splash later in the same session after an ad landing", () => {
    const storage = new Map<string, string>();
    visit("?gclid=abc", { storage });
    const later = visit("", { storage });
    expect(later.attributes.has("data-skip")).toBe(true);
    expect(later.attributes.has("data-ad")).toBe(false);
  });

  it("keeps the existing once-per-session behaviour for normal visitors", () => {
    const storage = new Map<string, string>();
    visit("", { storage });
    const repeat = visit("", { storage });
    expect(repeat.attributes.has("data-skip")).toBe(true);
    expect(repeat.htmlClasses.has("cp-splash-lock")).toBe(false);
  });

  it("still works when session storage is blocked", () => {
    expect(visit("?gclid=abc", { storageThrows: true }).attributes.has("data-ad")).toBe(true);
    expect(visit("", { storageThrows: true }).htmlClasses.has("cp-splash-lock")).toBe(true);
  });

  it("wires the in-hero brand mark so it only appears for ad visitors", () => {
    const home = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    const polish = readFileSync(new URL("./vip-polish.css", import.meta.url), "utf8");
    expect(home.indexOf("<HomeSplash />")).toBeLessThan(home.indexOf('className="cp-hero-brandmark"'));
    expect(home).toContain("Experiencia desde dentro. Defensa de frente.");
    expect(polish).toContain(".cp-hero-brandmark{display:none;");
    expect(polish).toContain(".cp-splash[data-ad] ~ main .cp-hero-brandmark{display:block}");
  });
});
