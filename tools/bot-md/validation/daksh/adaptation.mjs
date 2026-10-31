// Run after npm run build: node validation/daksh/adaptation.mjs ORIGINAL_SITE EDITABLE_SITE OUTPUT_JSON
import path from "node:path";
import { launch } from "../../dist/src/browser.js";
import { serve } from "../../dist/src/server.js";
import { hash, saveJson, json } from "../../dist/src/common.js";
const [original, editable, output] = process.argv.slice(2);
if (!original || !editable || !output)
  throw new Error("Provide original site, editable site and output JSON.");
const content = await json(path.join(path.resolve(editable), "content.json"));
const expectedBindings = content.bindings.filter(
  (b) => b.route === "/" && b.expected !== b.value,
).length;
const sources = [
  await serve(path.resolve(original)),
  await serve(path.resolve(editable)),
];
const browser = await launch();
const results = [];
try {
  for (const viewport of [
    { name: "desktop", width: 1440, height: 900, touch: false },
    { name: "mobile", width: 390, height: 844, touch: true },
  ]) {
    const pair = [];
    for (let i = 0; i < sources.length; i++) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        hasTouch: viewport.touch,
        isMobile: viewport.touch,
        reducedMotion: "no-preference",
        locale: "es-MX",
        timezoneId: "UTC",
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      const jsErrors = [],
        httpErrors = [];
      page.on("pageerror", (e) => jsErrors.push(e.message));
      page.on("response", (r) => {
        if (r.status() >= 400)
          httpErrors.push(
            r.status() +
              " " +
              new URL(r.url()).pathname +
              new URL(r.url()).search,
          );
      });
      await page.goto(sources[i].url, { waitUntil: "domcontentloaded" });
      await page.locator(".hero[data-hero-entrance=complete]").waitFor();
      if (i) await page.waitForFunction(() => window.__BOT_MD_CONTENT__?.ready);
      await page.waitForTimeout(1800);
      const geometry = await page.evaluate(() => ({
        documentTitle: document.title,
        description: document
          .querySelector("meta[name=description]")
          ?.getAttribute("content"),
        brand:
          document.querySelector(".site-header a")?.textContent ??
          document.querySelector("header a")?.textContent,
        title: document.querySelector("#hero-title").textContent,
        titleLines: document.querySelectorAll("#hero-title .hero-line").length,
        heroHeight: document.querySelector(".hero").getBoundingClientRect()
          .height,
        introHeight: document
          .querySelector("#hero-title")
          .parentElement.querySelector("p")
          .getBoundingClientRect().height,
        documentHeight: document.documentElement.scrollHeight,
        overflowX: Math.max(
          0,
          document.documentElement.scrollWidth - innerWidth,
        ),
        paths: [
          ...document.querySelectorAll(".hero-thread-path,.thread-path"),
        ].map((el) => ({
          d: el.getAttribute("d"),
          length: el.getTotalLength(),
          dash: getComputedStyle(el).strokeDashoffset,
        })),
        content: window.__BOT_MD_CONTENT__ ?? null,
        input: {
          reduced: matchMedia("(prefers-reduced-motion:reduce)").matches,
          touchPoints: navigator.maxTouchPoints,
        },
      }));
      const menuVisible = await page.locator(".menu-button").isVisible();
      let menuOpened = null,
        menuClosed = null;
      if (menuVisible) {
        await page.locator(".menu-button").click();
        menuOpened = await page
          .locator(".menu-button")
          .getAttribute("aria-expanded");
        await page.locator(".menu-button").click();
        menuClosed = await page
          .locator(".menu-button")
          .getAttribute("aria-expanded");
      }
      const desktopNavigationVisible = await page
        .locator("#primary-navigation")
        .isVisible();
      await page.evaluate(() =>
        scrollTo({ top: innerHeight * 1.5, behavior: "instant" }),
      );
      await page.waitForTimeout(1000);
      const scrolled = await page
        .locator(".thread-path")
        .evaluateAll((els) =>
          els.map((el) => getComputedStyle(el).strokeDashoffset),
        );
      // Compare the document thread separately from the hero decoration.
      await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
      await page.waitForTimeout(1000);
      const returned = await page
        .locator(".thread-path")
        .evaluateAll((els) =>
          els.map((el) => getComputedStyle(el).strokeDashoffset),
        );
      const motionChanged = scrolled.some((s, j) => s !== returned[j]);
      pair.push({
        ...geometry,
        paths: geometry.paths.map((p) => ({
          dHash: hash(p.d ?? ""),
          length: p.length,
        })),
        menuVisible,
        menuOpened,
        menuClosed,
        desktopNavigationVisible,
        motionChanged,
        jsErrors,
        httpErrors,
      });
      await context.close();
    }
    const [before, after] = pair;
    const curveChanged = before.paths.some(
      (p, i) => p.dHash !== after.paths[i]?.dHash,
    );
    const adapted =
      curveChanged &&
      after.introHeight !== before.introHeight &&
      after.titleLines === before.titleLines &&
      after.content?.applied.length === expectedBindings &&
      !after.content?.missing.length &&
      !after.content?.conflicts.length &&
      (viewport.touch
        ? after.menuOpened === "true" && after.menuClosed === "false"
        : after.desktopNavigationVisible) &&
      after.motionChanged &&
      !after.jsErrors.length &&
      !after.httpErrors.length &&
      !after.overflowX;
    results.push({
      viewport: viewport.name,
      status: adapted ? "pass" : "fail",
      curveChanged,
      original: before,
      edited: after,
    });
  }
} finally {
  await browser.close();
  for (const server of sources) await server.close();
}
await saveJson(path.resolve(output), {
  createdAt: new Date().toISOString(),
  scope:
    "Declared homepage fields; adaptation, not identity or removal of every original content item. Metadata is checked in the rendered DOM, not certified for non-JavaScript crawlers.",
  expectedBindings,
  results,
});
console.log(
  JSON.stringify(
    results.map((r) => ({
      viewport: r.viewport,
      status: r.status,
      curveChanged: r.curveChanged,
      heights: [r.original.heroHeight, r.edited.heroHeight],
      applied: r.edited.content?.applied,
      missing: r.edited.content?.missing,
      conflicts: r.edited.content?.conflicts,
      menu: [r.edited.menuOpened, r.edited.menuClosed],
      motion: r.edited.motionChanged,
      overflow: r.edited.overflowX,
      js: r.edited.jsErrors,
      http: r.edited.httpErrors,
    })),
    null,
    2,
  ),
);
process.exitCode = results.some((r) => r.status === "fail") ? 2 : 0;
