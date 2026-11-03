import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FLOATING_WA_GUARDED_SELECTOR, rectsOverlap } from "./ClientInteractions";

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height });

describe("CANO floating WhatsApp never covers a page CTA", () => {
  it("detects real overlaps and keeps a small safety gap", () => {
    // 390px phone, ad visitor: label over "Hablemos de tu caso" (measured before the fix).
    expect(rectsOverlap(rect(119, 777, 190, 39), rect(16, 761, 358, 49))).toBe(true);
    // After the fix the hero button ends at 310px and the floating button starts at 320px.
    expect(rectsOverlap(rect(320, 770, 54, 54), rect(16, 761, 294, 49), 6)).toBe(false);
    // Closer than the gap still counts as covering.
    expect(rectsOverlap(rect(320, 770, 54, 54), rect(16, 761, 300, 49), 6)).toBe(true);
    expect(rectsOverlap(rect(0, 0, 10, 10), rect(20, 20, 10, 10))).toBe(false);
  });

  it("guards the site's buttons and form fields inside the page content only", () => {
    for (const selector of ["main .cp-btn", "main input", "main textarea", "main select", "main button"]) {
      expect(FLOATING_WA_GUARDED_SELECTOR).toContain(selector);
    }
  });

  it("wires the yielding classes and the phone hero spacing", () => {
    const interactions = readFileSync(new URL("./ClientInteractions.tsx", import.meta.url), "utf8");
    const polish = readFileSync(new URL("./vip-polish.css", import.meta.url), "utf8");
    const chrome = readFileSync(new URL("./SiteChrome.tsx", import.meta.url), "utf8");
    expect(interactions).toContain('floatingWa.classList.toggle("is-yielding"');
    expect(interactions).toContain('floatingWa.classList.toggle("is-label-yielding"');
    expect(interactions).toContain('floatingWa?.classList.remove("is-yielding", "is-label-yielding")');
    expect(polish).toContain(".cp-wa.is-label-yielding .cp-wa-cta{visibility:hidden}");
    expect(polish).toContain(".cp-wa.is-yielding{opacity:0;pointer-events:none}");
    expect(polish).toContain("@media(max-width:640px){.cp-hero .cp-actions{padding-right:4rem}");
    // The floating button itself, its label and its tracking signal stay as they were.
    expect(chrome).toContain('data-nexus-signal="floating-whatsapp"');
    expect(chrome).toContain("Atención inmediata · Escríbeme");
  });
});
