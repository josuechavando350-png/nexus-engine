import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { mkdir, writeFile, symlink } from "node:fs/promises";
import { capture } from "../src/capture.js";
import { config, saveJson } from "../src/common.js";
import { build } from "../src/build.js";
import {
  catalogContent,
  createTemplate,
  validateContent,
} from "../src/content.js";
import {
  auditContent,
  literalMatches,
  validateAuditPolicy,
} from "../src/content-audit.js";
import { captureMotion, compareMotion, motionConfig } from "../src/motion.js";
import { serve } from "../src/server.js";
import { launch } from "../src/browser.js";
import { addMediaAssets, assertSafeSvg } from "../src/assets.js";
import type { ContentMap } from "../src/experience-types.js";

test("identity audit recognizes encoded text and split DOM text; content/clock policies reject unsafe or ambiguous inputs", () => {
  assert.deepEqual(
    literalMatches("<p>Mar<span>ca</span> Ori&#103;inal</p>", "text/html", [
      "Marca Original",
    ]),
    ["Marca Original"],
  );
  assert.deepEqual(
    literalMatches(
      'const name="Mar\\u0063a Original"',
      "application/javascript",
      ["Marca Original"],
    ),
    ["Marca Original"],
  );
  assert.throws(() => validateAuditPolicy({ forbiddenTerms: [] }), /términos/);
  assert.throws(
    () =>
      validateAuditPolicy({
        forbiddenTerms: ["Marca"],
        reviewedResources: [{ sha256: "0".repeat(64), reason: "OK" }],
      }),
    /revisión/,
  );
  assert.throws(
    () => motionConfig({ clockMode: "controlled" }),
    /readySelector/,
  );
  assert.throws(
    () =>
      assertSafeSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><use href="java&#115;cript:alert(1)"/></svg>',
      ),
    /SVG/,
  );
  const map: ContentMap = {
    schemaVersion: 1,
    timeoutMs: 1000,
    bindings: [
      {
        id: "a",
        route: "/",
        selector: "img",
        kind: "attribute",
        attribute: "srcset",
        expected: "/old.png 1x",
        value: "https://outside.test/new.png 1x",
      },
    ],
  };
  assert.throws(() => validateContent(map), /srcset/);
});

