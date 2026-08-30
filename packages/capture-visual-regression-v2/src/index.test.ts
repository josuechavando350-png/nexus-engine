import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  NON_CLAIM,
  approveBaseline,
  canonicalJson,
  compareCapture,
  createScene,
  createSsimulacra2Comparator,
  createViewport,
  digest,
  validateBaseline,
  validateCaptureRecord,
  validateComparison,
  type CaptureArtifact,
  type CaptureRecord,
  type MaskObservation,
  type RenderingEnvironment,
} from "./index.js";

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "nexus-vr-v2-"));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

async function png(path: string, width: number, height: number, rgb: { r: number; g: number; b: number }): Promise<void> {
  await sharp({ create: { width, height, channels: 4, background: { ...rgb, alpha: 1 } } }).png().toFile(path);
}

function environment(version = "140.0"): RenderingEnvironment {
  const core = {
    browserName: "chromium" as const,
    browserVersion: version,
    playwrightVersion: "1.55.0",
    platform: "linux",
    arch: "x64",
    timezoneId: "UTC" as const,
    locale: "en-US" as const,
    reducedMotion: "reduce" as const,
    colorScheme: "light" as const,
    deviceScaleFactor: 1 as const,
    screenshotScale: "css" as const,
    animations: "disabled" as const,
    caret: "hide" as const,
  };
  return { ...core, digest: digest(core) };
}

async function artifact(input: {
  path: string;
  sceneDigest: string;
  masks?: readonly MaskObservation[];
  env?: RenderingEnvironment;
  revision?: string;
  buildDigest?: string;
}): Promise<CaptureArtifact> {
  const metadata = await sharp(input.path).metadata();
  const bytes = await readFile(input.path);
  const screenshotSha256 = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
  const core = {
    sceneDigest: input.sceneDigest,
    revision: input.revision ?? "rev-1",
    buildDigest: input.buildDigest ?? "b".repeat(64),
    environment: input.env ?? environment(),
    viewport: createViewport("desktop", 100, 100),
    width: metadata.width ?? 100,
    height: metadata.height ?? 100,
    screenshotSha256,
    masks: input.masks ?? [],
  };
  const record: CaptureRecord = { ...core, digest: digest(core) };
  return { record, path: input.path };
}

