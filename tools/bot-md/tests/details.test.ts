import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, access } from "node:fs/promises";
import { PNG } from "pngjs";
import { extractScrollDetail, validateDetailConfig } from "../src/details.js";
import { validateScrollDetail } from "../src/detail-runtime.js";
import { save, saveJson, json, hash } from "../src/common.js";
import { serve } from "../src/server.js";
import { launch } from "../src/browser.js";
import type { DetailConfig, ScrollDetail } from "../src/detail-types.js";
import type { Build } from "../src/types.js";

const config: DetailConfig = {
  schemaVersion: 1,
  kind: "scroll-svg",
  route: "/",
  selector: "#selected",
  readySelector: "html[data-ready=true]",
  viewports: [
    { name: "mobile", width: 390, height: 844, minWidth: 0, touch: true },
    { name: "desktop", width: 1440, height: 900, minWidth: 768 },
  ],
};
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "bot-md-detail-")),
    site = path.join(root, "base");
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>body{margin:0;height:3000px}svg{width:100%;height:400px}path{fill:none;stroke:#ff3b12;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}</style></head><body><h1>UNRELATED ORIGINAL INFORMATION</h1><svg viewBox="0 0 400 400"><path id="selected" d="M 350 20 C 350 200 50 200 50 380"/><path id="other" d="M10 10 L20 20"/></svg><script>if(innerWidth>=768)document.querySelector('#selected').setAttribute('d','M 350 20 C 350 320 120 50 120 380');document.documentElement.dataset.ready='true';window.originalPrivateRuntime='NOT PART OF THE EXPORT';</script></body></html>`;
  await save(path.join(site, "index.html"), html);
  const index: Build = {
    schemaVersion: 1,
    origin: "https://source.example.test",
    sourceDigest: "a".repeat(64),
    routes: {
      "/": {
        file: "index.html",
        mime: "text/html",
        status: 200,
        sourceUrl: "https://source.example.test/",
        sha256: hash(html),
      },
    },
    missing: [],
    patches: [],
  };
  await saveJson(path.join(site, "routes.json"), index);
  return { root, site };
}
test("detail configuration rejects ambiguous breakpoints and active data", () => {
  assert.throws(
    () => validateDetailConfig({ ...config, route: "//other.test/" }),
    /inválida/,
  );
  assert.throws(
    () => validateDetailConfig({ ...config, viewports: [config.viewports[1]] }),
    /ancho 0/,
  );
  assert.throws(
    () =>
      validateDetailConfig({
        ...config,
        viewports: [config.viewports[0], config.viewports[0]],
      }),
    /inválido/,
  );
  const definition: ScrollDetail = {
    schemaVersion: 1,
    kind: "scroll-svg",
    variants: [
      {
        name: "base",
        minWidth: 0,
        path: "M0 0 L10 10",
        viewBox: [0, 0, 10, 10],
        transform: [1, 0, 0, 1, 0, 0],
        stroke: "#ff3b12",
        strokeWidth: 2,
        linecap: "round",
        linejoin: "round",
      },
    ],
  };
  validateScrollDetail(definition);
  assert.throws(
    () =>
      validateScrollDetail({
        ...definition,
        variants: [
          { ...definition.variants[0], path: 'M0 0" onload="alert(1)' },
        ],
      }),
    /Invalid/,
  );
  assert.throws(
    () =>
      validateScrollDetail({
        ...definition,
        variants: [
          {
            ...definition.variants[0],
            stroke: "url(https://other.test/image)",
          },
        ],
      }),
    /Invalid/,
  );
});

