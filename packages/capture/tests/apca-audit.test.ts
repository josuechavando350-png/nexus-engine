import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { evaluateApcaPolicy, measureApca } from "../apca-audit";

describe("APCA complex-background handling", () => {
  let browser: Browser | undefined;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    if (browser) await browser.close();
  });

  it("measures solid backgrounds but refuses to invent contrast over gradients", async () => {
    if (!browser) throw new Error("Chromium did not initialize");
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff;color:#111">
        <p data-nexus-contrast-role="solid" style="background:#fff;color:#111">Solid contrast evidence</p>
        <p data-nexus-contrast-role="complex" style="background-image:linear-gradient(90deg,#000,#fff);color:#fff">Complex contrast evidence</p>
      </body></html>`);
      const report = await measureApca(page);
      expect(report.observations.some((observation) => observation.role === "solid" && Number.isFinite(observation.lc))).toBe(true);
      expect(report.unsupported.some((observation) => observation.role === "complex" && observation.reason === "COMPLEX_BACKGROUND")).toBe(true);
      expect(report.unsupportedCount).toBe(report.unsupported.length);
      expect(evaluateApcaPolicy(report, { minimumAbsLcByRole: { complex: 10 } }).verdict).toBe("FAIL");
    } finally {
      await page.close();
    }
  });

  it("refuses semi-transparent backgrounds that require compositing instead of assuming an opaque color", async () => {
    if (!browser) throw new Error("Chromium did not initialize");
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.setContent(`<!doctype html><html><body style="margin:0;background:#000"><p data-nexus-contrast-role="translucent" style="background:rgba(255,255,255,.5);color:#111">Composite me</p></body></html>`);
      const report = await measureApca(page);
      expect(report.unsupported.some((observation) => observation.role === "translucent" && observation.reason === "COMPLEX_BACKGROUND")).toBe(true);
      expect(evaluateApcaPolicy(report, { minimumAbsLcByRole: { translucent: 10 } }).verdict).toBe("FAIL");
    } finally {
      await page.close();
    }
  });
});
