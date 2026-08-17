import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBrowserMutationSuite } from "../mutation-runner";

const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{margin:0;font:16px system-ui;overflow-x:hidden}main{padding:24px;display:grid;gap:24px}.hero{min-height:70vh;display:grid;align-content:center}.moving{transition:transform 180ms ease}.media{width:min(700px,100%);height:260px;object-fit:cover}
</style></head><body><main><section class="hero"><h1>A deliberate business-specific opening</h1><p>Short copy that can be stressed by the mutation runner.</p><button class="moving">Primary action</button><img class="media" alt="fixture" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='700' height='260'%3E%3Crect width='700' height='260' fill='%23999'/%3E%3C/svg%3E"></section></main></body></html>`;

describe("browser mutation runner", () => {
  let server: Server;
  let targetUrl: string;
  let outputDir: string;
  let preserve = false;

  beforeAll(async () => {
    const base = process.env.NEXUS_CAPTURE_EVIDENCE_DIR?.trim();
    preserve = Boolean(base);
    outputDir = base ? resolve(base, "mutations") : await mkdtemp(join(tmpdir(), "nexus-mutations-"));
    await mkdir(outputDir, { recursive: true });
    server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(HTML); });
    await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
    const address = server.address() as AddressInfo;
    targetUrl = `http://127.0.0.1:${address.port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    if (!preserve) await rm(outputDir, { recursive: true, force: true });
  });

  it("executes grayscale, motion, viewport, content and asset mutations and persists real evidence", async () => {
    const result = await runBrowserMutationSuite({ targetUrl, outputDir, browser: "chromium" });
    expect(result.authority).toBe("NEXUS_BROWSER_MUTATION_RUNNER");
    expect(result.artifacts.map((artifact) => artifact.mutationId)).toEqual([
      "GRAYSCALE",
      "MOTION_REMOVAL",
      "VIEWPORT_TORTURE_NARROW",
      "VIEWPORT_TORTURE_WIDE",
      "CONTENT_STRESS",
      "ASSET_DEGRADATION",
    ]);
    expect(result.artifacts).toHaveLength(6);

    for (const artifact of result.artifacts) {
      const screenshot = await readFile(artifact.screenshotUri);
      const diagnostics = await readFile(artifact.diagnosticsUri);
      expect(screenshot.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(screenshot.byteLength).toBe(artifact.screenshotByteLength);
      expect(sha256(screenshot)).toBe(artifact.screenshotDigest);
      expect(sha256(diagnostics)).toBe(artifact.diagnosticsDigest);
      expect(Number.isFinite(artifact.diagnostics.horizontalOverflowPx)).toBe(true);
      expect(artifact.diagnostics.visibleElementCount).toBeGreaterThan(0);
    }

    const motion = result.artifacts.find((artifact) => artifact.mutationId === "MOTION_REMOVAL")!;
    expect(motion.diagnostics.animatedElementCount).toBe(0);
    const narrow = result.artifacts.find((artifact) => artifact.mutationId === "VIEWPORT_TORTURE_NARROW")!;
    const wide = result.artifacts.find((artifact) => artifact.mutationId === "VIEWPORT_TORTURE_WIDE")!;
    expect(narrow.viewport.width).toBe(320);
    expect(wide.viewport.width).toBe(1920);
    const content = result.artifacts.find((artifact) => artifact.mutationId === "CONTENT_STRESS")!;
    const grayscale = result.artifacts.find((artifact) => artifact.mutationId === "GRAYSCALE")!;
    expect(content.diagnostics.textCharacterCount).toBeGreaterThan(grayscale.diagnostics.textCharacterCount);
  });

  it("refuses non-http targets instead of manufacturing mutation evidence", async () => {
    await expect(runBrowserMutationSuite({ targetUrl: "file:///tmp/fake.html", outputDir })).rejects.toThrow(/HTTP\(S\)/);
  });
});
