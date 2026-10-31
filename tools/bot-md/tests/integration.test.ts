import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { fixture } from "./fixture-server.js";
import { config, json, saveJson } from "../src/common.js";
import { capture } from "../src/capture.js";
import { build, integrity } from "../src/build.js";
import { verify } from "../src/verify.js";
import { repair } from "../src/repair.js";
import type { Build } from "../src/types.js";

test(
  "offline capture → reconstruction → verification → defect detection → measured repair",
  { timeout: 240000 },
  async () => {
    const out = path.resolve("test-output/integration-" + Date.now());
    await mkdir(out, { recursive: true });
    const source = await fixture();
    const cap = path.join(out, "capture"),
      site = path.join(out, "site");
    let manifest;
    try {
      manifest = await capture(
        config({
          url: source.url,
          allowLocalhost: true,
          maxPages: 1,
          maxStates: 4,
          settleMs: 100,
          maxScrollSteps: 3,
          viewports: [
            { name: "mobile", width: 390, height: 844 },
            { name: "desktop", width: 1280, height: 900 },
          ],
          scenarios: [
            {
              name: "engineering",
              steps: [{ action: "click", selector: "#engineering" }],
              assertions: [
                { selector: "#panel", kind: "text", value: "Sistemas rápidos" },
              ],
            },
          ],
        }),
        cap,
        () => {},
      );
    } finally {
      await source.close();
    }
    assert.ok(manifest.states.length >= 6);
    assert.ok(
      Object.values(manifest.resources).some((r) => r.kind === "fetch"),
    );
    assert.ok(manifest.states.every((s) => s.assertionResults.every(Boolean)));
    assert.ok(manifest.states.some((s) => s.domSnapshot));
    const inputs = await Promise.all(
      manifest.states.map(
        async (s) =>
          (
            await json<import("../src/types.js").Layout>(
              path.join(cap, s.layout),
            )
          ).input,
      ),
    );
    assert.ok(
      inputs[0],
      "Capture must record the actual input media environment.",
    );
    for (const input of inputs)
      assert.deepEqual(
        input,
        inputs[0],
        "DOM/font inspection must not change hover or pointer between scenarios.",
      );
    const built = await build(cap, site);
    assert.ok(
      Object.values(built.routes).some((r) => r.mime.includes("text/css")),
    );
    const baseline = await verify(
      cap,
      site,
      path.join(out, "baseline"),
      () => {},
    );
    assert.equal(
      baseline.totals.pass,
      manifest.states.length,
      JSON.stringify(baseline.results.filter((r) => r.status !== "pass")),
    );
    const selected = await verify(
      cap,
      site,
      path.join(out, "selected"),
      () => {},
      { stateIds: [manifest.states[0].id] },
    );
    assert.equal(selected.results.length, 1);
    assert.equal(selected.totals.pass, 1);
    assert.deepEqual(selected.selection, [manifest.states[0].id]);
    await assert.rejects(
      () =>
        verify(cap, site, path.join(out, "invalid-selection"), () => {}, {
          stateIds: ["unknown"],
        }),
      /desconocida/,
    );
    const css = Object.values(built.routes).find((r) =>
      r.sourceUrl.endsWith("/styles/main.css"),
    )!;
    const cssPath = path.join(site, css.file);
    const originalCSS = await readFile(cssPath, "utf8");
    await writeFile(cssPath, originalCSS + "\n#badge {font-size:36px;}\n");
    const defective = await verify(
      cap,
      site,
      path.join(out, "defect"),
      () => {},
    );
    assert.ok(
      defective.totals.fail > 0,
      "An intentional font-size defect must fail.",
    );
    const fixed = await repair(cap, site, path.join(out, "repair"), 2);
    assert.ok(
      fixed.log.some((x: any) => x.accepted),
      "At least one measured repair must be accepted.",
    );
    assert.equal(fixed.verification.totals.pass, manifest.states.length);
    // Missing API data cannot silently pass as a complete replica.
    const routes = await json<Build>(path.join(site, "routes.json"));
    delete routes.routes["/api/stats"];
    await saveJson(path.join(site, "routes.json"), routes);
    const missing = await verify(
      cap,
      site,
      path.join(out, "missing-api"),
      () => {},
    );
    assert.ok(missing.totals.fail > 0);
    assert.ok(
      missing.results.some((r) =>
        r.missingRequests.some((u) => u.includes("/api/stats")),
      ),
    );
    const snapshot = path.join(cap, manifest.states[0].layout);
    const raw = await readFile(snapshot);
    await writeFile(snapshot, Buffer.concat([raw, Buffer.from(" ")]));
    await assert.rejects(() => integrity(cap), /referencia cambió/);
    await writeFile(snapshot, raw);
    await saveJson(path.join(out, "test-receipt.json"), {
      sourceOffline: true,
      states: manifest.states.length,
      baseline: baseline.totals,
      defect: defective.totals,
      repair: fixed.verification.totals,
      missingAPI: missing.totals,
      tamperDetected: true,
    });
    console.log("Integration receipt: " + path.join(out, "test-receipt.json"));
  },
);
