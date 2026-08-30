import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, webkit, type Browser, type BrowserType } from "playwright";
import { evaluateDynamicApcaPolicy, measureApca } from "../apca-audit";

for (const [browserName, browserType] of [["chromium", chromium], ["webkit", webkit]] as const satisfies readonly [string, BrowserType][]) {
  describe(`APCA V2 placeholders (${browserName})`, () => {
    let browser: Browser | undefined;

    beforeAll(async () => {
      browser = await browserType.launch({ headless: true });
    });

    afterAll(async () => {
      if (browser) await browser.close();
    });

    it("measures placeholder pixels as SPOT text and restores the field after sampling", async () => {
      if (!browser) throw new Error(`${browserName} did not initialize`);
      const page = await browser.newPage({ viewport: { width: 480, height: 360 } });
      try {
        await page.setContent(`<!doctype html><html><head><style>input::placeholder{color:#aaa;opacity:1}</style></head><body style="margin:0;background:#fff"><input id="field" data-nexus-contrast-role="search-placeholder" placeholder="Search evidence" style="margin:40px;width:320px;padding:18px;background:linear-gradient(90deg,#fff,#eee);color:#111;font:400 16px Arial"></body></html>`);
        const report = await measureApca(page);
        const observation = report.observations.find((item) => item.role === "search-placeholder" && item.target === "PLACEHOLDER");
        expect(observation).toBeDefined();
        expect(observation?.use).toBe("SPOT");
        expect(observation?.sampleCount).toBeGreaterThan(1);
        expect(observation?.requiredAbsLc).not.toBeNull();
        expect(await page.locator("#field").getAttribute("placeholder")).toBe("Search evidence");
        expect(await page.locator("#field").getAttribute("data-nexus-apca-sample")).toBeNull();
        expect(evaluateDynamicApcaPolicy(report, ["search-placeholder"]).verdict).toBe("FAIL");
      } finally {
        await page.close();
      }
    });
  });
}
