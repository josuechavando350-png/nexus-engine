import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { cssDependencies, enrich } from "../src/dependencies.js";
import { config, hash, save, saveJson } from "../src/common.js";
import { integrity } from "../src/build.js";
import type { Manifest } from "../src/types.js";

test("CSS closure fetches unused nested dependencies without changing sealed observations", async () => {
  const requested: string[] = [];
  const server = http.createServer((req, res) => {
    requested.push(req.url!);
    if (req.url === "/component?_rsc=1") {
      assert.equal(req.headers.rsc, "1");
      assert.equal(req.headers["next-router-segment-prefetch"], "/work");
      res.setHeader("content-type", "text/x-component");
      res.end('0:{"text":"India · ≥95% → México"}');
    } else if (req.url === "/nested.css") {
      res.setHeader("content-type", "text/css");
      res.end('@import "root.css"; .unused {background:url(fallback.svg)}');
    } else if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/forbidden" });
      res.end();
    } else {
      res.setHeader("content-type", "image/svg+xml");
      res.end('<svg xmlns="http://www.w3.org/2000/svg"/>');
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const address = server.address() as { port: number };
    const origin = "http://127.0.0.1:" + address.port;
    const root = await mkdtemp(path.join(tmpdir(), "replica-css-"));
    const cap = path.join(root, "original"),
      out = path.join(root, "enriched");
    const css = '@import "nested.css"; .not-rendered{background:url(redirect)}';
    const digest = hash(css),
      url = origin + "/root.css";
    const componentURL = origin + "/component?_rsc=1";
    const decoded = Buffer.from('0:{"text":"India · ≥95% → México"}').toString(
      "latin1",
    );
    const decodedHash = hash(decoded);
    await save(path.join(cap, "resources", decodedHash), decoded);
    await save(path.join(cap, "resources", digest), css);
    await save(path.join(cap, "observation.txt"), "original measurement");
    const manifest: Manifest = {
      schemaVersion: 1,
      version: "test",
      createdAt: new Date().toISOString(),
      browserVersion: "test",
      config: config({ url: origin, allowLocalhost: true }),
      origin,
      pages: [],
      states: [],
      issues: [],
      resources: {
        [componentURL]: {
          url: componentURL,
          status: 200,
          mime: "text/x-component",
          kind: "fetch",
          sha256: decodedHash,
          bytes: Buffer.byteLength(decoded),
          file: "resources/" + decodedHash,
          localPath: "/component?_rsc=1",
          variants: [],
          requestHeaders: { rsc: "1", "next-router-segment-prefetch": "/work" },
        },
        [url]: {
          url,
          status: 200,
          mime: "text/css",
          kind: "stylesheet",
          sha256: digest,
          bytes: css.length,
          file: "resources/" + digest,
          localPath: "/root.css",
          variants: [],
        },
      },
      files: {
        ["resources/" + decodedHash]: decodedHash,
        ["resources/" + digest]: digest,
        "observation.txt": hash("original measurement"),
      },
    };
    await saveJson(path.join(cap, "manifest.json"), manifest);
    const original = await readFile(path.join(cap, "manifest.json"));
    await saveJson(path.join(cap, "seal.json"), {
      manifestHash: hash(original),
    });
    const result = await enrich(cap, out);
    assert.deepEqual(result.addedURLs.sort(), [
      origin + "/fallback.svg",
      origin + "/nested.css",
    ]);
    assert.equal(result.manifest.enrichment?.parentDigest, hash(original));
    const component = result.manifest.resources[componentURL];
    assert.equal(
      await readFile(path.join(out, component.file), "utf8"),
      '0:{"text":"India · ≥95% → México"}',
    );
    assert.equal(
      result.manifest.rawResponseRefresh?.[0].previousHash,
      decodedHash,
    );
    assert.notEqual(component.sha256, decodedHash);
    assert.equal(
      result.manifest.files["resources/" + decodedHash],
      decodedHash,
    );
    assert.equal(requested.includes("/forbidden"), false);
    assert.equal(requested.filter((u) => u === "/nested.css").length, 1);
    assert.ok(
      result.manifest.issues.some(
        (i) =>
          i.code === "CSS_DEPENDENCY_FAILED" && i.detail.includes("HTTP 302"),
      ),
    );
    assert.deepEqual(await readFile(path.join(cap, "manifest.json")), original);
    assert.equal(
      await readFile(path.join(out, "observation.txt"), "utf8"),
      "original measurement",
    );
    await integrity(cap);
    await integrity(out);
    await assert.rejects(() => enrich(cap, out), /ya existe/);
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  }
});

test("CSS dependency extraction ignores embedded data and local fragment references", () => {
  assert.deepEqual(
    cssDependencies(
      '@import "base.css"; a{src:url(../font.woff2);filter:url(#mask);background:url("data:image/svg+xml,x")}',
      "https://example.com/css/main.css",
    ),
    ["https://example.com/font.woff2", "https://example.com/css/base.css"],
  );
});