test(
  "selected SVG exports a standalone package; scroll painting, responsive variants, reduced motion and cleanup work without source resources",
  { timeout: 45000 },
  async () => {
    const { root, site } = await fixture(),
      out = path.join(root, "detail");
    const report = await extractScrollDetail(site, config, out);
    assert.equal(report.observations.length, 2);
    const built = await json<Build>(path.join(out, "routes.json"));
    assert.equal(Object.keys(built.routes).length, 6);
    for (const r of Object.values(built.routes)) {
      const body = await readFile(path.join(out, r.file), "utf8");
      assert.ok(!body.includes("UNRELATED ORIGINAL INFORMATION"));
      assert.ok(!body.includes("originalPrivateRuntime"));
      assert.ok(!body.includes("source.example.test"));
    }
    const browser = await launch(),
      server = await serve(out);
    try {
      const p = await browser.newPage({
          viewport: { width: 390, height: 844 },
        }),
        errors: string[] = [],
        requests: string[] = [];
      p.on("pageerror", (e) => errors.push(e.message));
      p.on("request", (r) => requests.push(r.url()));
      await p.goto(server.url);
      await p.waitForFunction(() => (window as any).botMDExample);
      await p.evaluate(() => {
        const x = (window as any).botMDExample;
        x.controller.setOptions({ smoothingMs: 0, headRadius: 0 });
        document
          .querySelector<HTMLElement>("#detail")!
          .style.setProperty("--bot-md-thread-color", "#0088ff");
      });
      async function move(progress: number) {
        await p.evaluate((progress) => {
          const r = document.querySelector("#detail")!.getBoundingClientRect();
          scrollTo(
            0,
            r.top +
              scrollY -
              innerHeight * 0.85 +
              progress * (r.height + innerHeight * 0.6),
          );
        }, progress);
        await p.waitForFunction(
          (progress) =>
            Math.abs(
              (window as any).botMDExample.controller.getState().progress -
                progress,
            ) < 0.002,
          progress,
        );
      }
      await move(0);
      await move(0.5);
      const geometry = await p
        .locator(".bot-md-thread-line")
        .evaluate((el: any) => {
          const l = el.getTotalLength(),
            m = el.getScreenCTM();
          return [0.25, 0.75].map((t) => {
            const p = el.getPointAtLength(l * t).matrixTransform(m);
            return { x: p.x, y: p.y };
          });
        });
      const png = PNG.sync.read(await p.screenshot());
      function blue({ x, y }: { x: number; y: number }) {
        let found = 0;
        for (let j = Math.round(y) - 3; j <= Math.round(y) + 3; j++)
          for (let i = Math.round(x) - 3; i <= Math.round(x) + 3; i++)
            if (i >= 0 && j >= 0 && i < png.width && j < png.height) {
              const k = (j * png.width + i) * 4;
              if (
                png.data[k] < 50 &&
                png.data[k + 1] > 70 &&
                png.data[k + 1] < 190 &&
                png.data[k + 2] > 200
              )
                found++;
            }
        return found;
      }
      assert.ok(
        blue(geometry[0]) > 0,
        "first quarter of path must actually be painted",
      );
      assert.equal(
        blue(geometry[1]),
        0,
        "last quarter must remain unpainted at half progress",
      );
      await move(1);
      await move(0.25);
      await move(0);
      assert.equal(
        await p.evaluate(
          () => (window as any).botMDExample.controller.getState().variant,
        ),
        "mobile",
      );
      await p.setViewportSize({ width: 1440, height: 900 });
      await p.waitForFunction(
        () =>
          (window as any).botMDExample.controller.getState().variant ===
          "desktop",
      );
      assert.equal(
        await p.locator(".bot-md-thread-line").getAttribute("d"),
        "M 350 20 C 350 320 120 50 120 380",
      );
      await p.emulateMedia({ reducedMotion: "reduce" });
      await p.waitForFunction(
        () => (window as any).botMDExample.controller.getState().progress === 1,
      );
      await p.evaluate(() => scrollTo(0, 0));
      await p.waitForTimeout(30);
      assert.equal(
        await p.evaluate(
          () => (window as any).botMDExample.controller.getState().progress,
        ),
        1,
      );
      await p.emulateMedia({ reducedMotion: "no-preference" });
      await move(0);
      const cleanup = await p.evaluate(() => {
        const x = (window as any).botMDExample,
          host = document.querySelector<HTMLElement>("#detail")!;
        let duplicate = false;
        try {
          x.mountScrollThread(host, x.definition);
        } catch {
          duplicate = true;
        }
        let calls = 0;
        host.querySelector("h2")!.addEventListener("click", () => calls++);
        x.controller.destroy();
        x.controller.destroy();
        host.querySelector<HTMLElement>("h2")!.click();
        const other = document.createElement("section");
        other.style.height = "600px";
        document.body.append(other);
        const a = x.mountScrollThread(host, x.definition),
          b = x.mountScrollThread(other, x.definition);
        a.destroy();
        const remaining =
          document.querySelectorAll(".bot-md-thread-art").length;
        b.destroy();
        return {
          duplicate,
          calls,
          remaining,
          positionRestored: other.style.position === "",
        };
      });
      assert.deepEqual(cleanup, {
        duplicate: true,
        calls: 1,
        remaining: 1,
        positionRestored: true,
      });
      assert.deepEqual(errors, []);
      assert.ok(requests.every((u) => u.startsWith(server.url)));
      assert.deepEqual(server.missing, []);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);

test(
  "multiple targets, non-path elements and tampered source cannot create a routable detail",
  { timeout: 30000 },
  async () => {
    const { root, site } = await fixture();
    for (const [selector, name] of [
      ["path", "many"],
      ["h1", "non-svg"],
    ]) {
      const out = path.join(root, name);
      await assert.rejects(
        extractScrollDetail(site, { ...config, selector }, out),
      );
      await assert.rejects(access(path.join(out, "routes.json")));
    }
    await save(path.join(site, "index.html"), "tampered");
    const out = path.join(root, "tampered");
    await assert.rejects(extractScrollDetail(site, config, out), /integridad/);
    await assert.rejects(access(path.join(out, "routes.json")));
  },
);
