import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADVERSARIAL_PROBES, runAdversarialMatrix } from "../adversarial-matrix";

const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{margin:0;font:16px system-ui;overflow-x:hidden}main{padding:24px}.hero{min-height:70vh}.moving{transition:transform 180ms ease}.media{width:min(700px,100%);height:260px;object-fit:cover}
</style></head><body><main><section class="hero"><h1>Short title</h1><p>Stress this content without breaking the page.</p><a href="#next">Primary action</a><button class="moving">Secondary action</button><img class="media" alt="fixture" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='700' height='260'%3E%3Crect width='700' height='260' fill='%23999'/%3E%3C/svg%3E"></section><section id="next"><input aria-label="Email"><button>Submit</button></section></main></body></html>`;

describe("adversarial browser matrix", () => {
  let server: Server;
  let targetUrl: string;
  let outputDir: string;
  let preserve = false;

  beforeAll(async () => {
    const base = process.env.NEXUS_CAPTURE_EVIDENCE_DIR?.trim();
    preserve = Boolean(base);
    outputDir = base ? resolve(base, "adversarial") : await mkdtemp(join(tmpdir(), "nexus-adversarial-"));
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

  it("executes the full stress matrix and persists verifiable evidence", async () => {
    const result = await runAdversarialMatrix({ targetUrl, outputDir });
    expect(result.authority).toBe("NEXUS_ADVERSARIAL_MATRIX_V1");
    expect(result.artifacts.map((artifact) => artifact.probeId)).toEqual(ADVERSARIAL_PROBES);
    expect(result.artifacts).toHaveLength(9);
    for (const artifact of result.artifacts) {
      const screenshot = await readFile(artifact.screenshotUri);
      const diagnostics = await readFile(artifact.diagnosticsUri);
      expect(screenshot.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(sha256(screenshot)).toBe(artifact.screenshotDigest);
      expect(sha256(diagnostics)).toBe(artifact.diagnosticsDigest);
      expect(artifact.diagnostics.visibleElementCount).toBeGreaterThan(0);
    }

    const doubled = result.artifacts.find((artifact) => artifact.probeId === "TEXT_DOUBLE")!;
    const title = result.artifacts.find((artifact) => artifact.probeId === "TITLE_40")!;
    const noMedia = result.artifacts.find((artifact) => artifact.probeId === "NO_MEDIA")!;
    const vertical = result.artifacts.find((artifact) => artifact.probeId === "VERTICAL_MEDIA")!;
    const lowEnd = result.artifacts.find((artifact) => artifact.probeId === "LOW_END_ANDROID")!;
    const zoom = result.artifacts.find((artifact) => artifact.probeId === "ZOOM_200")!;
    const keyboard = result.artifacts.find((artifact) => artifact.probeId === "KEYBOARD_ONLY")!;
    const reduced = result.artifacts.find((artifact) => artifact.probeId === "REDUCED_MOTION")!;

    expect(doubled.diagnostics.textCharacterCount).toBeGreaterThan(100);
    expect(title.diagnostics.maximumHeadingLength).toBe(40);
    expect(noMedia.diagnostics.mediaElementCount).toBe(0);
    expect(vertical.diagnostics.verticalMediaCount).toBeGreaterThan(0);
    expect(lowEnd.diagnostics.viewportWidth).toBe(360);
    expect(zoom.diagnostics.cssZoom).toBe(2);
    expect(keyboard.diagnostics.focusedCount).toBeGreaterThan(0);
    expect(reduced.diagnostics.reducedMotionMatches).toBe(true);
    expect(reduced.diagnostics.animatedElementCount).toBe(0);
  }, 120_000);
});
