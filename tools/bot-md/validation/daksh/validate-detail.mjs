// node validation/daksh/validate-detail.mjs PACKAGE NEW_EVIDENCE_DIRECTORY
import path from "node:path";
import { readFile } from "node:fs/promises";
import { launch } from "../../dist/src/browser.js";
import { serve } from "../../dist/src/server.js";
import { hash, json, newDirectory, saveJson } from "../../dist/src/common.js";
const [site, out] = process.argv.slice(2);
if (!out) throw new Error("Provide component package and evidence directory");
await newDirectory(path.resolve(out));
const extraction = await json(path.join(site, "extraction.json")),
  definition = await json(path.join(site, "effect.json"));
const server = await serve(path.resolve(site)),
  browser = await launch();
const results = [],
  errors = [],
  responses = [],
  requests = [];
try {
  for (const observed of extraction.observations) {
    const v = observed.viewport,
      p = await browser.newPage({
        viewport: { width: v.width, height: v.height },
        deviceScaleFactor: 1,
        isMobile: v.touch ?? false,
        hasTouch: v.touch ?? false,
      });
    p.setDefaultTimeout(10000);
    p.on("pageerror", (e) =>
      errors.push({ viewport: v.name, error: e.message }),
    );
    p.on("request", (r) => requests.push(r.url().replace(server.url, "")));
    p.on("response", (r) => {
      if (r.status() >= 400)
        responses.push({
          status: r.status(),
          url: r.url().replace(server.url, ""),
        });
    });
    await p.goto(server.url);
    await p.waitForFunction(() => window.botMDExample);
    await p.evaluate(() =>
      window.botMDExample.controller.setOptions({ smoothingMs: 0 }),
    );
    const geometry = await p.locator(".bot-md-thread-line").evaluate((el) => {
      const length = el.getTotalLength();
      return {
        d: el.getAttribute("d"),
        length,
        points: Array.from({ length: 33 }, (_, i) => {
          const p = el.getPointAtLength((length * i) / 32);
          return { x: p.x, y: p.y };
        }),
      };
    });
    const distances = geometry.points.map((p, i) =>
      Math.hypot(p.x - observed.points[i].x, p.y - observed.points[i].y),
    );
    const steps = [];
    for (const desired of [0, 0.25, 0.5, 0.75, 1, 0.5, 0]) {
      await p.evaluate((value) => {
        const r = document.querySelector("#detail").getBoundingClientRect();
        scrollTo(
          0,
          r.top +
            scrollY -
            innerHeight * 0.85 +
            value * (r.height + innerHeight * 0.6),
        );
      }, desired);
      await p.waitForFunction(
        (value) =>
          Math.abs(window.botMDExample.controller.getState().progress - value) <
          0.002,
        desired,
      );
      steps.push(
        await p.evaluate((desired) => {
          const state = window.botMDExample.controller.getState(),
            line = document.querySelector(".bot-md-thread-line"),
            head = document.querySelector(".bot-md-thread-head");
          const point = line
            .getPointAtLength(line.getTotalLength() * state.progress)
            .matrixTransform(line.getScreenCTM());
          const h = new DOMPoint(
            Number(head.getAttribute("cx")),
            Number(head.getAttribute("cy")),
          ).matrixTransform(head.getScreenCTM());
          const ring = document.querySelector(".bot-md-thread-ring");
          return {
            desired,
            ...state,
            dashoffset: Number.parseFloat(
              getComputedStyle(line).strokeDashoffset,
            ),
            headErrorPx: Math.hypot(h.x - point.x, h.y - point.y),
            ringVisibility: getComputedStyle(ring).visibility,
          };
        }, desired),
      );
      if (desired === 0.5 && steps.length === 3)
        await p.screenshot({ path: path.join(out, v.name + "-middle.png") });
      if (desired === 1)
        await p.screenshot({ path: path.join(out, v.name + "-complete.png") });
    }
    await p.emulateMedia({ reducedMotion: "reduce" });
    await p.waitForFunction(
      () => window.botMDExample.controller.getState().progress === 1,
    );
    const reduced = await p.evaluate(() =>
      window.botMDExample.controller.getState(),
    );
    await p.emulateMedia({ reducedMotion: "no-preference" });
    await p.waitForFunction(
      () => window.botMDExample.controller.getState().progress < 0.002,
    );
    const integration = await p.evaluate(() => {
      const { definition, mountScrollThread } = window.botMDExample;
      const host = document.createElement("section");
      host.style.cssText = "width:320px;height:500px;";
      const button = document.createElement("button");
      button.textContent = "Mi contenido";
      host.append(button);
      document.body.append(host);
      let clicks = 0;
      button.onclick = () => clicks++;
      const instance = mountScrollThread(host, definition, { smoothingMs: 0 });
      const state = instance.getState();
      button.click();
      instance.destroy();
      const clean = !host.querySelector("svg") && host.style.position === "";
      host.remove();
      return { variant: state.variant, clicks, clean };
    });
    const result = {
      viewport: v,
      sourcePointErrorMax: Math.max(...distances),
      sourceLengthError: Math.abs(geometry.length - observed.length),
      sourcePathMatches: hash(geometry.d) === observed.sourcePathSha256,
      steps,
      reduced,
      integration,
    };
    result.status =
      result.sourcePointErrorMax <= 0.01 &&
      result.sourceLengthError <= 0.01 &&
      result.sourcePathMatches &&
      steps.every(
        (s) =>
          Math.abs(s.progress - s.desired) < 0.002 &&
          s.headErrorPx <= 0.1 &&
          (s.desired !== 1 || s.ringVisibility === "visible"),
      ) &&
      reduced.reducedMotion &&
      reduced.progress === 1 &&
      integration.variant === "mobile" &&
      integration.clicks === 1 &&
      integration.clean
        ? "pass"
        : "fail";
    results.push(result);
    await p.close();
  }
} catch (e) {
  errors.push({ fatal: String(e) });
} finally {
  await browser.close();
  await server.close();
}
const files = [];
for (const [route, r] of Object.entries(server.index.routes)) {
  const bytes = await readFile(path.join(site, r.file));
  files.push({ route, file: r.file, sha256: hash(bytes), bytes: bytes.length });
}
const report = {
  schemaVersion: 1,
  version: "0.7.0",
  status:
    results.length === extraction.observations.length &&
    results.every((r) => r.status === "pass") &&
    !errors.length &&
    !responses.length &&
    requests.every((r) => r.startsWith("/"))
      ? "pass"
      : "fail",
  sourceDigest: extraction.sourceDigest,
  scope:
    "Selected SVG trajectory and styles; own portable scroll controller. No claim of matching original timing or complete source page.",
  results,
  errors,
  httpErrors: responses,
  requestedRoutes: [...new Set(requests)],
  files,
  definitionSha256: hash(await readFile(path.join(site, "effect.json"))),
  extractionSha256: hash(await readFile(path.join(site, "extraction.json"))),
};
await saveJson(path.join(out, "report.json"), report);
console.log(
  JSON.stringify(
    {
      status: report.status,
      results: results.map((r) => ({
        viewport: r.viewport.name,
        status: r.status,
        geometry: r.sourcePointErrorMax,
        head: Math.max(...r.steps.map((s) => s.headErrorPx)),
        reduced: r.reduced,
        integration: r.integration,
      })),
      errors,
      http: responses,
    },
    null,
    2,
  ),
);
process.exitCode = report.status === "pass" ? 0 : 2;
