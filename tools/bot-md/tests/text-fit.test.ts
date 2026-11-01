import test from "node:test";
import assert from "node:assert/strict";
import { launch } from "../src/browser.js";
import { textFitRuntime, validateTextFit } from "../src/text-fit.js";

test("text fitting rejects ambiguous rules and unreadably small font limits", () => {
  const rule = {
    id: "title",
    route: "/",
    selector: "h1",
    lineSelector: ".line",
    minFontSizePx: 24,
  };
  assert.throws(
    () => validateTextFit([{ ...rule, minFontSizePx: 3 }]),
    /inválida/,
  );
  assert.throws(
    () => validateTextFit([rule, { ...rule, id: "other" }]),
    /inválida/,
  );
  assert.throws(
    () => validateTextFit([{ ...rule, route: "//outside.test" }]),
    /inválida/,
  );
});
test(
  "text fitting detects clipping hidden by overflow, preserves nested content, regrows on resize and reports an impossible minimum",
  { timeout: 30000 },
  async () => {
    const browser = await launch();
    try {
      const page = await browser.newPage({
        viewport: { width: 360, height: 800 },
      });
      await page.route("https://fit.example.test/", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<html><head><style>body{margin:20px;overflow:hidden}h1{font:72px Arial;margin:0;overflow:hidden}.line{display:block;white-space:nowrap}</style></head><body><h1><span class="line">ABCDEFGHIJKLMN</span><span class="line">UNA <em>IDEA</em></span></h1></body></html>',
        }),
      );
      await page.goto("https://fit.example.test/");
      const before = await page.evaluate(() => {
        const r = document.createRange();
        r.selectNodeContents(document.querySelector(".line")!);
        return {
          width: document.documentElement.scrollWidth,
          viewport: innerWidth,
          right: r.getBoundingClientRect().right,
          text: document.querySelector("h1")!.textContent,
        };
      });
      assert.equal(before.width, before.viewport);
      assert.ok(before.right > before.viewport);
      await page.addScriptTag({
        content: textFitRuntime([
          {
            id: "title",
            route: "/",
            selector: "h1",
            lineSelector: ".line",
            minFontSizePx: 24,
          },
        ]),
      });
      await page.waitForFunction(
        () =>
          (window as any).__BOT_MD_LAYOUT__?.results[0]?.status === "fitted",
      );
      const read = () =>
        page.evaluate(() => ({
          status: (window as any).__BOT_MD_LAYOUT__.results[0],
          size: parseFloat(
            getComputedStyle(document.querySelector("h1")!).fontSize,
          ),
          text: document.querySelector("h1")!.textContent,
          em: document.querySelectorAll("h1 em").length,
        }));
      const fitted = await read();
      assert.ok(fitted.size < 72 && fitted.size >= 24);
      assert.ok(fitted.status.clippedPx <= 0.5);
      assert.equal(fitted.text, before.text);
      assert.equal(fitted.em, 1);
      await page.setViewportSize({ width: 1200, height: 800 });
      await page.waitForFunction(
        () =>
          parseFloat(
            getComputedStyle(document.querySelector("h1")!).fontSize,
          ) === 72,
      );
      assert.equal((await read()).status.status, "pass");
      await page.evaluate(() => {
        history.pushState({}, "", "/other");
        document.querySelector(".line")!.textContent = "RUTA";
      });
      await page.waitForFunction(
        () => (window as any).__BOT_MD_LAYOUT__?.route === "/other",
      );
      assert.equal(
        await page.evaluate(
          () => (window as any).__BOT_MD_LAYOUT__.results.length,
        ),
        0,
      );
      await page.evaluate(() => {
        history.pushState({}, "", "/");
        document.querySelector(".line")!.textContent = "W".repeat(200);
      });
      await page.waitForFunction(
        () =>
          (window as any).__BOT_MD_LAYOUT__?.results[0]?.status === "clipped",
      );
      const blocked = await read();
      assert.equal(blocked.size, 24);
      assert.ok(blocked.status.clippedPx > 0);
    } finally {
      await browser.close();
    }
  },
);
