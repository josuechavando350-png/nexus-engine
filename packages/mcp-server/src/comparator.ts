import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ApprovedBaseline, ComparisonReport, SceneInput } from "../../capture-visual-regression-v2/src/index.js";
import type { ToolError, ToolEvidence, ToolResult } from "./contracts.js";
import { readGitState } from "./git.js";
import { readProjects } from "./projects.js";
import { buildTarget, validateBuildManifest } from "./build.js";
import { withProjectServer } from "./project-server.js";
import { runProcess, runReadOnly } from "./process.js";
import type { ToolDependencies } from "./tools.js";

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ROUTE = 2_048;

type VisualRegressionModule = typeof import("../../capture-visual-regression-v2/src/index.js");
type VisualRegressionRuntimeModule = typeof import("../../capture-visual-regression-v2/src/runtime.js");

export interface ComparatorBaselineEnvelope {
  schemaVersion: 1;
  projectId: string;
  sourceRevision: string;
  screenshotPath: string;
  scene: {
    id: string;
    route: string;
    fullPage?: boolean;
    masks?: SceneInput["masks"];
    policy?: SceneInput["policy"];
  };
  baseline: ApprovedBaseline;
}

export interface ComparatorData {
  authority: "NEXUS_MCP_VISUAL_COMPARATOR_V2";
  target: string;
  baseline: {
    manifestPath: string;
    screenshotPath: string;
    sourceRevision: string;
    approvalReference: string;
    baselineDigest: string;
  };
  current: {
    sourceRevision: string;
    buildDigest: string;
    sceneDigest: string;
    captureDigest: string;
    screenshotSha256: string;
  };
  comparison: ComparisonReport;
}

export interface ComparatorRuntimeDependencies {
  readOnly?: typeof runReadOnly;
  build?: typeof buildTarget;
  buildValidator?: typeof validateBuildManifest;
  prepareRuntime?: (root: string) => Promise<void>;
  loadRuntime?: (root: string, sourceSha: string) => Promise<{ core: VisualRegressionModule; runtime: VisualRegressionRuntimeModule }>;
  withServer?: typeof withProjectServer;
  clock?: () => Date;
  requestId?: () => string;
  perceptualPath?: string;
}

function toolError(code: string, message: string, retryable = false): ToolError {
  return Object.freeze({ code, message, retryable });
}

function result(
  input: {
    requestId: string;
    repository: string;
    startedAt: string;
    finishedAt: string;
    branch: string | null;
    sourceSha: string | null;
    status: ToolResult<ComparatorData>["status"];
    data: ComparatorData | null;
    evidence?: readonly ToolEvidence[];
    errors?: readonly ToolError[];
  },
): ToolResult<ComparatorData> {
  return Object.freeze({
    schemaVersion: "1",
    tool: "nexus_comparator",
    requestId: input.requestId,
    status: input.status,
    repository: input.repository,
    branch: input.branch,
    sourceSha: input.sourceSha,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    data: input.data,
    evidence: Object.freeze([...(input.evidence ?? [])]),
    errors: Object.freeze([...(input.errors ?? [])]),
  });
}

function repositoryFile(root: string, relativePath: string, label: string): { absolute: string; relative: string } {
  if (typeof relativePath !== "string" || !relativePath.trim()) throw new Error(`${label} is required`);
  const absolute = resolve(root, relativePath);
  const prefix = `${resolve(root)}${sep}`;
  if (!absolute.startsWith(prefix)) throw new Error(`${label} must stay inside repository root`);
  return { absolute, relative: absolute.slice(prefix.length).split(sep).join("/") };
}

async function assertCommittedFile(root: string, sourceSha: string, file: { absolute: string; relative: string }, label: string, readOnly: typeof runReadOnly): Promise<void> {
  if (!(await stat(file.absolute).catch(() => null))?.isFile()) throw new Error(`${label} does not exist as a file`);
  if ((await readOnly("git", ["status", "--porcelain", "--", file.relative], root)).trim()) throw new Error(`${label} must be committed and clean`);
  const committedBlob = (await readOnly("git", ["rev-parse", `${sourceSha}:${file.relative}`], root)).trim();
  const workingBlob = (await readOnly("git", ["hash-object", "--", file.relative], root)).trim();
  if (!SHA1.test(committedBlob) || committedBlob !== workingBlob) throw new Error(`${label} bytes do not match the declared source revision`);
}

function normalizeRoute(value: unknown): string {
  if (typeof value !== "string") throw new Error("baseline scene route must be a string");
  const raw = value.trim();
  if (!raw || raw.length > MAX_ROUTE || !raw.startsWith("/")) throw new Error("baseline scene route must be an absolute bounded route");
  const parsed = new URL(raw, "https://nexus.invalid");
  if (parsed.origin !== "https://nexus.invalid" || parsed.username || parsed.password || parsed.hash) throw new Error("baseline scene route is invalid");
  return `${parsed.pathname}${parsed.search}`;
}

