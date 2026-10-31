import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { config, inside } from "../src/common.js";
import { collectObservedResources } from "../src/observed-resources.js";
import { motionConfig } from "../src/motion.js";
import type { Manifest } from "../src/types.js";
import type { MotionTrace } from "../src/experience-types.js";

test("motion enrichment preserves exact routing queries, UTF-8 bytes and provenance; rejects mismatched origin/type", async () => {
  const requests: {
    url: string;
    header: string | undefined;
    cookie: string | undefined;
  }[] = [];
  const origin = http.createServer((req, res) => {
    requests.push({
      url: req.url!,
      header: req.headers.rsc as string | undefined,
      cookie: req.headers.cookie,
    });
    res.writeHead(200, {
      "Content-Type": req.url?.includes("wrong")
        ? "text/html"
        : "text/x-component",
      "X-Nextjs-Prerender": "1",
    });
    res.end('0:{"name":"Diseño → ideas"}');
  });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  const address = origin.address();
  assert.ok(address && typeof address !== "string");
  const url = "http://127.0.0.1:" + address.port;
  const out = path.resolve("test-output/observed-" + Date.now());
  const manifest: Manifest = {
    schemaVersion: 1,
    version: "test",
    createdAt: "test",
    browserVersion: "test",
    config: config({ url, allowLocalhost: true }),
    origin: url,
    pages: [],
    resources: {},
    states: [],
    issues: [],
    files: {},
  };
  const observed = {
    url: url + "/work?_rsc=exact-variant",
    status: 200,
    mime: "text/x-component",
    requestHeaders: { rsc: "1", cookie: "never-persist-this" },
  };
  const trace: MotionTrace = {
    schemaVersion: 1,
    createdAt: "test",
    source: url,
    browser: "test",
    profileHash: "test",
    config: motionConfig({}),
    frames: [],
    issues: [],
    limitations: [],
    observedRequests: [observed],
  };
  try {
    assert.deepEqual(await collectObservedResources(manifest, trace, out), [
      observed.url,
    ]);
    const resource = manifest.resources[observed.url];
    assert.equal(
      await readFile(inside(out, resource.file), "utf8"),
      '0:{"name":"Diseño → ideas"}',
    );
    assert.equal(resource.localPath, "/work?_rsc=exact-variant");
    assert.equal(resource.responseHeaders?.["x-nextjs-prerender"], "1");
    assert.equal(manifest.files[resource.file], resource.sha256);
    assert.equal(requests[0].header, "1");
    assert.equal(requests[0].cookie, undefined);
    assert.deepEqual(await collectObservedResources(manifest, trace, out), []);
    await assert.rejects(
      () =>
        collectObservedResources(
          manifest,
          { ...trace, source: "https://other.example/" },
          out,
        ),
      /otro origen/,
    );
    trace.observedRequests = [
      { ...observed, url: url + "/wrong?_rsc=variant" },
    ];
    assert.deepEqual(await collectObservedResources(manifest, trace, out), []);
    assert.ok(manifest.issues.some((i) => i.code === "MOTION_RESOURCE_FAILED"));
    assert.equal(manifest.resources[trace.observedRequests[0].url], undefined);
  } finally {
    await new Promise<void>((r) => origin.close(() => r()));
  }
});
