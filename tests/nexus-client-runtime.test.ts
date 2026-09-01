import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceClientRuntimeAdapters } from "../scripts/nexus-client-runtime.mjs";

const SHA = "a".repeat(40);
const BLOB_SHA = "c".repeat(40);
const project = {
  slug: "client",
  path: "apps/client",
  packageName: "@nexus/client",
  workspaceMember: true,
  kind: "CLIENT",
  clientProject: true,
  evidence: { packageJsonPath: "apps/client/package.json", clientProjectDeclaration: true, classificationRule: "test" },
};

function spec(root: string) {
  return {
    projectId: "client",
    sourceRevision: SHA,
    outputDir: join(root, "apps/client"),
    runtime: { target: "client" },
  };
}

function artifact(capability: string, browser: string, viewport: string, index: number) {
  return {
    artifactId: `${capability}-${browser}-${viewport}`,
    runId: "run-1",
    scope: { tenantId: "nexus-mcp", brandId: "client" },
    capability,
    mediaType: capability === "SCREENSHOT" ? "image/png" : "application/json",
    digest: `sha256:${String(index).padStart(64, "0")}`,
    byteLength: 10,
    capturedAt: "2026-09-01T00:00:00.000Z",
    uri: `/tmp/${capability}-${browser}-${viewport}`,
    metadata: { browser, viewport },
  };
}

function captureEvidence() {
  const artifacts = [];
  let index = 1;
  for (const browser of ["chromium", "webkit"]) {
    for (const viewport of ["mobile-390", "tablet-768", "desktop-1440"]) {
      artifacts.push(artifact("SCREENSHOT", browser, viewport, index++));
      artifacts.push(artifact("ACCESSIBILITY", browser, viewport, index++));
      artifacts.push(artifact("DESIGN_GENOME", browser, viewport, index++));
    }
  }
  return { requestId: "capture-1", runId: "run-1", targetUrl: "http://127.0.0.1:3000", artifacts, samples: [] };
}

function digestBoundReview(overrides: Record<string, unknown> = {}) {
  const screenshots = captureEvidence().artifacts.filter((item) => item.capability === "SCREENSHOT");
  return JSON.stringify({
    schemaVersion: 2,
    projectId: "client",
    sourceRevision: SHA,
    evidenceArtifacts: screenshots.map((item) => ({ artifactId: item.artifactId, digest: item.digest })),
    review: {
      reviewerType: "HUMAN",
      reviewerId: "reviewer-1",
      rubricVersion: "1",
      rubricDigest: `sha256:${"f".repeat(64)}`,
      verdict: "PASS",
      findings: [],
      evidenceArtifactIds: screenshots.map((item) => item.artifactId),
      reviewedAt: "2026-09-01T00:00:00.000Z",
    },
    ...overrides,
  });
}

function options(root: string, overrides: Record<string, unknown> = {}) {
  return {
    root,
    projects: async () => [project],
    git: async () => ({ branch: "audit", headSha: SHA, detached: false, clean: true, changedPaths: [], remoteUrl: null }),
    readOnly: async (_command: string, args: readonly string[]) => {
      if (args[0] === "rev-parse" || args[0] === "hash-object") return BLOB_SHA;
      return "";
    },
    build: async () => ({
      target: { slug: "client", path: "apps/client", packageName: "@nexus/client" },
      command: "node scripts/build-target-manifest.mjs",
      exitCode: 0,
      durationMs: 1,
      logPath: "/tmp/build.log",
      manifestPath: "/tmp/manifest.json",
      manifest: { manifestSha256: "b".repeat(64), outputDigest: "c".repeat(64) },
    }),
    buildValidator: async () => true,
    prepareCapture: async () => undefined,
    capture: async () => captureEvidence(),
    ...overrides,
  };
}

function passingVisualJudge() {
  return vi.fn(async ({ artifacts }: { artifacts: readonly { artifactId: string }[] }) => ({
    authority: "NEXUS_VISUAL_JUDGE",
    verdict: "PASS",
    approved: true,
    integrityVerdict: "PASS",
    reviewVerdict: "PASS",
    findings: [],
    verifiedArtifactIds: artifacts.filter((item) => item.artifactId.startsWith("SCREENSHOT-")).map((item) => item.artifactId),
  }));
}

