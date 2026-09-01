import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRemovalExperiments } from "../removal-experiment";

const sha256 = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{margin:0;font:16px system-ui}main{padding:24px;display:grid;gap:24px}.hero{min-height:70vh;display:grid;align-content:center;gap:12px}.proof{min-height:30vh}
</style></head><body><main><section class="hero" data-nexus-element="hero-copy"><h1>Deliberate legal strategy</h1><p>Evidence-led representation for complex matters.</p><a href="#contact">Request consultation</a></section><section class="proof"><h2>Proof</h2><p>Verified case material.</p></section></main></body></html>`;

describe("removal experiment runner", () => {
  let server: Server;
  let targetUrl: string;
  let outputDir: string;
  let preserve = false;

  beforeAll(async () => {
    const base = process.env.NEXUS_CAPTURE_EVIDENCE_DIR?.trim();
    preserve = Boolean(base);
    outputDir = base ? resolve(base, "removal-experiments") : await mkdtemp(join(tmpdir(), "nexus-removal-"));
    await mkdir(outputDir, { recursive: true });
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(HTML);
    });
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address() as AddressInfo;
    targetUrl = `http://127.0.0.1:${address.port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    if (!preserve) await rm(outputDir, { recursive: true, force: true });
  });

  it("persists real before/after screenshots, semantic diagnostics and Design Genome evidence", async () => {
    const result = await runRemovalExperiments({
      targetUrl,
      outputDir,
      browser: "chromium",
      viewport: { width: 390, height: 844 },
      candidates: [{ elementId: "hero-copy", selector: "[data-nexus-element='hero-copy']" }],
    });
    expect(result.authority).toBe("NEXUS_REMOVAL_EXPERIMENT_RUNNER");
    expect(result.artifacts).toHaveLength(1);
    const artifact = result.artifacts[0]!;
    expect(artifact.removedNodeCount).toBe(1);
    expect(artifact.before.selectorCount).toBe(1);
    expect(artifact.after.selectorCount).toBe(0);
    expect(artifact.before.target.visible).toBe(true);
    expect(artifact.before.target.headingOneCount).toBe(1);
    expect(artifact.before.target.interactiveElementCount).toBe(1);
    expect(artifact.before.headingOneCount).toBe(1);
    expect(artifact.after.headingOneCount).toBe(0);
    expect(artifact.before.designGenome.visibleElementCount).toBeGreaterThan(artifact.after.designGenome.visibleElementCount);

    const before = await readFile(artifact.beforeScreenshotUri);
    const after = await readFile(artifact.afterScreenshotUri);
    const diagnostics = await readFile(artifact.diagnosticsUri);
    expect(before.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(after.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(sha256(before)).toBe(artifact.beforeScreenshotDigest);
    expect(sha256(after)).toBe(artifact.afterScreenshotDigest);
    expect(sha256(diagnostics)).toBe(artifact.diagnosticsDigest);
    expect(artifact.beforeScreenshotDigest).not.toBe(artifact.afterScreenshotDigest);
  }, 30_000);

  it("fails closed unless a selector resolves exactly one node", async () => {
    await expect(runRemovalExperiments({
      targetUrl,
      outputDir,
      candidates: [{ elementId: "paragraph", selector: "p" }],
    })).rejects.toThrow(/exactly one node/);
  });

  it("persists distinct evidence paths when different element IDs normalize to the same filename", async () => {
    const result = await runRemovalExperiments({
      targetUrl,
      outputDir,
      candidates: [
        { elementId: "hero/copy", selector: ".hero" },
        { elementId: "hero?copy", selector: ".proof" },
      ],
    });
    expect(result.artifacts).toHaveLength(2);
    const paths = result.artifacts.flatMap((artifact) => [artifact.beforeScreenshotUri, artifact.afterScreenshotUri, artifact.diagnosticsUri]);
    expect(new Set(paths).size).toBe(paths.length);
    for (const artifact of result.artifacts) {
      expect(sha256(await readFile(artifact.beforeScreenshotUri))).toBe(artifact.beforeScreenshotDigest);
      expect(sha256(await readFile(artifact.afterScreenshotUri))).toBe(artifact.afterScreenshotDigest);
      expect(sha256(await readFile(artifact.diagnosticsUri))).toBe(artifact.diagnosticsDigest);
    }
  }, 30_000);

  it("rejects duplicate candidates and non-http targets before manufacturing evidence", async () => {
    await expect(runRemovalExperiments({
      targetUrl,
      outputDir,
      candidates: [
        { elementId: "same", selector: ".hero" },
        { elementId: "same", selector: ".proof" },
      ],
    })).rejects.toThrow(/elementId values must be unique/);
    await expect(runRemovalExperiments({
      targetUrl: "file:///tmp/fake.html",
      outputDir,
      candidates: [{ elementId: "hero", selector: ".hero" }],
    })).rejects.toThrow(/HTTP\(S\)/);
    await expect(runRemovalExperiments({
      targetUrl,
      outputDir,
      browser: "firefox" as never,
      candidates: [{ elementId: "hero", selector: ".hero" }],
    })).rejects.toThrow(/unsupported removal experiment browser/);
    await expect(runRemovalExperiments({
      targetUrl,
      outputDir,
      navigationTimeoutMs: 0,
      candidates: [{ elementId: "hero", selector: ".hero" }],
    })).rejects.toThrow(/navigationTimeoutMs/);
    await expect(runRemovalExperiments({
      targetUrl,
      outputDir,
      candidates: Array.from({ length: 101 }, (_, index) => ({ elementId: `candidate-${index}`, selector: `[data-candidate='${index}']` })),
    })).rejects.toThrow(/at most 100 candidates/);
  });
});
