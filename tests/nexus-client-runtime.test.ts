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

function artifact(capability: string, browser: string, viewport: string, index: number, run = "run-1") {
  return {
    artifactId: `${run}-${capability}-${browser}-${viewport}`,
    runId: run,
    scope: { tenantId: "nexus-mcp", brandId: "client" },
    capability,
    mediaType: capability === "SCREENSHOT" ? "image/png" : "application/json",
    digest: `sha256:${String(index).padStart(64, "0")}`,
    byteLength: 10,
    capturedAt: "2026-09-01T00:00:00.000Z",
    uri: `/tmp/${run}-${capability}-${browser}-${viewport}`,
    metadata: { browser, viewport },
  };
}

function captureEvidence(run = "run-1") {
  const artifacts = [];
  let index = 1;
  for (const browser of ["chromium", "webkit"]) {
    for (const viewport of ["mobile-390", "tablet-768", "desktop-1440"]) {
      artifacts.push(artifact("SCREENSHOT", browser, viewport, index++, run));
      artifacts.push(artifact("ACCESSIBILITY", browser, viewport, index++, run));
      artifacts.push(artifact("DESIGN_GENOME", browser, viewport, index++, run));
    }
  }
  return { requestId: `capture-${run}`, runId: run, targetUrl: "http://127.0.0.1:3000", artifacts, samples: [] };
}

function digestBoundReview(overrides: Record<string, unknown> = {}) {
  const screenshots = captureEvidence("reviewed-run").artifacts.filter((item) => item.capability === "SCREENSHOT");
  return JSON.stringify({
    schemaVersion: 3,
    projectId: "client",
    evidenceScreenshots: screenshots.map((item) => ({ browser: item.metadata.browser, viewport: item.metadata.viewport, digest: item.digest })),
    review: {
      reviewerType: "HUMAN",
      reviewerId: "reviewer-1",
      rubricVersion: "1",
      rubricDigest: `sha256:${"f".repeat(64)}`,
      verdict: "PASS",
      findings: [],
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
    capture: async () => captureEvidence("fresh-run"),
    ...overrides,
  };
}

function passingVisualJudge() {
  return vi.fn(async ({ artifacts, review }: { artifacts: readonly { artifactId: string }[]; review: { evidenceArtifactIds: readonly string[] } }) => ({
    authority: "NEXUS_VISUAL_JUDGE",
    verdict: "PASS",
    approved: true,
    integrityVerdict: "PASS",
    reviewVerdict: "PASS",
    findings: [],
    verifiedArtifactIds: artifacts.filter((item) => review.evidenceArtifactIds.includes(item.artifactId)).map((item) => item.artifactId),
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

  it("binds a configured committed visual review to exact browser/viewport screenshot bytes while remapping fresh artifact IDs", async () => {
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
    const call = visualJudge.mock.calls[0]?.[0];
    expect(call.review.evidenceArtifactIds).toHaveLength(6);
    expect(call.review.evidenceArtifactIds.every((id: string) => id.startsWith("fresh-run-SCREENSHOT-"))).toBe(true);
  });

  it("rejects a review when stable browser/viewport evidence is bound to different screenshot bytes", async () => {
    const root = "/repo";
    const base = spec(root);
    const configured = { ...base, runtime: { ...base.runtime, visualReviewFile: "evidence/client-visual-review.json" } };
    const visualJudge = passingVisualJudge();
    const parsed = JSON.parse(digestBoundReview());
    parsed.evidenceScreenshots[0].digest = `sha256:${"e".repeat(64)}`;
    const adapters = await createWorkspaceClientRuntimeAdapters(configured, options(root, { visualJudge, readReviewFile: async () => JSON.stringify(parsed) }));
    const generation = { generationDigest: `sha256:${"d".repeat(64)}` };
    const render = await adapters.render({ generation });
    const capture = await adapters.capture({ generation, render });
    const result = await adapters.visualJudge({ capture });
    expect(result.gate.verdict).toBe("FAIL");
    expect(result.gate.detail).toContain("screenshot bytes");
    expect(visualJudge).not.toHaveBeenCalled();
  });

  it("executes a fresh exact-SHA build, recapture and digest-bound rejudge before REPAIR_REJUDGE can pass", async () => {
    const root = "/repo";
    const base = spec(root);
    const configured = { ...base, runtime: { ...base.runtime, visualReviewFile: "evidence/client-visual-review.json" } };
    const visualJudge = passingVisualJudge();
    const buildImplementation = options(root).build;
    const build = vi.fn(buildImplementation);
    const captureRunner = vi.fn(async () => captureEvidence("quality-cycle-run"));
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
    const call = visualJudge.mock.calls[0]?.[0];
    expect(call.review.evidenceArtifactIds.every((id: string) => id.startsWith("quality-cycle-run-SCREENSHOT-"))).toBe(true);
  });

  it("returns NOT_TESTED instead of inventing a source repair when fresh rejudge is non-passing", async () => {
    const root = "/repo";
    const base = spec(root);
    const configured = { ...base, runtime: { ...base.runtime, visualReviewFile: "evidence/client-visual-review.json" } };
    const visualJudge = vi.fn(async ({ artifacts }: { artifacts: readonly { artifactId: string }[] }) => ({
      authority: "NEXUS_VISUAL_JUDGE",
      verdict: "FAIL",
      approved: false,
      integrityVerdict: "PASS",
      reviewVerdict: "FAIL",
      findings: ["review requires a source change"],
      verifiedArtifactIds: artifacts.filter((item) => item.artifactId.includes("SCREENSHOT-")).map((item) => item.artifactId),
    }));
    const adapters = await createWorkspaceClientRuntimeAdapters(configured, options(root, {
      visualJudge,
      readReviewFile: async () => digestBoundReview(),
      qualityCycleDependencies: { clock: () => new Date("2026-09-01T00:02:00.000Z") },
    }));
    const result = await adapters.repairRejudge({ generation: { generationDigest: `sha256:${"d".repeat(64)}` } });
    expect(result.gate.verdict).toBe("NOT_TESTED");
    expect(result.gate.detail).toContain("no governed source repair authority");
  });

  it("fails closed on legacy self-referential visual review envelopes", async () => {
    const root = "/repo";
    const base = spec(root);
    const configured = { ...base, runtime: { ...base.runtime, visualReviewFile: "evidence/client-visual-review.json" } };
    const visualJudge = vi.fn();
    const legacy = JSON.parse(digestBoundReview());
    legacy.schemaVersion = 2;
    legacy.sourceRevision = "b".repeat(40);
    legacy.evidenceArtifacts = legacy.evidenceScreenshots.map((item: { digest: string }, index: number) => ({ artifactId: `legacy-${index}`, digest: item.digest }));
    delete legacy.evidenceScreenshots;
    const adapters = await createWorkspaceClientRuntimeAdapters(configured, options(root, { visualJudge, readReviewFile: async () => JSON.stringify(legacy) }));
    const generation = { generationDigest: `sha256:${"d".repeat(64)}` };
    const render = await adapters.render({ generation });
    const capture = await adapters.capture({ generation, render });
    const result = await adapters.visualJudge({ capture });
    expect(result.gate.verdict).toBe("FAIL");
    expect(result.gate.detail).toContain("schemaVersion must be 3");
    expect(visualJudge).not.toHaveBeenCalled();
  });

  it("does not invent production adapters when runtime target is absent", async () => {
    await expect(createWorkspaceClientRuntimeAdapters({ projectId: "client", sourceRevision: SHA }, { root: "/repo" })).resolves.toEqual({});
  });
});