describe("workspace client runtime adapters", () => {
  it("reuses exact-SHA build and browser evidence for render, capture and design genome", async () => {
    const root = "/repo";
    const adapters = await createWorkspaceClientRuntimeAdapters(spec(root), options(root));
    const generation = { generationDigest: `sha256:${"d".repeat(64)}` };
    const render = await adapters.render({ generation });
    expect(render.gate).toMatchObject({ gateId: "RENDER", verdict: "PASS" });
    expect(render.gate.evidenceIds).toContain(`sha256:${"b".repeat(64)}`);

    const capture = await adapters.capture({ generation, render });
    expect(capture.gate).toMatchObject({ gateId: "CAPTURE", verdict: "PASS" });
    expect(capture.evidence.artifacts.filter((item) => item.capability === "SCREENSHOT")).toHaveLength(6);

    const genome = await adapters.designGenome({ capture });
    expect(genome.gate).toMatchObject({ gateId: "DESIGN_GENOME", verdict: "PASS" });
    expect(genome.artifacts).toHaveLength(6);
  });

  it("fails render instead of binding generated dirty bytes to the declared source SHA", async () => {
    const root = "/repo";
    const build = vi.fn();
    const adapters = await createWorkspaceClientRuntimeAdapters(spec(root), options(root, { readOnly: async () => " M apps/client/src/app/page.tsx", build }));
    const render = await adapters.render({ generation: { generationDigest: `sha256:${"d".repeat(64)}` } });
    expect(render.gate.verdict).toBe("FAIL");
    expect(render.gate.detail).toContain("commit the generated bytes and rerun");
    expect(build).not.toHaveBeenCalled();
  });

  it("binds a configured committed visual review to the exact project SHA and captured artifact bytes", async () => {
    const root = "/repo";
    const base = spec(root);
    const configured = { ...base, runtime: { ...base.runtime, visualReviewFile: "evidence/client-visual-review.json" } };
    const visualJudge = passingVisualJudge();
    const review = digestBoundReview();
    const adapters = await createWorkspaceClientRuntimeAdapters(configured, options(root, { visualJudge, readReviewFile: async () => review }));
    const generation = { generationDigest: `sha256:${"d".repeat(64)}` };
    const render = await adapters.render({ generation });
    const capture = await adapters.capture({ generation, render });
    const result = await adapters.visualJudge({ capture });
    expect(result.gate.verdict).toBe("PASS");
    expect(result.gate.evidenceIds[0]).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.gate.evidenceIds).toHaveLength(7);
    expect(visualJudge).toHaveBeenCalledOnce();
  });

  it("rejects a review when an artifact ID is reused for different screenshot bytes", async () => {
    const root = "/repo";
    const base = spec(root);
    const configured = { ...base, runtime: { ...base.runtime, visualReviewFile: "evidence/client-visual-review.json" } };
    const visualJudge = passingVisualJudge();
    const parsed = JSON.parse(digestBoundReview());
    parsed.evidenceArtifacts[0].digest = `sha256:${"e".repeat(64)}`;
    const adapters = await createWorkspaceClientRuntimeAdapters(configured, options(root, { visualJudge, readReviewFile: async () => JSON.stringify(parsed) }));
    const generation = { generationDigest: `sha256:${"d".repeat(64)}` };
    const render = await adapters.render({ generation });
    const capture = await adapters.capture({ generation, render });
    const result = await adapters.visualJudge({ capture });
    expect(result.gate.verdict).toBe("FAIL");
    expect(result.gate.detail).toContain("artifact bytes");
    expect(visualJudge).not.toHaveBeenCalled();
  });

  it("executes a fresh exact-SHA build, recapture and digest-bound rejudge before REPAIR_REJUDGE can pass", async () => {
    const root = "/repo";
    const base = spec(root);
    const configured = { ...base, runtime: { ...base.runtime, visualReviewFile: "evidence/client-visual-review.json" } };
    const visualJudge = passingVisualJudge();
    const build = vi.fn(options(root).build);
    const captureRunner = vi.fn(async () => captureEvidence());
    const adapters = await createWorkspaceClientRuntimeAdapters(configured, options(root, {
      visualJudge,
      build,
      capture: captureRunner,
      readReviewFile: async () => digestBoundReview(),
      qualityCycleDependencies: { clock: () => new Date("2026-09-01T00:02:00.000Z") },
    }));
    const result = await adapters.repairRejudge({ generation: { generationDigest: `sha256:${"d".repeat(64)}` } });
    expect(result.gate).toMatchObject({ gateId: "REPAIR_REJUDGE", verdict: "PASS" });
    expect(result.report.status).toBe("SHIPPABLE");
    expect(result.report.snapshots).toHaveLength(1);
    expect(result.report.repairLineage).toHaveLength(0);
    expect(build).toHaveBeenCalledOnce();
    expect(captureRunner).toHaveBeenCalledOnce();
    expect(visualJudge).toHaveBeenCalledOnce();
  });

  it("fails closed before judging a visual review bound to another source revision", async () => {
    const root = "/repo";
    const base = spec(root);
    const configured = { ...base, runtime: { ...base.runtime, visualReviewFile: "evidence/client-visual-review.json" } };
    const visualJudge = vi.fn();
    const review = digestBoundReview({ sourceRevision: "b".repeat(40) });
    const adapters = await createWorkspaceClientRuntimeAdapters(configured, options(root, { visualJudge, readReviewFile: async () => review }));
    const generation = { generationDigest: `sha256:${"d".repeat(64)}` };
    const render = await adapters.render({ generation });
    const capture = await adapters.capture({ generation, render });
    const result = await adapters.visualJudge({ capture });
    expect(result.gate.verdict).toBe("FAIL");
    expect(result.gate.detail).toContain("does not match");
    expect(visualJudge).not.toHaveBeenCalled();
  });

  it("does not invent production adapters when runtime target is absent", async () => {
    await expect(createWorkspaceClientRuntimeAdapters({ projectId: "client", sourceRevision: SHA }, { root: "/repo" })).resolves.toEqual({});
  });
});