function logicalSceneUrl(projectId: string, route: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(projectId)) throw new Error("projectId cannot form a stable scene identity host");
  return `https://${projectId}.nexus.invalid${route}`;
}

function parseEnvelope(raw: string): ComparatorBaselineEnvelope {
  const parsed = JSON.parse(raw) as Partial<ComparatorBaselineEnvelope>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("comparator baseline manifest must be an object");
  if (parsed.schemaVersion !== 1) throw new Error("comparator baseline manifest schemaVersion must be 1");
  if (typeof parsed.projectId !== "string" || !parsed.projectId.trim()) throw new Error("comparator baseline projectId is required");
  if (typeof parsed.sourceRevision !== "string" || !SHA1.test(parsed.sourceRevision)) throw new Error("comparator baseline sourceRevision must be a full lowercase git SHA-1");
  if (typeof parsed.screenshotPath !== "string" || !parsed.screenshotPath.trim()) throw new Error("comparator baseline screenshotPath is required");
  if (!parsed.scene || typeof parsed.scene !== "object" || Array.isArray(parsed.scene)) throw new Error("comparator baseline scene is required");
  if (typeof parsed.scene.id !== "string" || !parsed.scene.id.trim()) throw new Error("comparator baseline scene.id is required");
  normalizeRoute(parsed.scene.route);
  if (!parsed.baseline || typeof parsed.baseline !== "object" || Array.isArray(parsed.baseline)) throw new Error("comparator ApprovedBaseline is required");
  return parsed as ComparatorBaselineEnvelope;
}

async function defaultPrepareRuntime(root: string): Promise<void> {
  await runProcess("pnpm", ["--filter", "@nexus/capture-visual-regression-v2...", "build"], {
    cwd: root,
    timeoutMs: 15 * 60_000,
    maxOutputBytes: 8 * 1024 * 1024,
  });
}

async function defaultLoadRuntime(root: string, sourceSha: string): Promise<{ core: VisualRegressionModule; runtime: VisualRegressionRuntimeModule }> {
  const coreUrl = `${pathToFileURL(join(root, "packages", "capture-visual-regression-v2", "dist", "index.js")).href}?source=${sourceSha}`;
  const runtimeUrl = `${pathToFileURL(join(root, "packages", "capture-visual-regression-v2", "dist", "runtime.js")).href}?source=${sourceSha}`;
  const [core, runtime] = await Promise.all([
    import(coreUrl) as Promise<VisualRegressionModule>,
    import(runtimeUrl) as Promise<VisualRegressionRuntimeModule>,
  ]);
  return { core, runtime };
}

