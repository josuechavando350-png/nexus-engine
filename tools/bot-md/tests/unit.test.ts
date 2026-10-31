import test from "node:test";
import assert from "node:assert/strict";
import { config, inside, localPath } from "../src/common.js";
import { privateAddress, allowedURL } from "../src/network.js";
import {
  rewriteCSS,
  rewriteJS,
  rewriteHTML,
  createMapper,
} from "../src/rewrite.js";
import { comparePNGs } from "../src/verify.js";
import { PNG } from "pngjs";

test("configuration rejects invalid bounds and unrelated scenario origins", () => {
  assert.throws(() => config({ url: "file:///etc/passwd" }));
  assert.throws(() => config({ url: "https://example.test", maxPages: 0 }));
  assert.throws(() =>
    config({ url: "https://example.test", maxDiffRatio: 1.1 }),
  );
  assert.throws(() =>
    config({
      url: "https://example.test",
      scenarios: [{ name: "bad", path: "https://other.test", steps: [] }],
    }),
  );
  assert.throws(() =>
    config({
      url: "https://example.test",
      scenarios: [{ name: "bad", steps: [{ action: "wait", ms: -1 }] }],
    }),
  );
});
test("private and metadata networks are rejected; localhost is explicit", async () => {
  for (const ip of [
    "127.0.0.1",
    "169.254.169.254",
    "10.1.2.3",
    "172.16.4.2",
    "192.168.1.1",
    "::1",
    "fc00::1",
    "::ffff:7f00:1",
  ])
    assert.equal(privateAddress(ip), true, ip);
  assert.equal(privateAddress("8.8.8.8"), false);
  assert.equal(await allowedURL("http://127.0.0.1/", false), false);
  assert.equal(await allowedURL("http://127.0.0.1/", true), true);
  assert.throws(() => inside("/tmp/project", "../../etc/passwd"));
});
test("CSS imports, relative URLs and data URLs survive remapping", () => {
  const missing = new Set<string>();
  const map = createMapper(
    "https://a.test",
    new Set(["https://cdn.test/css/base.css", "https://cdn.test/a.svg"]),
    missing,
  );
  const css = rewriteCSS(
    '@import "base.css";a{background:url(../a.svg)}b{background:url("data:image/svg+xml,a")}',
    "https://cdn.test/css/main.css",
    map,
  );
  assert.ok(
    css.includes(localPath("https://cdn.test/css/base.css", "https://a.test")),
  );
  assert.ok(
    css.includes(localPath("https://cdn.test/a.svg", "https://a.test")),
  );
  assert.ok(css.includes("data:image/svg+xml,a"));
  assert.equal(missing.size, 0);
});
test("JS rewrites observed URL literals without modifying comments or regex", () => {
  const known = new Set(["https://a.test/api"]);
  const map = createMapper("https://a.test", known, new Set());
  const source =
    '// https://a.test/api\nfetch("https://a.test/api");const r=/https?:/;';
  const out = rewriteJS(source, "https://a.test/app.js", map, known);
  assert.ok(out.includes("// https://a.test/api"));
  assert.ok(out.includes('fetch("/api")'));
  assert.ok(out.includes("/https?:/"));
});
test("HTML removes stale integrity and rewrites style resources", () => {
  const known = new Set(["https://a.test/app.js", "https://a.test/photo.svg"]);
  const map = createMapper("https://a.test", known, new Set());
  const out = rewriteHTML(
    '<html><head><link rel="preload" as="font" href="/font.woff2" crossorigin="anonymous"><script src="https://a.test/app.js" integrity="old"></script></head><body style="background:url(photo.svg)"></body></html>',
    "https://a.test/",
    map,
    known,
    '<meta name="replica" content="yes">',
  );
  assert.ok(!out.includes("integrity="));
  assert.ok(out.includes('crossorigin="anonymous"'));
  assert.ok(out.includes('src="/app.js"'));
  assert.ok(out.includes("/photo.svg"));
  assert.ok(out.includes('name="replica"'));
});
test("visual comparator detects dimension mismatch and paint defects", () => {
  const a = new PNG({ width: 20, height: 20 });
  a.data.fill(255);
  const b = new PNG({ width: 20, height: 20 });
  b.data.fill(0);
  const same = comparePNGs(PNG.sync.write(a), PNG.sync.write(a), 0.1);
  assert.equal(same.ratio, 0);
  const different = comparePNGs(PNG.sync.write(a), PNG.sync.write(b), 0.1);
  assert.ok(different.ratio > 0.9);
  const small = new PNG({ width: 10, height: 10 });
  small.data.fill(255);
  assert.equal(
    comparePNGs(PNG.sync.write(a), PNG.sync.write(small), 0.1).dimensionsMatch,
    false,
  );
});
