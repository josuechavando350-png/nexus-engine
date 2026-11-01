// node validation/daksh/materialized-adaptation.mjs BASE MATERIALIZED CONTENT_MAP OUTPUT_JSON
import path from "node:path";
import { routingRequestHeaders } from "../../dist/src/http-metadata.js";
import { launch } from "../../dist/src/browser.js";
import { serve } from "../../dist/src/server.js";
import { json, saveJson, hash } from "../../dist/src/common.js";
const [base, edited, contentPath, output] = process.argv.slice(2);
if (!output)
  throw new Error(
    "Provide base, materialized site, content map and output JSON.",
  );
const bindings = (await json(path.resolve(contentPath))).bindings.filter(
  (b) => b.route === "/" && b.expected !== b.value,
);
const servers = [
  await serve(path.resolve(base)),
  await serve(path.resolve(edited)),
];
const browser = await launch();
const results = [],
  noScript = [],
  missingRequests = new Map();
const ready =
  "html[data-hero-thread-complete=true][data-signature-complete=true]";
async function geometry(page) {
  return page.evaluate(() => ({
    title: document.title,
    hero: document.querySelector("#hero-title")?.textContent,
    lines: document.querySelectorAll("#hero-title .hero-line").length,
    titleClippingPx: Math.max(
      0,
      ...[...document.querySelectorAll("#hero-title .hero-line")].map(
        (line) => {
          const range = document.createRange();
          range.selectNodeContents(line);
          const rect = range.getBoundingClientRect();
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
              const bounds = parent.getBoundingClientRect();
              left = Math.max(left, bounds.left + parent.clientLeft);
              right = Math.min(
                right,
                bounds.left + parent.clientLeft + parent.clientWidth,
              );
            }
          return Math.max(left - rect.left, rect.right - right);
        },
      ),
    ),
    textFit: window.__BOT_MD_LAYOUT__ ?? null,
    introHeight: document
      .querySelector("#hero-title")
      ?.parentElement.querySelector("p")
      ?.getBoundingClientRect().height,
    overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    paths: [...document.querySelectorAll(".hero-thread-path,.thread-path")].map(
      (p) => ({ d: p.getAttribute("d"), length: p.getTotalLength() }),
    ),
  }));
}
async function check(page) {
  return page.evaluate(
    (bindings) =>
      bindings.map((b) => {
        const el = document.querySelector(b.selector);
        const value =
          b.kind === "text"
            ? el?.childNodes[b.textIndex]?.nodeValue
            : el?.getAttribute(b.attribute);
        return { id: b.id, pass: value === b.value, actual: value ?? null };
      }),
    bindings,
  );
}
async function visibleClick(page, selector) {
  const all = page.locator(selector);
  for (let i = 0; i < (await all.count()); i++) {
    if (await all.nth(i).isVisible()) {
      await all.nth(i).click();
      return;
    }
  }
  throw new Error("No visible navigation: " + selector);
}
try {
  const noJS = await browser.newContext({ javaScriptEnabled: false });
  for (const route of Object.keys(servers[1].index.routes).filter((u) =>
    servers[1].index.routes[u].mime.includes("text/html"),
  )) {
    const p = await noJS.newPage();
    await p.goto(servers[1].url + route);
    const raw = await p.content();
    noScript.push({
      route,
      title: await p.title(),
      identityAbsent: !/daksh|gajjar/i.test(raw),
    });
    await p.close();
  }
  await noJS.close();
  for (const viewport of [
    { name: "desktop", width: 1440, height: 900, touch: false },
    { name: "mobile", width: 390, height: 844, touch: true },
  ]) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1,
      hasTouch: viewport.touch,
      isMobile: viewport.touch,
      reducedMotion: "no-preference",
      serviceWorkers: "block",
    });
    const p = await context.newPage();
    p.setDefaultTimeout(20000);
    p.setDefaultNavigationTimeout(20000);
    const errors = [],
      http = [],
      rsc = [];
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("response", (r) => {
      if (
        r.status() === 404 &&
        r.request().method() === "GET" &&
        r.request().headers().rsc === "1"
      ) {
        const url = new URL(r.url());
        missingRequests.set(url.pathname + url.search, {
          path: url.pathname + url.search,
          method: "GET",
          requestHeaders: routingRequestHeaders(r.request().headers()),
        });
      }
      if (r.status() >= 400)
        http.push(
          r.status() +
            " " +
            new URL(r.url()).pathname +
            new URL(r.url()).search,
        );
      if (r.headers()["content-type"]?.includes("x-component"))
        rsc.push({
          url: new URL(r.url()).pathname + new URL(r.url()).search,
          status: r.status(),
        });
    });
    await p.goto(servers[0].url);
    await p.locator(ready).waitFor({ state: "attached", timeout: 30000 });
    const before = await geometry(p);
    await p.goto(servers[1].url);
    await p.locator(ready).waitFor({ state: "attached", timeout: 30000 });
    const after = await geometry(p);
    const checks = await check(p);
    const overlayAbsent = await p.evaluate(
      () =>
        !window.__BOT_MD_CONTENT__ &&
        !document.querySelector('script[src="/__botmd/content.js"]'),
    );
    let menu = null;
    if (await p.locator(".menu-button").isVisible()) {
      await p.locator(".menu-button").click();
      const opened = await p
        .locator(".menu-button")
        .getAttribute("aria-expanded");
      await p.locator(".menu-button").click();
      menu = {
        opened,
        closed: await p.locator(".menu-button").getAttribute("aria-expanded"),
      };
    }
    await p.evaluate(() =>
      scrollTo({ top: innerHeight * 1.5, behavior: "instant" }),
    );
    await p.waitForTimeout(1000);
    const scrolled = await p
      .locator(".thread-path")
      .evaluateAll((els) =>
        els.map((el) => getComputedStyle(el).strokeDashoffset),
      );
    await p.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
    await p.waitForTimeout(1000);
    const returned = await p
      .locator(".thread-path")
      .evaluateAll((els) =>
        els.map((el) => getComputedStyle(el).strokeDashoffset),
      );
    const motionChanged = scrolled.some((v, i) => v !== returned[i]);
    const cases = [];
    for (const project of [
      "eigna",
      "orbit",
      "mealops",
      "papertrail",
      "scribe",
      "crediflow",
    ]) {
      const route = "/work/" + project;
      await visibleClick(p, 'a[href="' + route + '#main-content"]');
      await p.waitForURL((u) => u.pathname === route);
      await p.waitForTimeout(700);
      const identityAbsent = !/daksh|gajjar/i.test(await p.content());
      const title = await p.title();
      await visibleClick(p, 'header a[href="/"]');
      await p.waitForURL((u) => u.pathname === "/");
      await p
        .locator(".hero[data-hero-entrance=complete]")
        .waitFor({ state: "attached" });
      await p.locator(ready).waitFor({ state: "attached" });
      cases.push({
        route,
        title,
        identityAbsent,
        returned: await check(p),
        titleClippingPx: (await geometry(p)).titleClippingPx,
      });
    }
    const caseIdentityAbsent = cases.every((c) => c.identityAbsent);
    await p.goBack();
    await p.waitForURL((u) => u.pathname === "/work/crediflow");
    await p.goForward();
    await p.waitForURL((u) => u.pathname === "/");
    await p
      .locator(".hero[data-hero-entrance=complete]")
      .waitFor({ state: "attached" });
    await p.locator(ready).waitFor({ state: "attached" });
    const back = await check(p);
    const navigation = cases.flatMap((c) => c.returned);
    await p.reload();
    await p.locator(ready).waitFor({ state: "attached" });
    const reload = await check(p);
    const result = {
      viewport: viewport.name,
      checks,
      back,
      navigation,
      reload,
      overlayAbsent,
      caseIdentityAbsent,
      cases,
      titleClippingPx: after.titleClippingPx,
      textFit: after.textFit,
      menu,
      motionChanged,
      curveChanged: before.paths.some((v, i) => v.d !== after.paths[i]?.d),
      introReflowed: before.introHeight !== after.introHeight,
      overflow: after.overflow,
      lines: after.lines,
      jsErrors: errors,
      httpErrors: http,
      rscRequests: rsc,
      before: {
        ...before,
        paths: before.paths.map((p) => ({
          hash: hash(p.d ?? ""),
          length: p.length,
        })),
      },
      after: {
        ...after,
        paths: after.paths.map((p) => ({
          hash: hash(p.d ?? ""),
          length: p.length,
        })),
      },
    };
    result.status =
      [checks, back, navigation, reload].every((a) => a.every((x) => x.pass)) &&
      overlayAbsent &&
      caseIdentityAbsent &&
      motionChanged &&
      result.curveChanged &&
      result.introReflowed &&
      !result.overflow &&
      after.titleClippingPx <= 0.5 &&
      cases.every((c) => c.titleClippingPx <= 0.5) &&
      after.textFit?.results.length === 1 &&
      after.textFit.results.every((r) =>
        ["pass", "fitted"].includes(r.status),
      ) &&
      after.lines === before.lines &&
      !errors.length &&
      !http.length &&
      rsc.some((r) => r.status === 200) &&
      (!viewport.touch || (menu?.opened === "true" && menu?.closed === "false"))
        ? "pass"
        : "fail";
    results.push(result);
    await context.close();
  }
} finally {
  await browser.close();
  for (const s of servers) await s.close();
}
const report = {
  createdAt: new Date().toISOString(),
  scope:
    "19 declared homepage fields compiled before delivery; 7 SSR documents; desktop/mobile hydration, menu, SVG reflow, scroll, client navigation across all six projects, history and reload, text clipping. Identity terms only; not removal of all source content.",
  expectedBindings: bindings.length,
  missingRequestLog: {
    schemaVersion: 1,
    sourceOrigin: servers[1].index.origin,
    requests: [...missingRequests.values()],
  },
  noScript,
  results,
};
await saveJson(path.resolve(output), report);
console.log(
  JSON.stringify(
    {
      noScript,
      results: results.map((r) => ({
        viewport: r.viewport,
        status: r.status,
        checks: r.checks.filter((c) => !c.pass),
        back: r.back.filter((c) => !c.pass),
        navigation: r.navigation.filter((c) => !c.pass),
        reload: r.reload.filter((c) => !c.pass),
        menu: r.menu,
        motion: r.motionChanged,
        overflow: r.overflow,
        titleClippingPx: r.titleClippingPx,
        textFit: r.textFit,
        cases: r.cases.map((c) => ({
          route: c.route,
          identityAbsent: c.identityAbsent,
          fields: c.returned.every((f) => f.pass),
          titleClippingPx: c.titleClippingPx,
        })),
        errors: r.jsErrors,
        http: r.httpErrors,
        rsc: r.rscRequests.length,
      })),
    },
    null,
    2,
  ),
);
process.exitCode =
  results.every((r) => r.status === "pass") &&
  noScript.every((r) => r.identityAbsent)
    ? 0
    : 2;
