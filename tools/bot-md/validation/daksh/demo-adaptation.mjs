// node validation/daksh/demo-adaptation.mjs SITE COVERAGE PLAN OUTPUT_DIRECTORY
import path from "node:path";
import { readFile } from "node:fs/promises";
import { launch } from "../../dist/src/browser.js";
import { serve } from "../../dist/src/server.js";
import { routingRequestHeaders } from "../../dist/src/http-metadata.js";
import { hash, json, newDirectory, saveJson } from "../../dist/src/common.js";
const [site, coveragePath, planPath, output] = process.argv.slice(2);
if (!output)
  throw new Error("Provide site, coverage, plan and a new output directory.");
await newDirectory(path.resolve(output));
const coverage = await json(path.resolve(coveragePath)),
  plan = await json(path.resolve(planPath));
const server = await serve(path.resolve(site)),
  browser = await launch();
const routes = [...new Set(coverage.covered.map((b) => b.route))];
const ready =
  "html[data-hero-thread-complete=true][data-signature-complete=true]";
const snapshots = [],
  svg = [],
  scroll = [],
  errors = [],
  httpErrors = [],
  missingRequests = new Map();
async function check(page, route, state, viewport) {
  const result = await page.evaluate(
    ({ bindings, oldPaths }) => ({
      fields: bindings.map((b) => {
        const el = document.querySelector(b.selector);
        const actual =
          b.kind === "text"
            ? el?.childNodes[b.textIndex]?.nodeValue
            : el?.getAttribute(b.attribute);
        return { id: b.id, pass: actual === b.value, actual: actual ?? null };
      }),
      oldPaths: [...document.querySelectorAll("path[d]")].filter((p) =>
        oldPaths.includes(p.getAttribute("d")),
      ).length,
      overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      titleClippingPx: Math.max(
        0,
        ...[...document.querySelectorAll("#hero-title .hero-line")].map(
          (line) => {
            const range = document.createRange();
            range.selectNodeContents(line);
            const r = range.getBoundingClientRect();
            let left = 0,
              right = innerWidth;
            for (
              let parent = line.parentElement;
              parent;
              parent = parent.parentElement
            )
              if (
                /(hidden|clip|auto|scroll)/.test(
                  getComputedStyle(parent).overflowX,
                )
              ) {
                const b = parent.getBoundingClientRect();
                left = Math.max(left, b.left + parent.clientLeft);
                right = Math.min(
                  right,
                  b.left + parent.clientLeft + parent.clientWidth,
                );
              }
            return Math.max(left - r.left, r.right - right);
          },
        ),
      ),
    }),
    {
      bindings: coverage.covered.filter((b) => b.route === route),
      oldPaths: plan.svgPaths.map((p) => p.from),
    },
  );
  snapshots.push({ route, state, viewport, ...result });
}
async function clickVisible(page, selector) {
  const all = page.locator(selector);
  for (let i = 0; i < (await all.count()); i++)
    if (await all.nth(i).isVisible()) {
      await all.nth(i).click();
      return;
    }
  throw new Error("No visible target: " + selector);
}
try {
  for (const viewport of [
    { name: "desktop", width: 1440, height: 900, touch: false },
    { name: "mobile", width: 390, height: 844, touch: true },
  ]) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.touch,
      isMobile: viewport.touch,
      deviceScaleFactor: 1,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on("pageerror", (e) =>
      errors.push({
        viewport: viewport.name,
        url: page.url(),
        message: e.message,
      }),
    );
    page.on("response", (r) => {
      if (
        r.status() === 404 &&
        r.request().method() === "GET" &&
        r.request().headers().rsc === "1"
      ) {
        const u = new URL(r.url());
        missingRequests.set(u.pathname + u.search, {
          path: u.pathname + u.search,
          method: "GET",
          requestHeaders: routingRequestHeaders(r.request().headers()),
        });
      }
      if (r.status() >= 400)
        httpErrors.push({
          viewport: viewport.name,
          url: r.url().replace(server.url, ""),
          status: r.status(),
        });
    });
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
    await page.goto(server.url);
    await page
      .locator(".loader-signature path")
      .first()
      .waitFor({ state: "attached" });
    // React may mount after network delivery. Advance the controlled clock while retaining the loader.
    await page.clock.runFor(150);
    const paths = await page
      .locator(".loader-signature path")
      .evaluateAll((ps) =>
        ps.map((p) => ({ d: p.getAttribute("d"), length: p.getTotalLength() })),
      );
    svg.push({
      viewport: viewport.name,
      state: "hydrated-loader",
      paths: paths.map((p, i) => ({
        id: plan.svgPaths[i].id,
        sha256: hash(p.d),
        length: p.length,
        pass: p.d === plan.svgPaths[i].to && p.length > 0,
      })),
    });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    let ticks = 0,
      loaderCaptured = false;
    while (!(await page.locator(ready).count())) {
      if (ticks >= 20000)
        throw new Error(
          "Controlled readiness timeout: " +
            JSON.stringify(
              await page.locator("html").evaluate((e) => ({ ...e.dataset })),
            ),
        );
      await page.clock.runFor(100);
      ticks += 100;
      await page.waitForTimeout(20);
      if (
        !loaderCaptured &&
        (await page
          .locator("html[data-signature-complete=true] .loader-signature")
          .count())
      ) {
        await page.screenshot({
          path: path.join(output, viewport.name + "-loader.png"),
        });
        loaderCaptured = true;
      }
    }
    await page.clock.resume();
    await check(page, "/", "initial", viewport.name);
    const small = await page
      .locator("path.eigna-signature")
      .evaluateAll((ps) =>
        ps.map((p) => ({ d: p.getAttribute("d"), length: p.getTotalLength() })),
      );
    svg.push({
      viewport: viewport.name,
      state: "hydrated-small-signature",
      paths: small.map((p) => ({
        id: "small-monogram",
        sha256: hash(p.d),
        length: p.length,
        pass: p.d === plan.svgPaths.at(-1).to && p.length > 0,
      })),
    });
    const initial = await page
      .locator(".thread-path")
      .evaluateAll((ps) => ps.map((p) => getComputedStyle(p).strokeDashoffset));
    await page.evaluate(() =>
      scrollTo({ top: innerHeight * 1.5, behavior: "instant" }),
    );
    await page.waitForTimeout(700);
    const advanced = await page
      .locator(".thread-path")
      .evaluateAll((ps) => ps.map((p) => getComputedStyle(p).strokeDashoffset));
    await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
    await page.waitForTimeout(700);
    const returned = await page
      .locator(".thread-path")
      .evaluateAll((ps) => ps.map((p) => getComputedStyle(p).strokeDashoffset));
    scroll.push({
      viewport: viewport.name,
      initial,
      advanced,
      returned,
      pass:
        advanced.some((x, i) => x !== initial[i]) &&
        returned.some((x, i) => x !== advanced[i]),
    });
    await page.screenshot({
      path: path.join(output, viewport.name + "-home.png"),
    });
    for (const route of routes.filter((r) => r !== "/")) {
      await clickVisible(page, 'a[href="' + route + '#main-content"]');
      await page.waitForURL((u) => u.pathname === route);
      await page.waitForTimeout(700);
      await check(page, route, "client-navigation", viewport.name);
      if (route === "/work/eigna")
        await page.screenshot({
          path: path.join(output, viewport.name + "-project.png"),
        });
      await page.reload();
      await page.waitForTimeout(700);
      await check(page, route, "reload", viewport.name);
      await clickVisible(page, 'header a[href="/"]');
      await page.waitForURL((u) => u.pathname === "/");
      await page.locator(ready).waitFor({ state: "attached" });
      await check(page, "/", "return-from-" + route, viewport.name);
    }
    await page.goBack();
    await page.waitForURL((u) => u.pathname === routes.at(-1));
    await page.waitForTimeout(700);
    await check(page, routes.at(-1), "history-back", viewport.name);
    await page.goForward();
    await page.waitForURL((u) => u.pathname === "/");
    await page.locator(ready).waitFor({ state: "attached" });
    await check(page, "/", "history-forward", viewport.name);
    await context.close();
    const noJS = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.touch,
      hasTouch: viewport.touch,
    });
    const p = await noJS.newPage();
    for (const route of routes) {
      await p.goto(server.url + route);
      await check(p, route, "server-html-no-js", viewport.name);
    }
    await noJS.close();
  }
} catch (e) {
  errors.push({ fatal: String(e) });
} finally {
  await browser.close();
  await server.close();
}
const served = [];
for (const [route, r] of Object.entries(server.index.routes)) {
  const body = await readFile(path.join(site, r.file));
  served.push({
    route,
    sha256: hash(body),
    originalGeometryPresent: plan.svgPaths
      .filter((p) => body.includes(p.from))
      .map((p) => p.id),
  });
}
const result = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  sourceDigest: server.index.sourceDigest,
  planSha256: hash(await readFile(planPath)),
  coverageSha256: hash(await readFile(coveragePath)),
  browser: "Chromium",
  viewports: [
    { width: 1440, height: 900, touch: false },
    { width: 390, height: 844, touch: true },
  ],
  coveredFields: coverage.coveredCount,
  pendingFields: coverage.pendingCount,
  snapshots,
  svg,
  scroll,
  errors,
  httpErrors,
  missingRequestLog: {
    schemaVersion: 1,
    sourceOrigin: server.index.origin,
    requests: [...missingRequests.values()],
  },
  served,
  limitations: [
    "Draft copy only; pending catalog fields and other graphics remain.",
    "Scroll test checks forward/backward behavior; it is not a temporal equivalence comparison for the changed layout.",
    "Declared routes and states in Chromium only; no backend submission or universal website claim.",
  ],
};
result.status =
  snapshots.length === 56 &&
  svg.length === 4 &&
  scroll.length === 2 &&
  snapshots.every(
    (s) =>
      s.fields.length &&
      s.fields.every((f) => f.pass) &&
      !s.oldPaths &&
      !s.overflow &&
      (s.state === "server-html-no-js" || s.titleClippingPx <= 0.5),
  ) &&
  svg.every((s) => s.paths.length && s.paths.every((p) => p.pass)) &&
  scroll.every((s) => s.pass) &&
  !errors.length &&
  !httpErrors.length &&
  served.every((f) => !f.originalGeometryPresent.length)
    ? "pass"
    : "fail";
await saveJson(path.join(output, "report.json"), result);
console.log(
  JSON.stringify(
    {
      status: result.status,
      snapshots: snapshots.length,
      failed: snapshots
        .filter(
          (s) => s.fields.some((f) => !f.pass) || s.oldPaths || s.overflow,
        )
        .map((s) => ({ ...s, fields: s.fields.filter((f) => !f.pass) })),
      svg,
      scroll,
      errors,
      httpErrors,
    },
    null,
    2,
  ),
);
process.exitCode = result.status === "pass" ? 0 : 2;
