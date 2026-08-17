import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRun } from "../../measurement/index";
import { validateCaptureResult, type CaptureRequest } from "../index";
import { PlaywrightBrowserDeviceCaptureAdapter } from "../playwright-adapter";

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>NEXUS real browser capture fixture</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; background: #f7f5ef; color: #151515; }
    main { min-height: 120vh; display: grid; place-items: center; padding: 4rem 1.5rem; }
    article { width: min(68rem, 100%); display: grid; gap: 2rem; }
    h1 { font-size: clamp(2.5rem, 9vw, 8rem); line-height: .9; margin: 0; max-width: 10ch; }
    button { width: fit-content; padding: .8rem 1.2rem; font: inherit; }
  </style>
</head>
<body>
  <main>
    <article>
      <p>Measured by a real browser, not a fixture payload.</p>
      <h1>Evidence must exist on disk.</h1>
      <button type="button" aria-label="Run evidence check">Run evidence check</button>
    </article>
  </main>
</body>
</html>`;

describe("PlaywrightBrowserDeviceCaptureAdapter", () => {
  let server: Server;
  let targetUrl: string;
  let outputDir: string;

  beforeAll(async () => {
    outputDir = await mkdtemp(join(tmpdir(), "nexus-real-capture-"));
    server = createServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(HTML);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    targetUrl = `http://127.0.0.1:${address.port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(outputDir, { recursive: true, force: true });
  });

  it("opens Chromium and WebKit at 390/768/1440, persists PNG + axe evidence and hashes the real bytes", async () => {
    const scope = { tenantId: "tenant-real-capture", brandId: "brand-real-capture" };
    const run = createRun({
      workload: {
        id: "browser-capture-fixture",
        version: "1",
        scope,
        name: "Real browser evidence capture",
        parameters: { target: "local-http-fixture" },
      },
      environment: {
        os: process.platform,
        architecture: process.arch,
        runtime: "node",
        runtimeVersion: process.version,
        deviceClass: "github-actions-or-local",
        browser: "chromium+webkit",
      },
      scope,
      startedAt: "2026-08-17T00:00:00.000Z",
    });
    const request: CaptureRequest = {
      run,
      scope,
      targetId: targetUrl,
      capabilities: ["SCREENSHOT", "ACCESSIBILITY", "PERFORMANCE"],
      metadata: { evidenceKind: "real-browser-ci" },
    };
    const adapter = new PlaywrightBrowserDeviceCaptureAdapter({
      outputDir,
      browsers: ["chromium", "webkit"],
      viewports: [
        { name: "mobile-390", width: 390, height: 844 },
        { name: "tablet-768", width: 768, height: 1024 },
        { name: "desktop-1440", width: 1440, height: 1000 },
      ],
      clock: () => "2026-08-17T00:00:01.000Z",
    });

    const result = await adapter.capture(request);
    expect(result.outcome, result.reason).toBe("CAPTURED");
    validateCaptureResult(request, result);

    const screenshots = result.artifacts.filter((artifact) => artifact.capability === "SCREENSHOT");
    const accessibility = result.artifacts.filter((artifact) => artifact.capability === "ACCESSIBILITY");
    expect(screenshots).toHaveLength(6);
    expect(accessibility).toHaveLength(6);
    expect(new Set(screenshots.map((artifact) => artifact.metadata?.browser))).toEqual(new Set(["chromium", "webkit"]));
    expect(new Set(screenshots.map((artifact) => artifact.metadata?.viewport))).toEqual(new Set(["mobile-390", "tablet-768", "desktop-1440"]));

    for (const artifact of result.artifacts) {
      expect(artifact.uri).toBeTruthy();
      const bytes = await readFile(artifact.uri!);
      expect(bytes.byteLength).toBe(artifact.byteLength);
      expect(digest(bytes)).toBe(artifact.digest);
      if (artifact.capability === "SCREENSHOT") {
        expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      } else if (artifact.capability === "ACCESSIBILITY") {
        const parsed = JSON.parse(bytes.toString("utf8")) as { violations?: unknown[] };
        expect(Array.isArray(parsed.violations)).toBe(true);
      }
    }

    expect(result.samples.some((sample) => sample.name.endsWith("script_transfer_bytes") && sample.unit === "bytes")).toBe(true);
    expect(result.samples.some((sample) => sample.name.endsWith("axe_violations") && sample.unit === "count")).toBe(true);
    expect(result.samples.every((sample) => Number.isFinite(sample.value))).toBe(true);
  });

  it("refuses non-HTTP targets instead of pretending they were captured", async () => {
    const scope = { tenantId: "tenant-real-capture", brandId: "brand-real-capture" };
    const run = createRun({
      workload: { id: "invalid-target", version: "1", scope, name: "Invalid target", parameters: {} },
      environment: { os: process.platform, architecture: process.arch, runtime: "node", runtimeVersion: process.version, deviceClass: "test" },
      scope,
      startedAt: "2026-08-17T00:00:00.000Z",
    });
    const adapter = new PlaywrightBrowserDeviceCaptureAdapter({ outputDir, browsers: ["chromium"] });
    await expect(adapter.capture({ run, scope, targetId: "file:///tmp/fake.html", capabilities: ["SCREENSHOT"] })).rejects.toThrow(/HTTP\(S\)/);
  });
});