test(
  "controlled SVG timing repeats against a live origin and offline copy; metadata/media edits expose retained source content",
  { timeout: 150000 },
  async () => {
    const out = path.resolve("test-output/refinement-" + Date.now()),
      cap = path.join(out, "capture"),
      site = path.join(out, "site");
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Marca Original description"><title>Marca Original</title><link rel="icon" href="data:,"><style>body{margin:20px;font-family:Arial}h1{width:280px;font-size:40px}svg#animation{position:fixed;top:300px;left:0;width:390px;height:200px}footer{margin-top:1500px}img{width:80px;height:60px}</style></head><body><h1>Marca Original <em>avanza</em></h1><a href="mailto:original@example.test">Contacto</a><img src="/original.svg" srcset="/original.svg 1x, /original.svg 2x" alt="Marca Original logo"><svg id="animation"><path id="thread" d="M10 10 C30 180 200 100 300 180" fill="none" stroke="#f42"/><circle id="head" r="4"/></svg><footer>Fin</footer><script>
const path=document.querySelector('#thread'),head=document.querySelector('#head'),length=path.getTotalLength();path.style.strokeDasharray=String(length);
function draw(t){const p=scrollY/(document.documentElement.scrollHeight-innerHeight);path.style.strokeDashoffset=String(length*(1-p));const at=path.getPointAtLength(length*(.5+.4*Math.sin(t/1000)));head.setAttribute('cx',String(at.x));head.setAttribute('cy',String(at.y));if(!matchMedia('(prefers-reduced-motion:reduce)').matches)requestAnimationFrame(draw);}
draw(0);setTimeout(()=>document.body.dataset.ready='true',50);
</script></body></html>`;
    const origin = http.createServer((req, res) => {
      const svg = req.url === "/original.svg";
      res.writeHead(200, {
        "Content-Type": svg ? "image/svg+xml" : "text/html; charset=utf-8",
      });
      res.end(
        svg
          ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 60"><text y="30">Marca Original</text></svg>'
          : req.url === "/other"
            ? '<html><head><link rel="icon" href="data:,"></head><body><p>Texto destino.</p></body></html>'
            : html.replace(
                "<footer>",
                '<a id="other" href="/other">Otra página</a><footer>',
              ),
      );
    });
    await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
    const addr = origin.address();
    assert.ok(addr && typeof addr !== "string");
    const url = "http://127.0.0.1:" + addr.port + "/";
    const motion = motionConfig({
      route: "/",
      clockMode: "controlled",
      readySelector: "body[data-ready=true]",
      initialWaitMs: 160,
      renderWaitMs: 20,
      viewports: [{ name: "mobile", width: 390, height: 844, touch: true }],
      steps: [
        { name: "start", progress: 0 },
        { name: "middle", progress: 0.5 },
        { name: "end", progress: 1 },
      ],
      sampleMs: [0, 160, 640],
      svgSelector: "#thread,#head",
      allowLocalhost: true,
    });
    let reference, repeat;
    try {
      await capture(
        config({
          url,
          allowLocalhost: true,
          autoExplore: false,
          maxPages: 1,
          maxStates: 2,
          maxScrollSteps: 2,
          settleMs: 100,
          viewports: [{ name: "mobile", width: 390, height: 844 }],
          scenarios: [
            {
              name: "navigate",
              steps: [{ action: "click", selector: "#other" }],
            },
          ],
        }),
        cap,
        () => {},
      );
      reference = await captureMotion(
        { url },
        motion,
        path.join(out, "source"),
        () => {},
      );
      repeat = await captureMotion(
        { url },
        motion,
        path.join(out, "repeat"),
        () => {},
      );
    } finally {
      await new Promise<void>((r) => origin.close(() => r()));
    }
    await build(cap, site);
    const candidate = await captureMotion(
      { site },
      motion,
      path.join(out, "local"),
      () => {},
    );
    assert.equal(compareMotion(reference, repeat).status, "pass");
    assert.equal(compareMotion(reference, candidate).status, "pass");
    assert.ok(candidate.frames.every((f) => f.elapsedMs === f.sampleMs));
    assert.notEqual(
      candidate.frames[0].paths[1].points[0].x,
      candidate.frames[1].paths[1].points[0].x,
      "Animation remains active under the controlled clock.",
    );
    const wrong = structuredClone(candidate);
    wrong.frames[1].elapsedMs += 100;
    assert.equal(compareMotion(reference, wrong).status, "fail");
    const catalog = await catalogContent(cap, path.join(out, "catalog"));
    assert.equal(
      catalog.bindings.find((b) => b.expected === "Texto destino.")?.route,
      "/other",
      "Navigated content belongs to its observed route, not the scenario entry route.",
    );
    assert.ok(catalog.bindings.some((b) => b.attribute === "content"));
    assert.ok(catalog.bindings.some((b) => b.attribute === "srcset"));
    assert.ok(catalog.bindings.some((b) => b.attribute === "href"));
    const bindings = catalog.bindings
      .filter(
        (b) =>
          b.expected.includes("Marca Original") ||
          ["href", "src", "srcset"].includes(b.attribute ?? ""),
      )
      .map((b) => ({
        ...b,
        value:
          b.attribute === "href"
            ? "#contact"
            : b.attribute === "src"
              ? "/__botmd/media/logo.svg"
              : b.attribute === "srcset"
                ? "/__botmd/media/logo.svg 1x, /__botmd/media/logo.svg 2x"
                : b.expected.replaceAll("Marca Original", "Nueva Marca"),
      }));
    const map: ContentMap = {
      schemaVersion: 1,
      timeoutMs: 1000,
      readySelector: "body[data-ready=true]",
      bindings,
    };
    const media = path.join(out, "media");
    await mkdir(media, { recursive: true });
    await writeFile(
      path.join(media, "logo.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 60"><rect width="80" height="60" fill="#f42"/></svg>',
    );
    const edited = path.join(out, "edited");
    await createTemplate(site, map, edited, media);
    const server = await serve(edited),
      browser = await launch();
    try {
      const page = await browser.newPage();
      await page.goto(server.url);
      await page.waitForFunction(
        () =>
          !!(window as unknown as { __BOT_MD_CONTENT__?: { ready: boolean } })
            .__BOT_MD_CONTENT__?.ready,
      );
      assert.equal(await page.title(), "Nueva Marca");
      assert.equal(
        await page.locator("meta[name=description]").getAttribute("content"),
        "Nueva Marca description",
      );
      assert.ok(
        (
          await page
            .locator("img")
            .evaluate((el) => (el as HTMLImageElement).currentSrc)
        ).endsWith("/__botmd/media/logo.svg"),
      );
      assert.equal(
        await page
          .getByRole("link", { name: "Contacto", exact: true })
          .getAttribute("href"),
        "#contact",
      );
      assert.equal(await page.locator("h1 em").textContent(), "avanza");
      const state = await page.evaluate(
        () =>
          (
            window as unknown as {
              __BOT_MD_CONTENT__: { missing: string[]; conflicts: string[] };
            }
          ).__BOT_MD_CONTENT__,
      );
      assert.deepEqual(state.missing, []);
      assert.deepEqual(state.conflicts, []);
    } finally {
      await browser.close();
      await server.close();
    }
    const audit = await auditContent(
      cap,
      edited,
      map,
      { forbiddenTerms: ["Marca Original", "original@example.test"] },
      path.join(out, "audit"),
    );
    assert.equal(audit.status, "blocked");
    assert.ok(audit.summary.filesWithForbiddenTerms > 0);
    assert.ok(
      audit.files.some(
        (f) => f.route === "/__botmd/content.json" && f.matches.length,
      ),
      "Expected originals remain in the served binding map and must be reported.",
    );
    assert.ok(audit.files.some((f) => f.originalMedia));
    assert.equal(audit.summary.replacementsDeclared, bindings.length);
    await symlink(path.join(media, "logo.svg"), path.join(media, "linked.svg"));
    await assert.rejects(
      () =>
        addMediaAssets(media, path.join(out, "bad-assets"), {
          schemaVersion: 1,
          sourceDigest: "test",
          origin: url,
          routes: {},
          missing: [],
          patches: [],
        }),
      /simbólicos/,
    );
    await saveJson(path.join(out, "receipt.json"), {
      controlledSourceRepeat: compareMotion(reference, repeat),
      controlledOffline: compareMotion(reference, candidate),
      content: {
        metadata: true,
        srcset: true,
        newMediaLoaded: true,
        links: true,
        nestedElementsPreserved: true,
        retainedOriginalDetected: true,
        audit: audit.summary,
      },
    });
    console.log("Refinement receipt: " + path.join(out, "receipt.json"));
  },
);