export async function nexusComparatorV2(
  input: { target: string; sourceSha: string; baselineManifestPath: string },
  dependencies: ToolDependencies,
  runtimeDependencies: ComparatorRuntimeDependencies = {},
): Promise<ToolResult<ComparatorData>> {
  const now = runtimeDependencies.clock ?? dependencies.clock ?? (() => new Date());
  const startedAt = now().toISOString();
  const requestId = (runtimeDependencies.requestId ?? dependencies.requestId ?? randomUUID)();
  const repository = dependencies.repository ?? "josuechavando350-png/nexus-engine";
  let git;
  try {
    git = await (dependencies.git ?? readGitState)(dependencies.root);
  } catch (cause) {
    return result({ requestId, repository, startedAt, finishedAt: now().toISOString(), branch: null, sourceSha: null, status: "FAIL", data: null, errors: [toolError("NOT_A_GIT_REPOSITORY", cause instanceof Error ? cause.message : String(cause))] });
  }
  const baseEvidence: ToolEvidence[] = [{ kind: "git", locator: `git:${git.headSha}` }];
  if (git.headSha !== input.sourceSha) return result({ requestId, repository, startedAt, finishedAt: now().toISOString(), branch: git.branch, sourceSha: git.headSha, status: "FAIL", data: null, evidence: baseEvidence, errors: [toolError("SOURCE_SHA_MISMATCH", `requested ${input.sourceSha}, current HEAD is ${git.headSha}`)] });
  if (!git.clean) return result({ requestId, repository, startedAt, finishedAt: now().toISOString(), branch: git.branch, sourceSha: git.headSha, status: "FAIL", data: null, evidence: baseEvidence, errors: [toolError("DIRTY_WORKTREE", "visual comparison requires a clean checkout")] });

  try {
    const projects = await (dependencies.projects ?? readProjects)(dependencies.root);
    const project = projects.find((candidate) => candidate.slug === input.target);
    if (!project) return result({ requestId, repository, startedAt, finishedAt: now().toISOString(), branch: git.branch, sourceSha: git.headSha, status: "FAIL", data: null, evidence: baseEvidence, errors: [toolError("TARGET_NOT_FOUND", `unknown target ${input.target}`)] });
    if (!project.workspaceMember) return result({ requestId, repository, startedAt, finishedAt: now().toISOString(), branch: git.branch, sourceSha: git.headSha, status: "FAIL", data: null, evidence: baseEvidence, errors: [toolError("TARGET_NOT_WORKSPACE_MEMBER", `target ${input.target} is not a workspace member`)] });

    const readOnly = runtimeDependencies.readOnly ?? runReadOnly;
    const manifestFile = repositoryFile(dependencies.root, input.baselineManifestPath, "baseline manifest");
    await assertCommittedFile(dependencies.root, input.sourceSha, manifestFile, "baseline manifest", readOnly);
    const envelope = parseEnvelope(await readFile(manifestFile.absolute, "utf8"));
    if (envelope.projectId !== project.slug) throw new Error(`baseline projectId ${envelope.projectId} does not match target ${project.slug}`);
    const screenshotFile = repositoryFile(dependencies.root, envelope.screenshotPath, "baseline screenshot");
    await assertCommittedFile(dependencies.root, input.sourceSha, screenshotFile, "baseline screenshot", readOnly);
    await assertCommittedFile(dependencies.root, envelope.sourceRevision, screenshotFile, "baseline screenshot at approved sourceRevision", readOnly);

    const perceptualPath = (runtimeDependencies.perceptualPath ?? process.env.NEXUS_SSIMULACRA2_PATH ?? "").trim();
    if (!perceptualPath) return result({ requestId, repository, startedAt, finishedAt: now().toISOString(), branch: git.branch, sourceSha: git.headSha, status: "NOT_TESTED", data: null, evidence: [...baseEvidence, { kind: "file", locator: manifestFile.relative }, { kind: "file", locator: screenshotFile.relative }], errors: [toolError("PERCEPTUAL_COMPARATOR_UNAVAILABLE", "NEXUS_SSIMULACRA2_PATH is not configured", true)] });

    await (runtimeDependencies.prepareRuntime ?? defaultPrepareRuntime)(dependencies.root);
    const { core, runtime } = await (runtimeDependencies.loadRuntime ?? defaultLoadRuntime)(dependencies.root, input.sourceSha);
    core.validateBaseline(envelope.baseline);
    const route = normalizeRoute(envelope.scene.route);
    const scene = core.createScene({
      id: envelope.scene.id,
      url: logicalSceneUrl(project.slug, route),
      ...(envelope.scene.fullPage === undefined ? {} : { fullPage: envelope.scene.fullPage }),
      ...(envelope.scene.masks === undefined ? {} : { masks: envelope.scene.masks }),
      ...(envelope.scene.policy === undefined ? {} : { policy: envelope.scene.policy }),
    });
    if (scene.digest !== envelope.baseline.sceneDigest) throw new Error("baseline scene definition does not reproduce the approved scene digest");
    if (envelope.baseline.environment.browserName !== "chromium" && envelope.baseline.environment.browserName !== "webkit") throw new Error("baseline browser is unsupported");
    const viewport = core.createViewport(envelope.baseline.viewport.name, envelope.baseline.viewport.width, envelope.baseline.viewport.height);

    const buildRunner = runtimeDependencies.build ?? dependencies.buildRunner ?? buildTarget;
    const buildValidator = runtimeDependencies.buildValidator ?? dependencies.buildValidator ?? validateBuildManifest;
    const build = await buildRunner(dependencies.root, project, input.sourceSha, `${requestId}-build`, dependencies.limits?.executionTimeoutMs, dependencies.limits?.maxProcessOutputBytes);
    if (!build.manifest) {
      const status = build.unavailableReason ? "NOT_TESTED" : "FAIL";
      return result({ requestId, repository, startedAt, finishedAt: now().toISOString(), branch: git.branch, sourceSha: git.headSha, status, data: null, evidence: baseEvidence, errors: [toolError(build.unavailableReason ? "BUILD_UNAVAILABLE" : "BUILD_FAILED", build.unavailableReason ?? `build exited ${build.exitCode}`, Boolean(build.unavailableReason))] });
    }
    if (!(await buildValidator(dependencies.root, project, input.sourceSha, build.manifest))) throw new Error("comparator current build manifest failed exact-SHA validation");

    const outDir = join(tmpdir(), "nexus-mcp-comparator", requestId);
    await mkdir(outDir, { recursive: true });
    const withServer = runtimeDependencies.withServer ?? withProjectServer;
    const current = await withServer(dependencies.root, project, async (targetUrl) => {
      const navigation = new URL(route, `${targetUrl}/`).toString();
      return await runtime.captureSceneAtNavigationUrl({
        scene,
        navigationUrl: navigation,
        browserName: envelope.baseline.environment.browserName,
        viewport,
        revision: input.sourceSha,
        buildDigest: build.manifest!.outputDigest,
        outDir: join(outDir, "current"),
      });
    });

    const perceptual = core.createSsimulacra2Comparator(perceptualPath);
    const comparison = await core.compareCapture({
      baseline: envelope.baseline,
      baselinePath: screenshotFile.absolute,
      current,
      policy: scene.policy,
      perceptual,
      outDir: join(outDir, "diff"),
    });
    core.validateComparison(comparison);
    const reportPath = join(outDir, "comparison.json");
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(comparison, null, 2)}\n`, "utf8");

    const evidence: ToolEvidence[] = [...baseEvidence, { kind: "file", locator: manifestFile.relative }, { kind: "file", locator: screenshotFile.relative }, { kind: "artifact", locator: `sha256:${build.manifest.manifestSha256}` }, { kind: "capture", locator: `${current.path}#sha256=${current.record.screenshotSha256}` }, { kind: "artifact", locator: `${reportPath}#sha256=${comparison.digest}` }];
    if (comparison.diffPath && comparison.diffSha256) evidence.push({ kind: "capture", locator: `${comparison.diffPath}#sha256=${comparison.diffSha256}` });
    if (dependencies.artifactStore) {
      const currentArtifact = await dependencies.artifactStore.putFile(requestId, "comparator-current.png", current.path, "image/png", { tool: "nexus_comparator", target: project.slug, sourceSha: input.sourceSha, sceneDigest: scene.digest });
      const reportArtifact = await dependencies.artifactStore.putFile(requestId, "comparator-report.json", reportPath, "application/json", { tool: "nexus_comparator", target: project.slug, verdict: comparison.verdict, baselineDigest: envelope.baseline.digest, captureDigest: current.record.digest });
      evidence.push({ kind: "artifact", locator: `${currentArtifact.url}#sha256=${currentArtifact.sha256}` }, { kind: "artifact", locator: `${reportArtifact.url}#sha256=${reportArtifact.sha256}` });
      if (comparison.diffPath && comparison.diffSha256) {
        const diffArtifact = await dependencies.artifactStore.putFile(requestId, "comparator-diff.png", comparison.diffPath, "image/png", { tool: "nexus_comparator", target: project.slug, verdict: comparison.verdict });
        evidence.push({ kind: "artifact", locator: `${diffArtifact.url}#sha256=${diffArtifact.sha256}` });
      }
    }

    const data: ComparatorData = Object.freeze({
      authority: "NEXUS_MCP_VISUAL_COMPARATOR_V2",
      target: project.slug,
      baseline: Object.freeze({ manifestPath: manifestFile.relative, screenshotPath: screenshotFile.relative, sourceRevision: envelope.sourceRevision, approvalReference: envelope.baseline.approvalReference, baselineDigest: envelope.baseline.digest }),
      current: Object.freeze({ sourceRevision: input.sourceSha, buildDigest: build.manifest.outputDigest, sceneDigest: current.record.sceneDigest, captureDigest: current.record.digest, screenshotSha256: current.record.screenshotSha256 }),
      comparison,
    });
    if (comparison.verdict === "PASS") return result({ requestId, repository, startedAt, finishedAt: now().toISOString(), branch: git.branch, sourceSha: git.headSha, status: "PASS", data, evidence });
    if (comparison.verdict === "INCOMPATIBLE_BASELINE") return result({ requestId, repository, startedAt, finishedAt: now().toISOString(), branch: git.branch, sourceSha: git.headSha, status: "NOT_TESTED", data, evidence, errors: [toolError("INCOMPATIBLE_BASELINE", comparison.reasons.join(", "))] });
    return result({ requestId, repository, startedAt, finishedAt: now().toISOString(), branch: git.branch, sourceSha: git.headSha, status: "FAIL", data, evidence, errors: [toolError("VISUAL_REGRESSION", comparison.reasons.join(", "))] });
  } catch (cause) {
    return result({ requestId, repository, startedAt, finishedAt: now().toISOString(), branch: git.branch, sourceSha: git.headSha, status: "FAIL", data: null, evidence: baseEvidence, errors: [toolError("COMPARATOR_FAILED", cause instanceof Error ? cause.message : String(cause))] });
  }
}
