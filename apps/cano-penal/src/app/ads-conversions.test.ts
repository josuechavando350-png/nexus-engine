import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONVERSION_NAVIGATION_WAIT_MS,
  GOOGLE_ADS_CONVERSIONS,
  classifyContactHref,
  contactKindForClickTarget,
  reportAdsConversion,
} from "./ads-conversions";
import { site } from "./content";

type Call = { command: unknown; eventName: unknown; params: Record<string, unknown> };

function recordingGtag(options: { confirm?: boolean; fail?: boolean } = {}) {
  const calls: Call[] = [];
  const gtag = (command: unknown, eventName: unknown, params: Record<string, unknown>) => {
    if (options.fail) throw new Error("gtag unavailable");
    calls.push({ command, eventName, params });
    if (options.confirm) (params.event_callback as () => void)();
  };
  return { gtag, calls };
}

function manualSchedule() {
  const pending: Array<{ callback: () => void; delayMs: number }> = [];
  return {
    pending,
    schedule: (callback: () => void, delayMs: number) => { pending.push({ callback, delayMs }); },
  };
}

describe("CANO Google Ads conversion labels", () => {
  it("uses the three conversion actions created in the client's Ads account", () => {
    expect(GOOGLE_ADS_CONVERSIONS).toEqual({
      whatsapp: "AW-11458109085/91BuCLXLwO4cEJ2909cq",
      phone: "AW-11458109085/O_A8CLjLwO4cEJ2909cq",
      form: "AW-11458109085/tbcxCLLLwO4cEJ2909cq",
    });
  });

  it("never reintroduces the retired labels that never registered", () => {
    expect(JSON.stringify(GOOGLE_ADS_CONVERSIONS)).not.toContain("EJZ909cq");
  });
});

describe("CANO contact link classification", () => {
  it("recognises the site's own WhatsApp and phone links", () => {
    expect(classifyContactHref(site.whatsapp)).toBe("whatsapp");
    expect(classifyContactHref(`${site.whatsapp}?text=Hola`)).toBe("whatsapp");
    expect(classifyContactHref(site.phoneHref)).toBe("phone");
  });

  it("recognises other WhatsApp link shapes", () => {
    expect(classifyContactHref("https://api.whatsapp.com/send?phone=525560501901")).toBe("whatsapp");
    expect(classifyContactHref("whatsapp://send?phone=525560501901")).toBe("whatsapp");
    expect(classifyContactHref("TEL:+525560501901")).toBe("phone");
  });

  it("ignores everything that is not a contact action", () => {
    for (const href of ["/", "/casos", "#main-content", "https://canopenal.com/acerca-de-mi", "mailto:eduardo@canopenal.com", "https://www.instagram.com/canopenal", "https://maps.app.goo.gl/zMjF2TQZvfMchowx8", "javascript:void(0)", "", null, undefined]) {
      expect(classifyContactHref(href)).toBeNull();
    }
  });

  it("does not treat look-alike hosts as WhatsApp", () => {
    expect(classifyContactHref("https://wa.me.example.com/525560501901")).toBeNull();
    expect(classifyContactHref("https://notwhatsapp.com/")).toBeNull();
  });

  it("resolves clicks on nested elements to the enclosing link", () => {
    const anchor = { getAttribute: () => site.whatsapp };
    const icon = { closest: (selector: string) => (selector === "a[href]" ? anchor : null) };
    expect(contactKindForClickTarget(icon as unknown as EventTarget, "https://canopenal.com/")).toBe("whatsapp");
    expect(contactKindForClickTarget({ closest: () => null } as unknown as EventTarget, "https://canopenal.com/")).toBeNull();
    expect(contactKindForClickTarget(null, "https://canopenal.com/")).toBeNull();
  });
});

describe("CANO conversion reporting never blocks contact", () => {
  it("sends the matching label through gtag as a beacon", () => {
    const { gtag, calls } = recordingGtag();
    reportAdsConversion("whatsapp", gtag);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("event");
    expect(calls[0].eventName).toBe("conversion");
    expect(calls[0].params.send_to).toBe(GOOGLE_ADS_CONVERSIONS.whatsapp);
    expect(calls[0].params.transport_type).toBe("beacon");
  });

  it("continues a page navigation once, as soon as gtag confirms", () => {
    const { gtag } = recordingGtag({ confirm: true });
    const timer = manualSchedule();
    let navigations = 0;
    reportAdsConversion("form", gtag, () => { navigations += 1; }, timer.schedule);
    expect(navigations).toBe(1);
    timer.pending.forEach(({ callback }) => callback());
    expect(navigations).toBe(1);
  });

  it("continues the navigation after a bounded wait when gtag never confirms", () => {
    const { gtag } = recordingGtag();
    const timer = manualSchedule();
    let navigations = 0;
    reportAdsConversion("form", gtag, () => { navigations += 1; }, timer.schedule);
    expect(navigations).toBe(0);
    expect(timer.pending).toHaveLength(1);
    expect(timer.pending[0].delayMs).toBe(CONVERSION_NAVIGATION_WAIT_MS);
    expect(CONVERSION_NAVIGATION_WAIT_MS).toBeLessThanOrEqual(1000);
    timer.pending[0].callback();
    expect(navigations).toBe(1);
  });

  it("navigates immediately when the tag is missing or fails", () => {
    let navigations = 0;
    reportAdsConversion("form", undefined, () => { navigations += 1; });
    expect(navigations).toBe(1);
    const failing = recordingGtag({ fail: true });
    expect(() => reportAdsConversion("form", failing.gtag, () => { navigations += 1; })).not.toThrow();
    expect(navigations).toBe(2);
  });
});

describe("CANO conversion wiring", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  it("mounts click tracking on every page through the root layout", () => {
    const layout = read("./layout.tsx");
    expect(layout).toContain('import { AdsConversionTracking } from "./AdsConversionTracking";');
    expect(layout).toContain("<AdsConversionTracking />");
    expect(layout).toContain("gtag('config','AW-11458109085')");
  });

  it("only observes clicks and never cancels the visitor's navigation", () => {
    const tracker = read("./AdsConversionTracking.tsx");
    expect(tracker).toContain('document.addEventListener("click", onClick, { capture: true })');
    expect(tracker).not.toContain("preventDefault");
  });

  it("reports both lead forms before they open WhatsApp", () => {
    const contact = read("./ContactForm.tsx");
    const enterprise = read("./evaluacion-empresarial/EnterpriseIntakeForm.tsx");
    expect(contact).toContain('reportAdsConversion("form", pageGtag(), () => window.location.assign(destination));');
    expect(enterprise).toContain('reportAdsConversion("form", pageGtag(), () => window.location.assign(destination));');
  });
});
