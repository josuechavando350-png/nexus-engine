import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, access } from "node:fs/promises";
import os from "node:os";
import { rewriteFlight } from "../src/flight.js";
import {
  materialize,
  materializeHTML,
  materializeJS,
  validateReplacements,
  type ReplacementPlan,
} from "../src/materialize.js";
import { hash, save, saveJson, json } from "../src/common.js";
import { serve } from "../src/server.js";
import { launch } from "../src/browser.js";
import type { Build } from "../src/types.js";

const old = "Nombre original",
  next = "Diseño 🧵 y acción";
const replace = (s: string) => (s === old ? next : s);
test("Flight preserves references and modules, recalculates UTF-8 framing, and rejects incomplete or unknown records", () => {
  const text = old + "\nfin";
  const original =
    '1:I[42,["/app.js"],"' +
    old +
    '"]\n2:"$L1"\n3:T' +
    Buffer.byteLength(text).toString(16) +
    "," +
    text +
    '4:["$","h1",null,{"children":"' +
    old +
    '"}]\n5:X\n5:C\n';
  const transformed = rewriteFlight(original, (s) =>
    s === text ? next + "\nfin" : replace(s),
  );
  assert.ok(
    transformed.includes(
      "3:T" +
        Buffer.byteLength(next + "\nfin").toString(16) +
        "," +
        next +
        "\nfin",
    ),
  );
  assert.ok(transformed.includes('1:I[42,["/app.js"],"' + old + '"]\n2:"$L1"'));
  assert.ok(transformed.includes(JSON.stringify(next)));
  assert.equal(
    rewriteFlight(transformed, (s) => s),
    transformed,
  );
  assert.equal(
    rewriteFlight("0:" + JSON.stringify(old) + "\n", () => "$precio"),
    '0:"$$precio"\n',
  );
  assert.throws(() => rewriteFlight("0:Tff,hola", replace), /truncado/);
  assert.throws(() => rewriteFlight("0:O2,ab", replace), /binario/);
  assert.throws(() => rewriteFlight("0:Zwhatever\n", replace), /etiqueta/);
  assert.throws(() => rewriteFlight('0:{"a":1}', replace), /terminador/);
});

test("materialization parses split Flight streams and treats hostile replacement text as data", () => {
  const flight = "0:" + JSON.stringify({ children: old }) + "\n";
  const cut = 9;
  const text = "</script><script>globalThis.pwned=true</script> 🧵";
  const replaceHostile = (s: string) => (s === old ? text : s);
  const html =
    "<html><head></head><body><p>" +
    old +
    "</p><script>self.__next_f=[];self.__next_f.push([1," +
    JSON.stringify(flight.slice(0, cut)) +
    "]);</script><script>self.__next_f.push([1," +
    JSON.stringify(flight.slice(cut)) +
    "]);const data=" +
    JSON.stringify(old) +
    ';</script><noscript><a href="mailto:old@example.test">' +
    old +
    "</a></noscript></body></html>";
  const actual = materializeHTML(html, replaceHostile);
  assert.equal((actual.match(/<script>/g) ?? []).length, 2);
  assert.ok(actual.includes("\\u003c/script>"));
  assert.ok(actual.includes("&lt;script&gt;"));
  assert.equal(
    materializeJS(
      'const a={"' + old + '": "' + old + '"};a["' + old + '"];',
      replace,
    ),
    'const a={"' + old + '": ' + JSON.stringify(next) + '};a["' + old + '"];',
  );
  assert.throws(
    () =>
      materializeHTML('<a href="/old">Go</a>', (s) =>
        s === "/old" ? "javascript:alert(1)" : s,
      ),
    /URL no permitida/,
  );
  assert.throws(
    () =>
      validateReplacements({
        schemaVersion: 1,
        replacements: [
          { id: "a", from: old, to: next },
          { id: "b", from: old, to: "otra" },
        ],
      }),
    /ambigua/,
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "bot-md-materialize-"));
  const site = path.join(root, "base");
  const index: Build = {
    schemaVersion: 1,
    sourceDigest: "f".repeat(64),
    origin: "https://old.example.test",
    routes: {},
    missing: [],
    patches: [],
  };
  async function add(route: string, mime: string, body: string | Buffer) {
    const file = "files/" + hash(route).slice(0, 16);
    await save(path.join(site, file), body);
    index.routes[route] = {
      file,
      mime,
      status: 200,
      sourceUrl: index.origin + route,
      sha256: hash(body),
    };
  }
  const stream = "0:" + JSON.stringify({ children: old }) + "\n";
  await add(
    "/",
    "text/html",
    '<!doctype html><html><head><meta charset="utf-8"><title>' +
      old +
      '</title><meta name="description" content="' +
      old +
      '"><link rel="icon" href="data:,"><link rel="stylesheet" href="/style.css"></head><body><h1>' +
      old +
      '</h1><button>Recargar datos</button><p id="response"></p><noscript><p>' +
      old +
      "</p></noscript><script>self.__next_f=[];self.__next_f.push([1," +
      JSON.stringify(stream) +
      ']);</script><script src="/app.js"></script></body></html>',
  );
  await add(
    "/app.js",
    "application/javascript",
    "const title=" +
      JSON.stringify(old) +
      ';document.querySelector("h1").textContent=title;document.querySelector("button").onclick=async()=>{const a=await(await fetch("/data.json")).json();const b=await(await fetch("/data.rsc")).text();const c=JSON.parse(b.slice(b.indexOf(":")+1));document.querySelector("#response").textContent=a.name+" | "+c.children};window.ready=true;',
  );
  await add("/data.json", "application/json", JSON.stringify({ name: old }));
  await add("/data.rsc", "text/x-component", stream);
  await add(
    "/style.css",
    "text/css",
    "body{background:#101010;color:#faf6eb}h1{font-size:48px}",
  );
  await add("/font.woff2", "font/woff2", Buffer.from([0, 1, 2, 3, 255]));
  await saveJson(path.join(site, "routes.json"), index);
  await save(
    path.join(site, "private-map.json"),
    JSON.stringify({ expected: old }),
  );
  return { root, site, index };
}

