import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approveBaseline,
  captureScene,
  compareCapture,
  createScene,
  createSsimulacra2Comparator,
  createViewport,
} from "./index.js";

const nativeProof = process.env.NEXUS_NATIVE_VISUAL_PROOF === "1" ? describe : describe.skip;

nativeProof("native visual regression proof", () => {
  let pageVariant: "BASE" | "REGRESSION" = "BASE";
  const server = createServer((_request, response) => {
    const background = pageVariant === "BASE" ? "#111111" : "#ffffff";
    const foreground = pageVariant === "BASE" ? "#f5f5f5" : "#111111";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(`<!doctype html><html><head><style>html,body{margin:0;background:${background};color:${foreground};font-family:Arial,sans-serif}main{width:720px;max-width:90vw;margin:80px auto}.hero{height:260px;display:grid;place-items:center;border:2px solid currentColor}h1{font-size:48px;margin:0}</style></head><body><main><div class="hero"><h1>NEXUS V2</h1></div></main></body></html>`);
  });

  beforeAll(async () => {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  });

  it("captures a real Chromium scene and gates it with the real SSIMULACRA2 binary", async () => {
    const tool = process.env.NEXUS_SSIMULACRA2_PATH?.trim();
    if (!tool) throw new Error("NEXUS_SSIMULACRA2_PATH is required for native browser proof");
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/`;
    const scene = createScene({ id: "native-smoke", url });
    const viewport = createViewport("desktop", 900, 700);
    const root = await mkdtemp(join(tmpdir(), "nexus-vr-native-"));
    try {
      pageVariant = "BASE";
      const baselineCapture = await captureScene({ scene, browserName: "chromium", viewport, revision: "baseline-revision", buildDigest: "a".repeat(64), outDir: join(root, "baseline") });
      const baseline = approveBaseline(baselineCapture.record, "synthetic-native-smoke:explicit-test-fixture");
      const perceptual = createSsimulacra2Comparator(tool);

      const unchanged = await captureScene({ scene, browserName: "chromium", viewport, revision: "unchanged-revision", buildDigest: "b".repeat(64), outDir: join(root, "unchanged") });
      const pass = await compareCapture({ baseline, baselinePath: baselineCapture.path, current: unchanged, policy: scene.policy, perceptual, outDir: join(root, "pass-diff") });
      expect(pass.verdict).toBe("PASS");
      expect(pass.perceptual).toBeGreaterThanOrEqual(scene.policy.minimumPerceptual);

      pageVariant = "REGRESSION";
      const regressed = await captureScene({ scene, browserName: "chromium", viewport, revision: "regressed-revision", buildDigest: "c".repeat(64), outDir: join(root, "regressed") });
      const fail = await compareCapture({ baseline, baselinePath: baselineCapture.path, current: regressed, policy: scene.policy, perceptual, outDir: join(root, "fail-diff") });
      expect(fail.verdict).toBe("FAIL");
      expect(fail.reasons).toContain("PIXEL_REGRESSION");
      expect(fail.reasons).toContain("PERCEPTUAL_REGRESSION");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