describe("visual regression v2", () => {
  it("creates deterministic scenes and rejects broad or unapproved masks", () => {
    const a = createScene({ id: "home", url: "https://example.com/" });
    const b = createScene({ id: "home", url: "https://example.com/#ignored" });
    expect(a.digest).toBe(b.digest);
    expect(() => createScene({ id: "x", url: "https://example.com/", masks: [{ selector: "body", reason: "dynamic", approvalReference: "approved:1" }] })).toThrow(/broad mask/);
    expect(() => createScene({ id: "x", url: "https://example.com/", masks: [{ selector: ".ticker", reason: "", approvalReference: "approved:1" }] })).toThrow(/must not be empty/);
  });

  it("requires explicit baseline approval provenance and validates replay digests", async () => {
    await withTemp(async (dir) => {
      const path = join(dir, "a.png");
      await png(path, 100, 100, { r: 20, g: 30, b: 40 });
      const scene = createScene({ id: "home", url: "https://example.com/" });
      const capture = await artifact({ path, sceneDigest: scene.digest });
      expect(() => approveBaseline(capture.record, " ")).toThrow(/must not be empty/);
      const baseline = approveBaseline(capture.record, "art-direction:approval-42");
      expect(baseline.nonClaim).toBe(NON_CLAIM);
      expect(() => validateBaseline(baseline)).not.toThrow();
      expect(() => validateCaptureRecord(capture.record)).not.toThrow();
      expect(() => validateBaseline({ ...baseline, approvalReference: "forged" })).toThrow(/digest mismatch/);
    });
  });

  it("passes identical evidence and binds baseline/capture/diff digests", async () => {
    await withTemp(async (dir) => {
      const a = join(dir, "a.png");
      const b = join(dir, "b.png");
      await png(a, 100, 100, { r: 20, g: 30, b: 40 });
      await png(b, 100, 100, { r: 20, g: 30, b: 40 });
      const scene = createScene({ id: "home", url: "https://example.com/" });
      const baseCapture = await artifact({ path: a, sceneDigest: scene.digest });
      const current = await artifact({ path: b, sceneDigest: scene.digest });
      const baseline = approveBaseline(baseCapture.record, "art-direction:approval-1");
      const report = await compareCapture({ baseline, baselinePath: a, current, policy: scene.policy, perceptual: async () => 100, outDir: join(dir, "diff") });
      expect(report.verdict).toBe("PASS");
      expect(report.changedPixels).toBe(0);
      expect(report.baselineDigest).toBe(baseline.digest);
      expect(report.captureDigest).toBe(current.record.digest);
      expect(report.diffSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(() => validateComparison(report)).not.toThrow();
      expect(canonicalJson(report)).toBe(canonicalJson(report));
    });
  });

  it("invalidates the baseline when the rendering environment changes", async () => {
    await withTemp(async (dir) => {
      const a = join(dir, "a.png");
      const b = join(dir, "b.png");
      await png(a, 10, 10, { r: 0, g: 0, b: 0 });
      await png(b, 10, 10, { r: 0, g: 0, b: 0 });
      const scene = createScene({ id: "home", url: "https://example.com/" });
      const baseCapture = await artifact({ path: a, sceneDigest: scene.digest, env: environment("140.0") });
      const current = await artifact({ path: b, sceneDigest: scene.digest, env: environment("141.0") });
      const report = await compareCapture({ baseline: approveBaseline(baseCapture.record, "approval:1"), baselinePath: a, current, policy: scene.policy, perceptual: async () => 100, outDir: join(dir, "diff") });
      expect(report.verdict).toBe("INCOMPATIBLE_BASELINE");
      expect(report.reasons).toContain("RENDERING_ENVIRONMENT_MISMATCH");
    });
  });

  it("fails dimension mismatch before pixel or perceptual scoring", async () => {
    await withTemp(async (dir) => {
      const a = join(dir, "a.png");
      const b = join(dir, "b.png");
      await png(a, 100, 100, { r: 0, g: 0, b: 0 });
      await png(b, 100, 120, { r: 0, g: 0, b: 0 });
      const scene = createScene({ id: "home", url: "https://example.com/" });
      const baseCapture = await artifact({ path: a, sceneDigest: scene.digest });
      const current = await artifact({ path: b, sceneDigest: scene.digest });
      let called = false;
      const report = await compareCapture({ baseline: approveBaseline(baseCapture.record, "approval:1"), baselinePath: a, current, policy: scene.policy, perceptual: async () => { called = true; return 100; }, outDir: join(dir, "diff") });
      expect(report.verdict).toBe("FAIL");
      expect(report.reasons).toEqual(["DIMENSION_MISMATCH"]);
      expect(called).toBe(false);
    });
  });

  it("rejects mask match-count and area drift so masks cannot silently grow", async () => {
    await withTemp(async (dir) => {
      const a = join(dir, "a.png");
      const b = join(dir, "b.png");
      await png(a, 100, 100, { r: 0, g: 0, b: 0 });
      await png(b, 100, 100, { r: 0, g: 0, b: 0 });
      const scene = createScene({ id: "home", url: "https://example.com/", masks: [{ selector: ".live", reason: "clock", approvalReference: "approval:mask" }] });
      const baseCapture = await artifact({ path: a, sceneDigest: scene.digest, masks: [{ selector: ".live", count: 1, areaRatio: 0.01 }] });
      const current = await artifact({ path: b, sceneDigest: scene.digest, masks: [{ selector: ".live", count: 2, areaRatio: 0.03 }] });
      const report = await compareCapture({ baseline: approveBaseline(baseCapture.record, "approval:1"), baselinePath: a, current, policy: scene.policy, perceptual: async () => 100, outDir: join(dir, "diff") });
      expect(report.verdict).toBe("FAIL");
      expect(report.reasons).toContain("MASK_MATCH_COUNT_DRIFT");
    });
  });

  it("fails closed if screenshot bytes do not match their bound evidence", async () => {
    await withTemp(async (dir) => {
      const a = join(dir, "a.png");
      const b = join(dir, "b.png");
      await png(a, 10, 10, { r: 0, g: 0, b: 0 });
      await png(b, 10, 10, { r: 0, g: 0, b: 0 });
      const scene = createScene({ id: "home", url: "https://example.com/" });
      const baseCapture = await artifact({ path: a, sceneDigest: scene.digest });
      const current = await artifact({ path: b, sceneDigest: scene.digest });
      await png(b, 10, 10, { r: 255, g: 255, b: 255 });
      await expect(compareCapture({ baseline: approveBaseline(baseCapture.record, "approval:1"), baselinePath: a, current, policy: scene.policy, perceptual: async () => 100, outDir: join(dir, "diff") })).rejects.toThrow(/current screenshot hash mismatch/);
    });
  });

  it("fails both pixel and perceptual gates on a large visual regression", async () => {
    await withTemp(async (dir) => {
      const a = join(dir, "a.png");
      const b = join(dir, "b.png");
      await png(a, 100, 100, { r: 0, g: 0, b: 0 });
      await png(b, 100, 100, { r: 255, g: 255, b: 255 });
      const scene = createScene({ id: "home", url: "https://example.com/" });
      const baseCapture = await artifact({ path: a, sceneDigest: scene.digest });
      const current = await artifact({ path: b, sceneDigest: scene.digest });
      const report = await compareCapture({ baseline: approveBaseline(baseCapture.record, "approval:1"), baselinePath: a, current, policy: scene.policy, perceptual: async () => 20, outDir: join(dir, "diff") });
      expect(report.verdict).toBe("FAIL");
      expect(report.reasons).toContain("PIXEL_REGRESSION");
      expect(report.reasons).toContain("PERCEPTUAL_REGRESSION");
    });
  });

  it("parses a real-tool-shaped SSIMULACRA2 result through the shared perceptual parser", async () => {
    const comparator = createSsimulacra2Comparator("/tool/ssimulacra2", async (file, args) => {
      expect(file).toBe("/tool/ssimulacra2");
      expect(args).toEqual(["base.png", "current.png"]);
      return { stdout: "SSIMULACRA2: 99.25", stderr: "" };
    });
    await expect(comparator("base.png", "current.png")).resolves.toBe(99.25);
  });

  it("rejects tampered comparison digests", async () => {
    await withTemp(async (dir) => {
      const a = join(dir, "a.png");
      const b = join(dir, "b.png");
      await png(a, 10, 10, { r: 1, g: 2, b: 3 });
      await png(b, 10, 10, { r: 1, g: 2, b: 3 });
      const scene = createScene({ id: "home", url: "https://example.com/" });
      const baseCapture = await artifact({ path: a, sceneDigest: scene.digest });
      const current = await artifact({ path: b, sceneDigest: scene.digest });
      const report = await compareCapture({ baseline: approveBaseline(baseCapture.record, "approval:1"), baselinePath: a, current, policy: scene.policy, perceptual: async () => 100, outDir: join(dir, "diff") });
      expect(() => validateComparison({ ...report, changedPixels: 1 })).toThrow(/digest mismatch/);
      await writeFile(join(dir, "report.json"), JSON.stringify(report));
    });
  });
});