test(
  "compiled copy has replacement text before JavaScript, after hydration, data fetches and reload, with original CSS/font bytes intact",
  { timeout: 30000 },
  async () => {
    const { root, site, index } = await fixture();
    const out = path.join(root, "compiled");
    const report = await materialize(
      site,
      {
        schemaVersion: 1,
        replacements: [{ id: "brand", from: old, to: next }],
        forbiddenTerms: [old],
      },
      out,
    );
    assert.equal(report.status, "materialized");
    assert.ok(
      report.counts.brand.html > 0 &&
        report.counts.brand.javascript > 0 &&
        report.counts.brand.flight > 0 &&
        report.counts.brand.json > 0,
    );
    const built = await json<Build>(path.join(out, "routes.json"));
    for (const route of ["/style.css", "/font.woff2"])
      assert.deepEqual(
        await readFile(path.join(out, built.routes[route].file)),
        await readFile(path.join(site, index.routes[route].file)),
      );
    assert.ok(
      (
        await readFile(path.join(site, index.routes["/"].file), "utf8")
      ).includes(old),
    );
    await assert.rejects(access(path.join(out, "private-map.json")));
    const server = await serve(out);
    const browser = await launch();
    try {
      const raw = await (await fetch(server.url)).text();
      assert.ok(raw.includes(next));
      assert.ok(!raw.includes(old));
      assert.ok(!raw.includes("/__botmd/content.js"));
      assert.equal((await fetch(server.url + "/private-map.json")).status, 404);
      const noJS = await browser.newContext({ javaScriptEnabled: false });
      const p0 = await noJS.newPage();
      await p0.goto(server.url);
      assert.equal(await p0.locator("h1").textContent(), next);
      assert.equal(await p0.title(), next);
      await noJS.close();
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(server.url);
      await page.waitForFunction(() => Boolean((window as any).ready));
      assert.equal(await page.locator("h1").textContent(), next);
      await page.locator("button").click();
      await page.waitForFunction(() =>
        Boolean(document.querySelector("#response")?.textContent),
      );
      assert.equal(
        await page.locator("#response").textContent(),
        next + " | " + next,
      );
      await page.reload();
      await page.waitForFunction(() => Boolean((window as any).ready));
      assert.equal(await page.locator("h1").textContent(), next);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);

test("unmatched rules and terms in supplied media block status; parse or integrity failures never create routes.json", async () => {
  const { root, site, index } = await fixture();
  const media = path.join(root, "media");
  await save(
    path.join(media, "brand.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"><text>' + old + "</text></svg>",
  );
  const plan: ReplacementPlan = {
    schemaVersion: 1,
    replacements: [{ id: "missing", from: "Does not exist", to: "Replaced" }],
    forbiddenTerms: [old],
  };
  const r = await materialize(site, plan, path.join(root, "blocked"), media);
  assert.equal(r.status, "blocked");
  assert.deepEqual(r.unmatchedRules, ["missing"]);
  assert.ok(
    r.files.some(
      (f) => f.route.startsWith("/__botmd/media/") && f.matches.includes(old),
    ),
  );
  const file = path.join(site, index.routes["/data.rsc"].file);
  await save(file, "0:T99,incomplete");
  index.routes["/data.rsc"].sha256 = hash("0:T99,incomplete");
  await saveJson(path.join(site, "routes.json"), index);
  await assert.rejects(
    materialize(
      site,
      { schemaVersion: 1, replacements: [] },
      path.join(root, "invalid"),
    ),
    /truncado/,
  );
  await assert.rejects(access(path.join(root, "invalid/routes.json")));
  await save(file, "tampered");
  await assert.rejects(
    materialize(
      site,
      { schemaVersion: 1, replacements: [] },
      path.join(root, "tampered"),
    ),
    /modificado/,
  );
  await assert.rejects(access(path.join(root, "tampered/routes.json")));
});
