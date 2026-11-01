import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import { config, saveJson, hash } from "../src/common.js";
import { integrity } from "../src/build.js";
import {
  completeRequests,
  type MissingRequestLog,
} from "../src/request-completion.js";
import type { Manifest } from "../src/types.js";

test("candidate misses become resources only after real successful origin responses; queries and input seal remain intact", async () => {
  const requests: { url: string; cookie?: string; rsc?: string }[] = [];
  const server = http.createServer((req, res) => {
    requests.push({
      url: req.url!,
      cookie: req.headers.cookie,
      rsc: req.headers.rsc as string,
    });
    res.writeHead(req.url?.includes("/missing") ? 404 : 200, {
      "Content-Type": "text/x-component",
    });
    res.end('0:{"text":"Diseño 🧵"}\n');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const origin = "http://127.0.0.1:" + addr.port;
  const root = await mkdtemp(path.join(os.tmpdir(), "botmd-complete-")),
    cap = path.join(root, "capture");
  const manifest: Manifest = {
    schemaVersion: 1,
    version: "test",
    createdAt: "test",
    browserVersion: "test",
    config: config({ url: origin, allowLocalhost: true }),
    origin,
    pages: [],
    resources: {},
    states: [],
    issues: [],
    files: {},
  };
  await saveJson(path.join(cap, "manifest.json"), manifest);
  await saveJson(path.join(cap, "seal.json"), {
    manifestHash: hash(await readFile(path.join(cap, "manifest.json"))),
  });
  const before = (await integrity(cap)).digest;
  const log: MissingRequestLog = {
    schemaVersion: 1,
    sourceOrigin: origin,
    requests: [
      {
        path: "/case?_rsc=exact-token",
        method: "GET",
        requestHeaders: {
          rsc: "1",
          cookie: "do-not-send",
          authorization: "do-not-send",
        },
      },
      {
        path: "/missing?_rsc=another-token",
        method: "GET",
        requestHeaders: { rsc: "1" },
      },
    ],
  };
  try {
    const out = path.join(root, "derived"),
      receipt = await completeRequests(cap, log, out);
    assert.equal(receipt.status, "incomplete");
    assert.deepEqual(receipt.added, [origin + "/case?_rsc=exact-token"]);
    assert.deepEqual(receipt.unresolved, [
      origin + "/missing?_rsc=another-token",
    ]);
    assert.equal((await integrity(cap)).digest, before);
    const derived = (await integrity(out)).manifest,
      r = derived.resources[receipt.added[0]];
    assert.equal(r.status, 200);
    assert.equal(r.kind, "candidate-requested-get");
    assert.equal(
      await readFile(path.join(out, r.file), "utf8"),
      '0:{"text":"Diseño 🧵"}\n',
    );
    assert.deepEqual(requests, [
      { url: "/case?_rsc=exact-token", cookie: undefined, rsc: "1" },
      { url: "/missing?_rsc=another-token", cookie: undefined, rsc: "1" },
    ]);
    await assert.rejects(
      completeRequests(
        out,
        {
          ...log,
          requests: [
            {
              ...log.requests[0],
              requestHeaders: { rsc: "1", "next-url": "/different" },
            },
          ],
        },
        path.join(root, "conflicting-existing"),
      ),
      /cabeceras/,
    );
    await assert.rejects(
      completeRequests(
        cap,
        { ...log, sourceOrigin: "https://another.example" },
        path.join(root, "wrong"),
      ),
      /origen/,
    );
    await assert.rejects(
      completeRequests(
        cap,
        { ...log, requests: [{ ...log.requests[0], method: "POST" as "GET" }] },
        path.join(root, "post"),
      ),
      /permitida/,
    );
    await assert.rejects(
      completeRequests(
        cap,
        {
          ...log,
          requests: [
            log.requests[0],
            {
              ...log.requests[0],
              requestHeaders: { rsc: "1", "next-url": "/different" },
            },
          ],
        },
        path.join(root, "ambiguous"),
      ),
      /ambiguas/,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
