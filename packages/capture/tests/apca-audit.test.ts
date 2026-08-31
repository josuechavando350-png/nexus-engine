import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, webkit, type Browser, type BrowserType } from "playwright";
import { evaluateApcaPolicy, evaluateDynamicApcaPolicy, measureApca, minimumApcaLc } from "../apca-audit";

for (const [browserName, browserType] of [["chromium", chromium], ["webkit", webkit]] as const satisfies readonly [string, BrowserType][]) {
  describe(`APCA V2 rendered-background handling (${browserName})`, () => {
    let browser: Browser | undefined;

    beforeAll(async () => {
      browser = await browserType.launch({ headless: true });
    });

    afterAll(async () => {
      if (browser) await browser.close();
    });

    it("samples the actual rendered pixels under text across a gradient", async () => {
      if (!browser) throw new Error(`${browserName} did not initialize`);
      const page = await browser.newPage({ viewport: { width: 420, height: 500 } });
      try {
        await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff"><p data-nexus-contrast-role="hero" style="margin:40px;width:320px;padding:40px;background:linear-gradient(90deg,#000,#fff);color:#fff;font:700 32px Arial">Gradient evidence</p></body></html>`);
        const report = await measureApca(page);
        const observation = report.observations.find((item) => item.role === "hero");
        expect(observation).toBeDefined();
        expect(observation?.backgroundSource).toBe("RENDERED_PIXEL_SAMPLE");
        expect(observation?.sampleCount).toBeGreaterThan(3);
        expect(observation?.absoluteLc).toBeGreaterThan(0);
        expect(observation?.requiredAbsLc).not.toBeNull();
        expect(observation!.absoluteLc).toBeLessThan(observation!.requiredAbsLc!);
        expect(evaluateDynamicApcaPolicy(report, ["hero"]).verdict).toBe("FAIL");
        expect(report.unsupported.some((item) => item.role === "hero")).toBe(false);
        expect(report.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
      } finally {
        await page.close();
      }
    }, 15_000);

    it("measures composited semi-transparent backgrounds instead of assuming an opaque CSS color", async () => {
      if (!browser) throw new Error(`${browserName} did not initialize`);
      const page = await browser.newPage({ viewport: { width: 420, height: 500 } });
      try {
        await page.setContent(`<!doctype html><html><body style="margin:0;background:#000"><p data-nexus-contrast-role="translucent-bg" style="margin:40px;padding:30px;background:rgba(255,255,255,.5);color:#fff;font:600 22px Arial">Composite background</p></body></html>`);
        const report = await measureApca(page);
        const observation = report.observations.find((item) => item.role === "translucent-bg");
        expect(observation).toBeDefined();
        expect(observation?.backgroundColor).toMatch(/^rgb\(/);
        expect(report.unsupported.some((item) => item.role === "translucent-bg")).toBe(false);
      } finally {
        await page.close();
      }
    });

    it("uses full-page document coordinates for text below the initial viewport", async () => {
      if (!browser) throw new Error(`${browserName} did not initialize`);
      const page = await browser.newPage({ viewport: { width: 420, height: 300 } });
      try {
        await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff"><div style="height:900px"></div><p data-nexus-contrast-role="below-fold" style="margin:0;padding:40px;background:#123456;color:#fff;font:700 24px Arial">Below fold evidence</p></body></html>`);
        const report = await measureApca(page);
        const observation = report.observations.find((item) => item.role === "below-fold");
        expect(observation).toBeDefined();
        expect(observation?.backgroundColor).toBe("rgb(18, 52, 86)");
        expect(observation?.sampleCount).toBeGreaterThan(0);
      } finally {
        await page.close();
      }
    });

    it("fails closed for direct and ancestor rendering effects whose compositing cannot be isolated safely", async () => {
      if (!browser) throw new Error(`${browserName} did not initialize`);
      const page = await browser.newPage({ viewport: { width: 420, height: 500 } });
      try {
        await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff"><p data-nexus-contrast-role="blend" style="mix-blend-mode:difference;color:#fff">Blend text</p><p data-nexus-contrast-role="stroke" style="-webkit-text-stroke:1px black;color:#fff">Stroke text</p><p data-nexus-contrast-role="alpha" style="color:rgba(0,0,0,.5)">Alpha text</p><div style="opacity:.8"><p data-nexus-contrast-role="ancestor-opacity" style="color:#000">Ancestor opacity</p></div></body></html>`);
        const report = await measureApca(page);
        expect(report.unsupported.some((item) => item.role === "blend" && item.reason === "MIX_BLEND_MODE")).toBe(true);
        expect(report.unsupported.some((item) => item.role === "stroke" && item.reason === "TEXT_STROKE")).toBe(true);
        expect(report.unsupported.some((item) => item.role === "alpha" && item.reason === "TRANSLUCENT_TEXT")).toBe(true);
        expect(report.unsupported.some((item) => item.role === "ancestor-opacity" && item.reason === "GROUP_OPACITY")).toBe(true);
        expect(evaluateApcaPolicy(report, { minimumAbsLcByRole: { blend: 10 } }).verdict).toBe("FAIL");
      } finally {
        await page.close();
      }
    });

    it("restores client-owned sampling attributes and handles multiple text nodes on one element", async () => {
      if (!browser) throw new Error(`${browserName} did not initialize`);
      const page = await browser.newPage({ viewport: { width: 420, height: 500 } });
      try {
        await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff"><p id="shared" data-nexus-apca-sample="client-owned" data-nexus-contrast-role="shared" style="color:#000;background:#fff;font:400 18px Arial">First<!--split--> second</p></body></html>`);
        const report = await measureApca(page);
        expect(report.observations.filter((item) => item.role === "shared").length).toBeGreaterThanOrEqual(2);
        expect(await page.locator("#shared").getAttribute("data-nexus-apca-sample")).toBe("client-owned");
      } finally {
        await page.close();
      }
    });

    it("applies dynamic font-size, weight and use guidance and fails low contrast", async () => {
      if (!browser) throw new Error(`${browserName} did not initialize`);
      const page = await browser.newPage({ viewport: { width: 420, height: 500 } });
      try {
        await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff"><p data-nexus-contrast-role="body-copy" style="margin:40px;color:#aaa;background:#fff;font:400 16px Arial">Low contrast body copy</p></body></html>`);
        const report = await measureApca(page);
        const observation = report.observations.find((item) => item.role === "body-copy");
        expect(observation?.requiredAbsLc).not.toBeNull();
        expect(evaluateDynamicApcaPolicy(report, ["body-copy"]).verdict).toBe("FAIL");
      } finally {
        await page.close();
      }
    });
  });
}

describe("APCA V2 bounds and guidance", () => {
  it("cleans temporary sampling state if the candidate bound is exceeded", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 420, height: 600 } });
    try {
      const nodes = Array.from({ length: 513 }, (_, index) => `<span>candidate-${index}</span>`).join("");
      await page.setContent(`<!doctype html><html><body>${nodes}</body></html>`);
      await expect(measureApca(page)).rejects.toThrow(/candidate bound exceeded/);
      expect(await page.locator("[data-nexus-apca-sample]").count()).toBe(0);
    } finally {
      await page.close();
      await browser.close();
    }
  });

  it("returns bounded guidance for supported typography and rejects invalid sizes", () => {
    expect(minimumApcaLc(16, 400, "BODY")).not.toBeNull();
    expect(minimumApcaLc(48, 700, "FLUENT")).not.toBeNull();
    expect(minimumApcaLc(0, 400, "BODY")).toBeNull();
  });
});
