import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRun } from "../../measurement/index";
import { evaluateApcaPolicy, evaluateDynamicApcaPolicy, type ApcaAuditReport } from "../apca-audit";
import type { DesignGenomeObservation } from "../design-genome";
import { validateCaptureResult, type CaptureRequest } from "../index";
import { PlaywrightBrowserDeviceCaptureAdapter } from "../playwright-adapter";
import { evaluateWebVitalsPolicy, type WebVitalsEvidence } from "../web-vitals";

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
    article { width: min(68rem, 100%); display: grid; gap: 2rem; border-radius: 18px; }
    h1 { font-size: clamp(2.5rem, 9vw, 8rem); line-height: .9; margin: 0; max-width: 10ch; }
    button { width: fit-content; padding: .8rem 1.2rem; font: inherit; transition: transform 180ms ease; }
  </style>
</head>
<body>
  <main>
    <article>
      <p data-nexus-contrast-role="body">Measured by a real browser, not a fixture payload.</p>
      <h1 data-nexus-contrast-role="headline">Evidence must exist on disk.</h1>
      <button data-nexus-contrast-role="action" type="button" aria-label="Run evidence check">Run evidence check</button>
    </article>
  </main>
</body>
</html>`;

describe("PlaywrightBrowserDeviceCaptureAdapter", () => {
  let server: Server;
  let targetUrl: string;
  let outputDir: string;
  let preserveEvidence = false;

  beforeAll(async () => {
    const configuredEvidenceDir = process.env.NEXUS_CAPTURE_EVIDENCE_DIR?.trim();
    preserveEvidence = Boolean(configuredEvidenceDir);
    outputDir = configuredEvidenceDir ? resolve(configuredEvidenceDir) : await mkdtemp(join(tmpdir(), "nexus-real-capture-"));
    await mkdir(outputDir, { recursive: true });
    server = createServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(HTML);
    });
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = server.address() as AddressInfo;
    targetUrl = `http://127.0.0.1:${address.port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    if (!preserveEvidence) await rm(outputDir, { recursive: true, force: true });
  });

  it("opens Chromium and WebKit at 390/768/1440 and persists PNG + axe + Design Genome + APCA + Web Vitals evidence with real-byte hashes", async () => {
    const scope = { tenantId: "tenant-real-capture", brandId: "brand-real-capture" };
    const run = createRun({
      workload: { id: "browser-capture-fixture", version: "1", scope, name: "Real browser evidence capture", parameters: { target: "local-http-fixture" } },
      environment: { os: process.platform, architecture: process.arch, runtime: "node", runtimeVersion: process.version, deviceClass: "github-actions-or-local", browser: "chromium+webkit" },
      scope,
      startedAt: "2026-08-17T00:00:00.000Z",
    });
    const request: CaptureRequest = {
      run,
      scope,
      targetId: targetUrl,
      capabilities: ["SCREENSHOT", "ACCESSIBILITY", "DESIGN_GENOME", "CONTRAST", "PERFORMANCE"],
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
    const genomes = result.artifacts.filter((artifact) => artifact.capability === "DESIGN_GENOME");
    const contrast = result.artifacts.filter((artifact) => artifact.capability === "CONTRAST");
    const performance = result.artifacts.filter((artifact) => artifact.capability === "PERFORMANCE");
    expect(screenshots).toHaveLength(6);
    expect(accessibility).toHaveLength(6);
    expect(genomes).toHaveLength(6);
    expect(contrast).toHaveLength(6);
    expect(performance).toHaveLength(6);
    expect(new Set(screenshots.map((artifact) => artifact.metadata?.browser))).toEqual(new Set(["chromium", "webkit"]));
    expect(new Set(screenshots.map((artifact) => artifact.metadata?.viewport))).toEqual(new Set(["mobile-390", "tablet-768", "desktop-1440"]));

    const observedGenomes: DesignGenomeObservation[] = [];
    const observedContrast: ApcaAuditReport[] = [];
    const observedVitals: WebVitalsEvidence[] = [];
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
      } else if (artifact.capability === "DESIGN_GENOME") {
        const genome = JSON.parse(bytes.toString("utf8")) as DesignGenomeObservation;
        observedGenomes.push(genome);
        expect(genome.schemaVersion).toBe(1);
        expect(genome.visibleElementCount).toBeGreaterThan(3);
        expect(genome.typography.fontSizePx.length).toBeGreaterThan(0);
        expect(genome.typography.familyCount).toBeGreaterThan(0);
        expect(genome.geometry.borderRadiusPx.some((radius) => radius >= 18)).toBe(true);
        expect(genome.motion.animatedElementCount).toBeGreaterThan(0);
        expect(genome.motion.transitionDurationMs).toContain(180);
      } else if (artifact.capability === "CONTRAST") {
        const report = JSON.parse(bytes.toString("utf8")) as ApcaAuditReport;
        observedContrast.push(report);
        expect(report.schemaVersion).toBe(2);
        expect(report.algorithm).toBe("APCA");
        expect(report.library).toBe("apca-w3");
        expect(report.libraryVersion).toBe("0.1.9");
        expect(report.observations.length).toBeGreaterThanOrEqual(3);
        expect(report.observations.every((observation) => observation.backgroundSource === "RENDERED_PIXEL_SAMPLE")).toBe(true);
        expect(report.observations.every((observation) => Number.isFinite(observation.lc))).toBe(true);
        expect(report.observations.every((observation) => /^sha256:[a-f0-9]{64}$/.test(observation.textDigest))).toBe(true);
      } else if (artifact.capability === "PERFORMANCE") {
        const vitals = JSON.parse(bytes.toString("utf8")) as WebVitalsEvidence;
        observedVitals.push(vitals);
        expect(vitals.schemaVersion).toBe(1);
        for (const vital of [vitals.lcp, vitals.cls, vitals.inp, vitals.fcp, vitals.navigationDuration]) {
          expect(["MEASURED", "NOT_OBSERVED", "UNSUPPORTED"]).toContain(vital.state);
          if (vital.state === "MEASURED") expect(Number.isFinite(vital.value)).toBe(true);
          else expect(vital.value).toBeUndefined();
        }
        expect(Number.isInteger(vitals.resourceCount)).toBe(true);
        expect(vitals.resourceCount).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(vitals.scriptTransferBytes)).toBe(true);
      }
    }

    const mobileGenome = observedGenomes.find((genome) => genome.viewport.width === 390);
    const desktopGenome = observedGenomes.find((genome) => genome.viewport.width === 1440);
    expect(mobileGenome).toBeTruthy();
    expect(desktopGenome).toBeTruthy();
    expect(JSON.stringify(mobileGenome)).not.toBe(JSON.stringify(desktopGenome));

    expect(observedContrast).toHaveLength(6);
    expect(evaluateApcaPolicy(observedContrast[0]!, { minimumAbsLcByRole: { headline: 10, body: 10, action: 10 } }).verdict).toBe("PASS");
    expect(evaluateApcaPolicy(observedContrast[0]!, { minimumAbsLcByRole: {} }).verdict).toBe("NOT_TESTED");
    expect(evaluateApcaPolicy(observedContrast[0]!, { minimumAbsLcByRole: { missing: 10 } }).verdict).toBe("FAIL");
    expect(evaluateDynamicApcaPolicy(observedContrast[0]!, ["headline", "body", "action"]).verdict).toBe("PASS");

    expect(observedVitals).toHaveLength(6);
    expect(evaluateWebVitalsPolicy(observedVitals[0]!, {}).verdict).toBe("NOT_TESTED");
    const inpState = observedVitals[0]!.inp.state;
    const inpRequired = evaluateWebVitalsPolicy(observedVitals[0]!, { requireMeasured: ["inp"] });
    expect(inpState === "MEASURED" ? inpRequired.verdict : "FAIL").toBe(inpRequired.verdict);
    if (inpState !== "MEASURED") expect(inpRequired.findings.some((finding) => finding.includes("INP"))).toBe(true);

    expect(result.samples.some((sample) => sample.name.endsWith("script_transfer_bytes") && sample.unit === "bytes")).toBe(true);
    expect(result.samples.some((sample) => sample.name.endsWith("axe_violations") && sample.unit === "count")).toBe(true);
    expect(result.samples.some((sample) => sample.name.endsWith("genome_visible_elements") && sample.unit === "count")).toBe(true);
    expect(result.samples.some((sample) => sample.name.endsWith("apca_observations") && sample.unit === "count")).toBe(true);
    expect(result.samples.every((sample) => Number.isFinite(sample.value))).toBe(true);

    const manifest = { schemaVersion: 1, adapterId: adapter.adapterId, adapterVersion: adapter.adapterVersion, requestId: result.requestId, outcome: result.outcome, browsers: ["chromium", "webkit"], viewports: [390, 768, 1440], artifacts: result.artifacts, samples: result.samples };
    await writeFile(join(outputDir, "capture-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }, 30_000);

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
