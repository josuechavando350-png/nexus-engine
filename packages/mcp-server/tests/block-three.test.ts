import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { BuildExecution, BuildManifest } from "../src/build.js";
import type { GitState, ProjectState } from "../src/contracts.js";
import type { VisualComparatorExecution } from "../src/visual-comparator.js";
import { nexusBuild, nexusComparator } from "../src/tools.js";

const sha = "a".repeat(40);
const git: GitState = { branch: "work", headSha: sha, detached: false, clean: true, changedPaths: [], remoteUrl: null };
const project: ProjectState = { slug: "reference-alfil", path: "apps/reference-alfil", packageName: "@nexus/reference-alfil", workspaceMember: true, kind: "REFERENCE", clientProject: false, evidence: { packageJsonPath: "apps/reference-alfil/package.json", clientProjectDeclaration: null, classificationRule: "reference" } };
const base = { root: "/repo", git: async () => git, projects: async () => [project], requestId: () => "block-three", buildValidator: async () => true };

function manifest(): BuildManifest {
  const payload = { authority: "NEXUS_MCP_BUILD_MANIFEST_V1" as const, sourceSha: sha, target: project.path, nodeVersion: "v24.0.0", pnpmVersion: "10.15.0", packageManager: "pnpm@10.15.0", lockfileSha256: "b".repeat(64), buildKey: "c".repeat(64), cacheHit: false, outputDigest: "d".repeat(64), files: [{ path: "apps/reference-alfil/.next/BUILD_ID", byteLength: 20, sha256: "e".repeat(64) }] };
  return { ...payload, manifestSha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
}

function execution(overrides: Partial<BuildExecution> = {}): BuildExecution {
  return { target: { slug: project.slug, path: project.path, packageName: project.packageName }, command: "node scripts/build-target-manifest.mjs", exitCode: 0, durationMs: 10, logPath: "/tmp/build.log", manifest: manifest(), ...overrides };
}

function comparatorExecution(verdict: "PASS" | "FAIL" | "INCOMPATIBLE_BASELINE" = "PASS"): VisualComparatorExecution {
  return {
    projectId: project.slug,
    sourceSha: sha,
    buildDigest: "d".repeat(64),
    buildManifestSha256: "e".repeat(64),
    baselineEnvelopePath: "evidence/visual-baselines.json",
    baselineEnvelopeSha256: "f".repeat(64),
    comparisons: [{
      id: "home-desktop",
      route: "/",
      sceneDigest: "1".repeat(64),
      browserName: "chromium",
      viewport: { name: "desktop", width: 1440, height: 1000 },
      approvalReference: "art-director:approved:2026-09-01",
      baselineDigest: "2".repeat(64),
      baselineScreenshotSha256: "3".repeat(64),
      currentScreenshotSha256: "4".repeat(64),
      captureDigest: "5".repeat(64),
      report: { verdict, reasons: verdict === "PASS" ? [] : ["PIXEL_REGRESSION"], baselineDigest: "2".repeat(64), captureDigest: "5".repeat(64), changedPixels: verdict === "PASS" ? 0 : 10, ratio: verdict === "PASS" ? 0 : 0.01, perceptual: verdict === "PASS" ? 100 : 90, diffSha256: "6".repeat(64), diffPath: "/tmp/diff.png", nonClaim: "VISUAL_REGRESSION_EXECUTION_NOT_AUTOMATIC_ART_DIRECTION_APPROVAL", digest: "7".repeat(64) },
      currentScreenshotPath: "/tmp/current.png",
      diffPath: "/tmp/diff.png",
    }],
    build: execution(),
  };
}

it("returns PASS only for a successful existing-pipeline build with a valid manifest", async () => {
  const result = await nexusBuild({ target: project.slug, sourceSha: sha }, { ...base, buildRunner: async () => execution() });
  expect(result.status).toBe("PASS");
  expect(result.data?.manifest?.sourceSha).toBe(sha);
  expect(result.evidence.some((item) => item.locator.includes(result.data!.manifest!.manifestSha256))).toBe(true);
});

it("distinguishes executed build failure from unavailable build capability", async () => {
  const failed = await nexusBuild({ target: project.slug, sourceSha: sha }, { ...base, buildRunner: async () => execution({ exitCode: 1, manifest: null }) });
  expect(failed.status).toBe("FAIL"); expect(failed.errors[0]?.code).toBe("BUILD_FAILED");
  const unavailable = await nexusBuild({ target: project.slug, sourceSha: sha }, { ...base, buildRunner: async () => execution({ exitCode: null, manifest: null, unavailableReason: "node executable is unavailable" }) });
  expect(unavailable.status).toBe("NOT_TESTED"); expect(unavailable.errors[0]?.code).toBe("DEPENDENCIES_UNAVAILABLE");
});

it("executes the approved-baseline comparator and binds build, baseline, capture and report evidence", async () => {
  const data = comparatorExecution("PASS");
  const result = await nexusComparator({ source: { target: project.slug }, sourceSha: sha, baselineEnvelopePath: "evidence/visual-baselines.json" }, { ...base, visualComparatorRunner: async () => data });
  expect(result.status).toBe("PASS");
  expect(result.data).toBe(data);
  expect(result.evidence.map((item) => item.locator)).toEqual(expect.arrayContaining([
    `git:${sha}`,
    data.baselineEnvelopePath,
    `sha256:${data.baselineEnvelopeSha256}`,
    `sha256:${data.buildManifestSha256}`,
    `sha256:${data.buildDigest}`,
    `baseline:home-desktop#sha256=${data.comparisons[0]!.baselineScreenshotSha256}`,
    `current:home-desktop#sha256=${data.comparisons[0]!.currentScreenshotSha256}`,
    `comparison:home-desktop#sha256=${data.comparisons[0]!.report.digest}`,
  ]));
});

it("fails closed when an executed comparison detects a visual regression", async () => {
  const result = await nexusComparator({ source: { target: project.slug }, sourceSha: sha, baselineEnvelopePath: "evidence/visual-baselines.json" }, { ...base, visualComparatorRunner: async () => comparatorExecution("FAIL") });
  expect(result.status).toBe("FAIL");
  expect(result.errors[0]?.code).toBe("VISUAL_REGRESSION_DETECTED");
});

it("does not fabricate a comparison when the perceptual runtime is unavailable", async () => {
  const result = await nexusComparator({ source: { target: project.slug }, sourceSha: sha, baselineEnvelopePath: "evidence/visual-baselines.json" }, { ...base, visualComparatorRunner: async () => { throw new Error("PERCEPTUAL_COMPARATOR_UNAVAILABLE"); } });
  expect(result.status).toBe("NOT_TESTED");
  expect(result.data).toBeNull();
  expect(result.errors).toEqual([{ code: "VISUAL_COMPARATOR_UNAVAILABLE", message: "required visual-regression runtime dependency is unavailable", retryable: true }]);
});

it("fails comparator target requests that are not bound to current source", async () => {
  const result = await nexusComparator({ source: { target: project.slug }, sourceSha: "f".repeat(40), baselineEnvelopePath: "evidence/visual-baselines.json" }, base);
  expect(result.status).toBe("FAIL");
  expect(result.errors[0]?.code).toBe("SOURCE_SHA_MISMATCH");
});
