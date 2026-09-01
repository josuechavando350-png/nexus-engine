import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nexusComparatorV2 } from "../src/comparator.js";
import type { ProjectState } from "../src/contracts.js";
import type { ToolDependencies } from "../src/tools.js";

const currentSha = "a".repeat(40);
const baselineSha = "b".repeat(40);
const sceneDigest = "1".repeat(64);
const baselineDigest = "2".repeat(64);
const captureDigest = "3".repeat(64);
const screenshotSha256 = "4".repeat(64);
const buildDigest = "5".repeat(64);
const comparisonDigest = "6".repeat(64);
const manifestDigest = "7".repeat(64);
const blobManifest = "8".repeat(40);
const blobScreenshot = "9".repeat(40);

const project: ProjectState = {
  slug: "reference-alfil",
  path: "apps/reference-alfil",
  packageName: "@nexus/reference-alfil",
  workspaceMember: true,
  kind: "REFERENCE",
  clientProject: false,
  evidence: { packageJsonPath: "apps/reference-alfil/package.json", clientProjectDeclaration: false, classificationRule: "test" },
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function baselineEnvelope() {
  return {
    schemaVersion: 1,
    projectId: project.slug,
    sourceRevision: baselineSha,
    screenshotPath: "baselines/home.png",
    scene: { id: "home", route: "/" },
    baseline: {
      sceneDigest,
      buildDigest: "0".repeat(64),
      environment: {
        browserName: "chromium",
        browserVersion: "140.0",
        playwrightVersion: "1.55.0",
        platform: "linux",
        arch: "x64",
        timezoneId: "UTC",
        locale: "en-US",
        reducedMotion: "reduce",
        colorScheme: "light",
        deviceScaleFactor: 1,
        screenshotScale: "css",
        animations: "disabled",
        caret: "hide",
        digest: "c".repeat(64),
      },
      viewport: { name: "desktop", width: 1440, height: 1000 },
      width: 1440,
      height: 1000,
      screenshotSha256,
      masks: [],
      captureDigest: "d".repeat(64),
      approvalReference: "art-direction:approval-42",
      nonClaim: "VISUAL_REGRESSION_EXECUTION_NOT_AUTOMATIC_ART_DIRECTION_APPROVAL",
      digest: baselineDigest,
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nexus-mcp-comparator-test-"));
  roots.push(root);
  await mkdir(join(root, "baselines"), { recursive: true });
  await writeFile(join(root, "baselines", "home.png"), Buffer.from("baseline-png"));
  await writeFile(join(root, "baseline.json"), `${JSON.stringify(baselineEnvelope(), null, 2)}\n`);
  const dependencies: ToolDependencies = {
    root,
    repository: "josuechavando350-png/nexus-engine",
    clock: () => new Date("2026-09-01T18:00:00.000Z"),
    requestId: () => "comparator-test-request",
    git: async () => ({ branch: "test", headSha: currentSha, detached: false, clean: true, changedPaths: [], remoteUrl: null }),
    projects: async () => [project],
  };
  return { root, dependencies };
}

function buildExecution() {
  return {
    target: { slug: project.slug, path: project.path, packageName: project.packageName },
    command: "test-build",
    exitCode: 0,
    durationMs: 1,
    logPath: "/tmp/build.log",
    manifestPath: "/tmp/manifest.json",
    manifest: {
      authority: "NEXUS_MCP_BUILD_MANIFEST_V1" as const,
      sourceSha: currentSha,
      target: project.path,
      nodeVersion: "v24.0.0",
      pnpmVersion: "10.15.0",
      packageManager: "pnpm@10.15.0",
      lockfileSha256: "e".repeat(64),
      buildKey: "f".repeat(64),
      cacheHit: false,
      outputDigest: buildDigest,
      files: [{ path: `${project.path}/.next/build-manifest.json`, byteLength: 1, sha256: "a".repeat(64) }],
      manifestSha256: manifestDigest,
    },
  };
}

function runtime(overrides: { historicalBlob?: string; verdict?: "PASS" | "FAIL" | "INCOMPATIBLE_BASELINE" } = {}) {
  const readOnly = vi.fn(async (_file: string, args: readonly string[]) => {
    if (args[0] === "status") return "";
    if (args[0] === "hash-object" && args.at(-1) === "baseline.json") return blobManifest;
    if (args[0] === "hash-object" && args.at(-1) === "baselines/home.png") return blobScreenshot;
    if (args[0] === "rev-parse" && args[1] === `${currentSha}:baseline.json`) return blobManifest;
    if (args[0] === "rev-parse" && args[1] === `${currentSha}:baselines/home.png`) return blobScreenshot;
    if (args[0] === "rev-parse" && args[1] === `${baselineSha}:baselines/home.png`) return overrides.historicalBlob ?? blobScreenshot;
    throw new Error(`unexpected readOnly call: ${args.join(" ")}`);
  });
  const captureSceneAtNavigationUrl = vi.fn(async (input: { scene: { digest: string; url: string }; navigationUrl: string }) => {
    expect(input.scene.url).toBe("https://reference-alfil.nexus.invalid/");
    expect(input.navigationUrl).toBe("http://127.0.0.1:43210/");
    return {
      path: "/tmp/current.png",
      record: { sceneDigest, digest: captureDigest, screenshotSha256 },
    };
  });
  const verdict = overrides.verdict ?? "PASS";
  const core = {
    validateBaseline: vi.fn(),
    createScene: vi.fn(() => ({ id: "home", url: "https://reference-alfil.nexus.invalid/", fullPage: true, masks: [], policy: {}, digest: sceneDigest })),
    createViewport: vi.fn((name: string, width: number, height: number) => ({ name, width, height })),
    createSsimulacra2Comparator: vi.fn(() => async () => 100),
    compareCapture: vi.fn(async () => ({
      verdict,
      reasons: verdict === "PASS" ? [] : [verdict === "INCOMPATIBLE_BASELINE" ? "RENDERING_ENVIRONMENT_MISMATCH" : "PIXEL_REGRESSION"],
      baselineDigest,
      captureDigest,
      changedPixels: verdict === "PASS" ? 0 : null,
      ratio: verdict === "PASS" ? 0 : null,
      perceptual: verdict === "PASS" ? 100 : null,
      nonClaim: "VISUAL_REGRESSION_EXECUTION_NOT_AUTOMATIC_ART_DIRECTION_APPROVAL",
      digest: comparisonDigest,
    })),
    validateComparison: vi.fn(),
  };
  return {
    readOnly,
    prepareRuntime: vi.fn(async () => undefined),
    loadRuntime: vi.fn(async () => ({ core, runtime: { captureSceneAtNavigationUrl } } as never)),
    build: vi.fn(async () => buildExecution()),
    buildValidator: vi.fn(async () => true),
    withServer: vi.fn(async (_root: string, _project: ProjectState, operation: (url: string) => Promise<unknown>) => await operation("http://127.0.0.1:43210")),
    perceptualPath: "/tool/ssimulacra2",
    clock: () => new Date("2026-09-01T18:00:00.000Z"),
    requestId: () => "comparator-test-request",
  };
}

describe("MCP comparator V2 runtime", () => {
  it("runs an approved exact-SHA comparison with stable logical scene identity and historical byte provenance", async () => {
    const { dependencies } = await fixture();
    const rt = runtime();
    const result = await nexusComparatorV2({ target: project.slug, sourceSha: currentSha, baselineManifestPath: "baseline.json" }, dependencies, rt as never);
    expect(result.status).toBe("PASS");
    expect(result.data?.authority).toBe("NEXUS_MCP_VISUAL_COMPARATOR_V2");
    expect(result.data?.baseline.sourceRevision).toBe(baselineSha);
    expect(result.data?.baseline.approvalReference).toBe("art-direction:approval-42");
    expect(rt.readOnly).toHaveBeenCalledWith("git", ["rev-parse", `${baselineSha}:baselines/home.png`], expect.any(String));
    expect(result.data?.comparison.nonClaim).toBe("VISUAL_REGRESSION_EXECUTION_NOT_AUTOMATIC_ART_DIRECTION_APPROVAL");
    const reportEvidence = result.evidence.find((item) => item.kind === "artifact" && item.locator.includes("comparison.json#sha256="));
    expect(reportEvidence).toBeDefined();
    const [reportPath, declaredHash] = reportEvidence!.locator.split("#sha256=");
    const reportBytes = await readFile(reportPath!);
    expect(createHash("sha256").update(reportBytes).digest("hex")).toBe(declaredHash);
    expect(declaredHash).not.toBe(comparisonDigest);
  });

  it("fails closed when the baseline screenshot bytes did not exist at the claimed approved revision", async () => {
    const { dependencies } = await fixture();
    const result = await nexusComparatorV2({ target: project.slug, sourceSha: currentSha, baselineManifestPath: "baseline.json" }, dependencies, runtime({ historicalBlob: "0".repeat(40) }) as never);
    expect(result.status).toBe("FAIL");
    expect(result.errors[0]?.code).toBe("COMPARATOR_FAILED");
    expect(result.errors[0]?.message).toMatch(/approved sourceRevision.*bytes do not match/u);
  });

  it("rejects a baseline manifest path that escapes the repository before build or capture", async () => {
    const { dependencies } = await fixture();
    const rt = runtime();
    const result = await nexusComparatorV2({ target: project.slug, sourceSha: currentSha, baselineManifestPath: "../outside.json" }, dependencies, rt as never);
    expect(result.status).toBe("FAIL");
    expect(result.errors[0]?.message).toMatch(/must stay inside repository root/u);
    expect(rt.build).not.toHaveBeenCalled();
    expect(rt.loadRuntime).not.toHaveBeenCalled();
  });

  it("rejects a committed-looking baseline symlink that resolves outside the repository", async () => {
    const { root, dependencies } = await fixture();
    const outside = `${root}-outside.json`;
    roots.push(outside);
    await writeFile(outside, `${JSON.stringify(baselineEnvelope())}\n`);
    await symlink(outside, join(root, "baseline-link.json"));
    const rt = runtime();
    const result = await nexusComparatorV2({ target: project.slug, sourceSha: currentSha, baselineManifestPath: "baseline-link.json" }, dependencies, rt as never);
    expect(result.status).toBe("FAIL");
    expect(result.errors[0]?.message).toMatch(/regular file and not a symlink|resolves outside repository root/u);
    expect(rt.build).not.toHaveBeenCalled();
  });

  it("maps an environment-incompatible approved baseline to NOT_TESTED rather than fabricated PASS", async () => {
    const { dependencies } = await fixture();
    const result = await nexusComparatorV2({ target: project.slug, sourceSha: currentSha, baselineManifestPath: "baseline.json" }, dependencies, runtime({ verdict: "INCOMPATIBLE_BASELINE" }) as never);
    expect(result.status).toBe("NOT_TESTED");
    expect(result.errors).toEqual([expect.objectContaining({ code: "INCOMPATIBLE_BASELINE" })]);
  });
});
