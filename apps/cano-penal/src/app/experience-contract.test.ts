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
