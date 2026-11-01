// npm run build; node validation/daksh/record-navigation.mjs OUTPUT_JSON
import path from "node:path";
import { launch } from "../../dist/src/browser.js";
import { routingRequestHeaders } from "../../dist/src/http-metadata.js";
import { saveJson } from "../../dist/src/common.js";
const output = process.argv[2];
if (!output) throw new Error("Provide output JSON");
const source = "https://dakshgajjar.com/",
  browser = await launch(true),
  observed = new Map(),
  visited = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "no-preference",
  });
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(30000);
  page.on("response", (r) => {
    const req = r.request();
    if (
      req.method() === "GET" &&
      new URL(r.url()).origin === new URL(source).origin
    )
      observed.set(r.url(), {
        url: r.url(),
        status: r.status(),
        mime: r.headers()["content-type"] ?? "",
        requestHeaders: routingRequestHeaders(req.headers()),
      });
  });
  await page.goto(source);
  for (const project of [
    "eigna",
    "orbit",
    "mealops",
    "papertrail",
    "scribe",
    "crediflow",
  ]) {
    await page
      .locator(".hero[data-hero-entrance=complete]")
      .waitFor({ state: "attached" });
    await page
      .locator(`a.world-link[href="/work/${project}#main-content"]`)
      .click();
    await page.waitForURL((u) => u.pathname === "/work/" + project);
    await page.waitForTimeout(500);
    visited.push({
      route: new URL(page.url()).pathname,
      title: await page.title(),
    });
    await page.locator('header a[href="/"]').click();
    await page.waitForURL((u) => u.pathname === "/");
  }
  await saveJson(path.resolve(output), {
    createdAt: new Date().toISOString(),
    source,
    viewport: { width: 1440, height: 900 },
    visited,
    observedRequests: [...observed.values()],
  });
  console.log(
    JSON.stringify(
      {
        visited,
        requests: observed.size,
        errors: [...observed.values()].filter((r) => r.status >= 400),
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
