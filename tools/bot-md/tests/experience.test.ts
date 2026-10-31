import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { config, saveJson } from "../src/common.js";
import { capture } from "../src/capture.js";
import { build } from "../src/build.js";
import { launch } from "../src/browser.js";
import { serve } from "../src/server.js";
import {
  catalogContent,
  createTemplate,
  validateContent,
} from "../src/content.js";
import { exportStyles } from "../src/styles.js";
import {
  captureMotion,
  compareMotion,
  assessMotion,
  motionConfig,
  readMotion,
} from "../src/motion.js";
import type { ContentMap, MotionTrace } from "../src/experience-types.js";
import { fixture } from "./fixture-server.js";

const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>Prueba del hilo</title><link rel="stylesheet" href="/style.css"></head><body><header><button id="menu" aria-expanded="false">Menú</button><nav hidden>Proyectos</nav></header><h1>Ideas <em>que avanzan</em></h1><p id="intro">Una descripción.</p><button id="rerender">Actualizar</button><svg aria-hidden="true"><path id="thread" fill="none" stroke="#ff4a24" stroke-width="2"/><path id="empty"/></svg><footer>Final</footer><script>
const heading=document.querySelector('h1'),thread=document.querySelector('#thread');
function update(){const h=heading.getBoundingClientRect().bottom+scrollY;thread.setAttribute('d','M 10 10 C 10 '+h+' 100 '+h+' 100 '+(h+300));const l=thread.getTotalLength();thread.style.strokeDasharray=String(l);thread.style.strokeDashoffset=String(l*(1-scrollY/(document.documentElement.scrollHeight-innerHeight)));}
new ResizeObserver(update).observe(heading);addEventListener('scroll',update);addEventListener('resize',update);
document.querySelector('#menu').onclick=e=>{const open=e.currentTarget.getAttribute('aria-expanded')!=='true';e.currentTarget.setAttribute('aria-expanded',String(open));document.querySelector('nav').hidden=!open;};
document.querySelector('#rerender').onclick=()=>{heading.firstChild.nodeValue='Ideas ';};
update();document.body.dataset.ready='true';
</script></body></html>`;
const css = `:root{--accent:#ff4a24}body{margin:20px;font-family:Arial}h1{font-size:48px;width:280px;line-height:1}svg{position:absolute;inset:0;width:100%;height:2000px;pointer-events:none}footer{margin-top:1500px}@media(max-width:600px){:root{--accent:#ff4820}h1{font-size:40px}}@keyframes reveal{from{opacity:0}to{opacity:1}}`;

test(
  "CLI run emits styles, catalog and template, and refuses to certify an unmatched motion selector",
  { timeout: 90000 },
  async () => {
    const source = await fixture(),
      root = path.resolve("test-output/cli-experience-" + Date.now());
    await saveJson(path.join(root, "capture.json"), {
      url: source.url,
      allowLocalhost: true,
      autoExplore: false,
      maxPages: 1,
      maxStates: 1,
      maxScrollSteps: 2,
      settleMs: 80,
      viewports: [{ name: "mobile", width: 390, height: 844 }],
    });
    await saveJson(path.join(root, "motion.json"), {
      svgSelector: "#not-a-thread",
      steps: [{ name: "start", progress: 0 }],
      sampleMs: [0],
      initialWaitMs: 80,
      viewports: [{ name: "mobile", width: 390, height: 844, touch: true }],
    });
    await saveJson(path.join(root, "content.json"), {
      schemaVersion: 1,
      timeoutMs: 1000,
      bindings: [],
    });
    let code = 0;
    try {
      await promisify(execFile)(
        process.execPath,
        [
          "dist/src/cli.js",
          "run",
          "--config",
          path.join(root, "capture.json"),
          "--motion-config",
          path.join(root, "motion.json"),
          "--content",
          path.join(root, "content.json"),
          "--out",
          path.join(root, "run"),
        ],
        { timeout: 80000 },
      );
    } catch (error) {
      code = (error as { code: number }).code;
    } finally {
      await source.close();
    }
    assert.equal(code, 2);
    for (const file of [
      "styles/ESTILOS.md",
      "content/content.json",
      "template/content.js",
      "motion-source/MOVIMIENTO.md",
      "motion-local/MOVIMIENTO.md",
      "verification/verification.json",
    ])
      assert.ok((await readFile(path.join(root, "run", file))).length, file);
    const assessment = JSON.parse(
      await readFile(path.join(root, "run/motion-comparison.json"), "utf8"),
    );
    assert.equal(assessment.status, "fail");
    assert.ok(
      assessment.comparison.referenceIssues.some((i: string) =>
        i.startsWith("NO_SVG_MATCH"),
      ),
    );
  },
);

test("motion profiles and editable fields reject ambiguous or unsafe input", () => {
  assert.throws(() => motionConfig({ sampleMs: [100, 0] }), /Muestreo/);
  assert.throws(
    () => motionConfig({ steps: [{ name: "bad", progress: 2 }] }),
    /scroll/,
  );
  assert.throws(() => motionConfig({ viewports: [] }), /Viewport/);
  const map: ContentMap = {
    schemaVersion: 1,
    timeoutMs: 1000,
    bindings: [
      {
        id: "a",
        route: "/",
        selector: "h1",
        kind: "attribute",
        attribute: "onclick",
        expected: "",
        value: "alert(1)",
      },
    ],
  };
  assert.throws(() => validateContent(map), /Atributo/);
  map.bindings[0].attribute = "href";
  map.bindings[0].value = "javascript:alert(1)";
  assert.throws(() => validateContent(map), /Enlace/);
  map.bindings[0].value = "/safe";
  assert.equal(validateContent(map), map);
  map.bindings.push({ ...map.bindings[0], id: "b" });
  assert.throws(() => validateContent(map), /duplicado/);
});

test("SVG comparison rejects changed curves, missing frames and disabled motion", () => {
  const c = motionConfig({
    viewports: [{ name: "mobile", width: 390, height: 844, touch: true }],
    steps: [{ name: "start", progress: 0 }],
    sampleMs: [0],
  });
  const trace: MotionTrace = {
    schemaVersion: 1,
    createdAt: "test",
    source: "fixture",
    browser: "test",
    profileHash: "same",
    config: c,
    issues: [],
    limitations: [],
    frames: [
      {
        viewport: "mobile",
        step: 0,
        sampleMs: 0,
        elapsedMs: 0,
        scrollY: 0,
        scrollHeight: 2000,
        overflowX: 0,
        input: { reduced: false, touchPoints: 1, hover: false },
        truncated: false,
        paths: [
          {
            key: "#line",
            tag: "path",
            route: null,
            d: "M0 0L1 1",
            length: 1.414,
            points: [
              { x: 0, y: 0 },
              { x: 1, y: 1 },
            ],
            style: { "stroke-dashoffset": "0px" },
          },
        ],
      },
    ],
  };
  assert.equal(compareMotion(trace, structuredClone(trace)).status, "pass");
  const changed = structuredClone(trace);
  changed.frames[0].paths[0].points[1].x = 10;
  assert.equal(compareMotion(trace, changed).status, "fail");
  assert.equal(assessMotion(trace, trace, changed).status, "unstable");
  const missing = structuredClone(trace);
  missing.frames = [];
  assert.equal(compareMotion(trace, missing).complete, false);
  const reduced = structuredClone(trace);
  reduced.frames[0].input.reduced = true;
  assert.equal(compareMotion(trace, reduced).status, "fail");
});

test(
  "styles, content and active SVG motion work offline and adapt without destroying nested elements",
  { timeout: 120000 },
  async () => {
    const out = path.resolve("test-output/experience-" + Date.now());
    const origin = http.createServer((req, res) => {
      const style = req.url === "/style.css";
      res.writeHead(200, {
        "Content-Type": style ? "text/css" : "text/html; charset=utf-8",
      });
      res.end(style ? css : html);
    });
    await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
    const address = origin.address();
    assert.ok(address && typeof address !== "string");
    const url = "http://127.0.0.1:" + address.port + "/";
    const cap = path.join(out, "capture"),
      site = path.join(out, "site");
    try {
      await capture(
        config({
          url,
          allowLocalhost: true,
          autoExplore: false,
          maxPages: 1,
          viewports: [{ name: "mobile", width: 390, height: 844 }],
          settleMs: 60,
          maxScrollSteps: 2,
        }),
        cap,
        () => {},
      );
    } finally {
      await new Promise<void>((r) => origin.close(() => r()));
    }
    await build(cap, site);
    const styles = await exportStyles(cap, path.join(out, "styles"));
    assert.ok(styles.properties["font-size"].some((v) => v.value === "40px"));
    assert.ok(styles.css.some((s) => s.media.includes("(max-width:600px)")));
    assert.ok(
      styles.css
        .flatMap((s) => s.variables)
        .some((v) => v.context.includes("@media (max-width:600px)")),
    );
    const catalog = await catalogContent(cap, path.join(out, "catalog"));
    const heading = catalog.bindings.find(
      (b) => b.kind === "text" && b.expected === "Ideas ",
    );
    assert.ok(heading);
    const originalTemplate = await createTemplate(
      site,
      { schemaVersion: 1, timeoutMs: 1000, bindings: [heading] },
      path.join(out, "unchanged"),
    );
    assert.ok(originalTemplate.routes["/__botmd/content.js"]);
    const c = motionConfig({
      viewports: [{ name: "mobile", width: 390, height: 844, touch: true }],
      steps: [
        { name: "start", progress: 0 },
        { name: "end", progress: 1 },
      ],
      sampleMs: [0, 80],
      initialWaitMs: 100,
      svgSelector: "#thread,#empty",
    });
    const trace = await captureMotion(
      { site },
      c,
      path.join(out, "motion"),
      () => {},
    );
    assert.equal(trace.issues.length, 0, JSON.stringify(trace.issues));
    assert.equal(trace.frames.length, 4);
    assert.equal(trace.frames[0].paths[1].length, 0);
    assert.deepEqual(trace.frames[0].paths[1].points, []);
    assert.ok(
      trace.frames.every((f) => !f.input.reduced && f.input.touchPoints > 0),
    );
    assert.notEqual(
      trace.frames[0].paths[0].style["stroke-dashoffset"],
      trace.frames[3].paths[0].style["stroke-dashoffset"],
    );
    const same = await captureMotion(
      { site: path.join(out, "unchanged") },
      c,
      path.join(out, "motion-unchanged"),
      () => {},
    );
    assert.equal(
      compareMotion(trace, same).status,
      "pass",
      JSON.stringify(compareMotion(trace, same)),
    );
    const map: ContentMap = {
      schemaVersion: 1,
      timeoutMs: 1000,
      readySelector: "body[data-ready=true]",
      bindings: [
        {
          ...heading,
          value: "Construimos ideas que crecen y cambian cada día ",
        },
      ],
    };
    const edited = path.join(out, "edited");
    await createTemplate(site, map, edited);
    const server = await serve(edited),
      browser = await launch();
    try {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        reducedMotion: "no-preference",
      });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(server.url);
      await page.waitForFunction(
        () =>
          !!(window as unknown as { __BOT_MD_CONTENT__?: { ready: boolean } })
            .__BOT_MD_CONTENT__?.ready,
      );
      assert.equal(await page.locator("h1 em").count(), 1);
      assert.equal(await page.locator("h1 em").textContent(), "que avanzan");
      assert.ok(
        (await page.locator("h1").textContent())?.startsWith("Construimos"),
      );
      await page.locator("#menu").click();
      assert.equal(
        await page.locator("#menu").getAttribute("aria-expanded"),
        "true",
      );
      await page.locator("#rerender").click();
      await page.waitForTimeout(80);
      assert.ok(
        (await page.locator("h1").textContent())?.startsWith("Construimos"),
        "Content is reapplied after source rerender.",
      );
      // A changed source must surface as a conflict, never silently overwrite unknown text.
      await page.locator("h1").evaluate((el) => {
        el.firstChild!.nodeValue = "Unexpected source";
      });
      await page.waitForTimeout(80);
      assert.equal(
        await page.locator("h1").evaluate((el) => el.firstChild!.nodeValue),
        "Unexpected source",
      );
      const status = await page.evaluate(
        () =>
          (window as unknown as { __BOT_MD_CONTENT__: { conflicts: string[] } })
            .__BOT_MD_CONTENT__,
      );
      assert.equal(status.conflicts.length, 1);
      assert.deepEqual(errors, []);
      // Runtime revalidates edited JSON too, so a post-build event-handler injection cannot execute.
      await saveJson(path.join(edited, "content.json"), {
        ...map,
        bindings: [
          {
            ...heading,
            kind: "attribute",
            attribute: "onclick",
            value: "bad()",
          },
        ],
      });
      await page.reload();
      await page.waitForFunction(
        () =>
          !!(window as unknown as { __BOT_MD_CONTENT__: { error?: string } })
            .__BOT_MD_CONTENT__?.error,
      );
      await saveJson(path.join(edited, "content.json"), map);
    } finally {
      await browser.close();
      await server.close();
    }
    const adapted = await captureMotion(
      { site: edited },
      c,
      path.join(out, "motion-edited"),
      () => {},
    );
    assert.equal(adapted.issues.length, 0);
    assert.notEqual(
      adapted.frames[0].paths[0].length,
      trace.frames[0].paths[0].length,
      "SVG responds to changed text geometry.",
    );
    assert.equal(
      compareMotion(trace, adapted).status,
      "fail",
      "Changed content cannot be certified as identical geometry.",
    );
    const traceFile = path.join(out, "motion/motion.json");
    await writeFile(traceFile, (await readFile(traceFile, "utf8")) + " ");
    await assert.rejects(() => readMotion(path.join(out, "motion")), /cambió/);
    await saveJson(path.join(out, "receipt.json"), {
      offline: true,
      styles: true,
      content: true,
      nestedElementsPreserved: true,
      sourceConflictsDetected: true,
      runtimeValidation: true,
      menu: true,
      reapplyAfterRerender: true,
      activeMotionFrames: trace.frames.length,
      unchangedComparison: compareMotion(trace, same).status,
      adaptationChangesCurve: true,
      tamperDetected: true,
    });
    console.log("Experience receipt: " + path.join(out, "receipt.json"));
  },
);
