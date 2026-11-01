import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile } from "node:fs/promises";
import { validatePathData, validateSVGPaths } from "../src/svg-paths.js";
import { materialize } from "../src/materialize.js";
import { hash, json, save, saveJson } from "../src/common.js";
import { launch } from "../src/browser.js";
import { serve } from "../src/server.js";
import type { Build } from "../src/types.js";

test("SVG replacement rejects ambiguous, malformed, empty and executable shapes", () => {
  for (const value of [
    "",
    "L0 0",
    "M0",
    "M0 0 Z8",
    "M0 0 X4 2",
    "M0 0 A-2 3 0 0 1 4 5",
    "M0 0 A2 3 0 2 1 4 5",
    "M0 0 L1e300 2",
    "M0,,0",
    "M0 0,",
    ",M0 0",
    'M0 0\" onload=\"alert(1)',
  ])
    assert.throws(() => validatePathData(value), /SVG/);
  validatePathData("M .5 -1e2 C 1 2 3 4 5 6 L 8 9 A 4 5 20 0 1 10 10 z");
  assert.throws(
    () =>
      validateSVGPaths([
        { id: "a", from: "M0 0L1 1", to: "M0 0 L2 2" },
        { id: "b", from: "M0 0L1 1", to: "M0 0 L3 3" },
      ]),
    /ambigua/,
  );
});

test(
  "authored SVG replaces SSR, JS arrays, JSON and Flight data, survives reload, and preserves independent scroll animation",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bot-md-graphics-")),
      base = path.join(root, "base"),
      out = path.join(root, "out"),
      old = "M 5 5 C 40 60 80 0 110 60",
      own = "M 10 10 L 40 90 L 70 10 L 100 90",
      thread = "M 0 0 L 0 500";
    const index: Build = {
      schemaVersion: 1,
      sourceDigest: "f".repeat(64),
      origin: "https://old.example.test",
      routes: {},
      missing: [],
      patches: [],
    };
    const stream = "0:T" + Buffer.byteLength(old).toString(16) + "," + old;
    const files: Record<string, [string, string]> = {
      "/": [
        "text/html",
        `<!doctype html><html><head><link rel="icon" href="data:,"><style>body{height:2500px}svg{height:150px;width:150px}</style></head><body><svg><path id="mark" d="${old}"/><path id="thread" d="${thread}"/></svg><button>Datos</button><script src="/app.js"></script></body></html>`,
      ],
      "/app.js": [
        "application/javascript",
        `const shapes=[${JSON.stringify(old)}];document.querySelector('#mark').setAttribute('d',shapes[0]);addEventListener('scroll',()=>document.querySelector('#thread').style.strokeDashoffset=String(scrollY));document.querySelector('button').onclick=async()=>{const j=await(await fetch('/data.json')).json();const f=await(await fetch('/data.rsc')).text();window.received=[j.d,f.slice(f.indexOf(',')+1)];document.querySelector('#mark').setAttribute('d',j.d)};window.ready=true;`,
      ],
      "/data.json": ["application/json", JSON.stringify({ d: old })],
      "/data.rsc": ["text/x-component", stream],
    };
    for (const [route, [mime, body]] of Object.entries(files)) {
      const file = hash(route);
      await save(path.join(base, file), body);
      index.routes[route] = {
        file,
        mime,
        status: 200,
        sourceUrl: index.origin + route,
        sha256: hash(body),
      };
    }
    await saveJson(path.join(base, "routes.json"), index);
    const plan = {
      schemaVersion: 1 as const,
      replacements: [],
      svgPaths: [{ id: "mark", from: old, to: own }],
    };
    const report = await materialize(base, plan, out);
    assert.equal(report.status, "materialized");
    assert.deepEqual(report.svgCounts.mark, {
      html: 1,
      javascript: 1,
      json: 1,
      flight: 1,
    });
    const built = await json<Build>(path.join(out, "routes.json"));
    for (const r of Object.values(built.routes))
      assert.ok(
        !(await readFile(path.join(out, r.file), "utf8")).includes(old),
      );
    assert.ok(
      (
        await readFile(path.join(base, index.routes["/"].file), "utf8")
      ).includes(old),
    );
    const browser = await launch(),
      server = await serve(out);
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      assert.ok((await (await fetch(server.url)).text()).includes(own));
      await page.goto(server.url);
      await page.waitForFunction(() => (window as any).ready);
      assert.equal(await page.locator("#mark").getAttribute("d"), own);
      const length = await page
        .locator("#mark")
        .evaluate((p: any) => p.getTotalLength());
      assert.ok(length > 200);
      await page.locator("button").click();
      await page.waitForFunction(() => (window as any).received);
      assert.deepEqual(await page.evaluate(() => (window as any).received), [
        own,
        own,
      ]);
      await page.evaluate(() => scrollTo(0, 800));
      await page.waitForFunction(
        () =>
          document.querySelector<SVGPathElement>("#thread")!.style
            .strokeDashoffset === "800",
      );
      assert.equal(await page.locator("#thread").getAttribute("d"), thread);
      await page.reload();
      await page.waitForFunction(() => (window as any).ready);
      assert.equal(await page.locator("#mark").getAttribute("d"), own);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await server.close();
    }
    const unmatched = await materialize(
      base,
      { ...plan, svgPaths: [{ id: "missing", from: "M99 99L50 1", to: own }] },
      path.join(root, "missing"),
    );
    assert.equal(unmatched.status, "blocked");
    assert.deepEqual(unmatched.unmatchedSVGPaths, ["missing"]);
  },
);
