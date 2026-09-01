import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { GitState, ProjectState, PullRequestState, ToolError, ToolEvidence, ToolResult } from "./contracts.js";
import { readGitState } from "./git.js";
import { readOpenPullRequests } from "./github.js";
import { readProjects } from "./projects.js";

export interface ToolDependencies {
  root: string;
  repository?: string;
  githubToken?: string;
  clock?: () => Date;
  requestId?: () => string;
  git?: (root: string) => Promise<GitState>;
  projects?: (root: string) => Promise<readonly ProjectState[]>;
  pullRequests?: typeof readOpenPullRequests;
  gateRunner?: typeof import("./gates.js").runGate;
  passportReader?: typeof import("./passport.js").readPassport;
  captureRunner?: typeof import("./capture.js").captureTarget;
  artifactRoot?: string;
  buildRunner?: typeof import("./build.js").buildTarget;
  buildValidator?: typeof import("./build.js").validateBuildManifest;
  projectCreator?: typeof import("./project-new.js").createProject;
  artifactStore?: import("./artifacts.js").ArtifactStore;
  limits?: import("./policy.js").RuntimeLimits;
}

function error(code: string, value: unknown, retryable = false): ToolError {
  return Object.freeze({ code, message: value instanceof Error ? value.message : String(value), retryable });
}

function base<T>(tool: ToolResult<T>["tool"], startedAt: string, finishedAt: string, requestId: string, repository: string, git: GitState | null, status: ToolResult<T>["status"], data: T | null, evidence: ToolEvidence[], errors: ToolError[]): ToolResult<T> {
  return Object.freeze({ schemaVersion: "1", tool, requestId, status, repository, branch: git?.branch ?? null, sourceSha: git?.headSha ?? null, startedAt, finishedAt, data, evidence: Object.freeze(evidence), errors: Object.freeze(errors) });
}

export async function nexusStatus(input: { includePullRequests?: boolean } = {}, dependencies: ToolDependencies): Promise<ToolResult<{ git: GitState; pullRequests: readonly PullRequestState[] }>> {
  const now = dependencies.clock ?? (() => new Date());
  const startedAt = now().toISOString();
  const requestId = (dependencies.requestId ?? randomUUID)();
  const repository = dependencies.repository ?? "josuechavando350-png/nexus-engine";
  let git: GitState;
  try {
    git = await (dependencies.git ?? readGitState)(dependencies.root);
  } catch (cause) {
    return base<{ git: GitState; pullRequests: readonly PullRequestState[] }>("nexus_status", startedAt, now().toISOString(), requestId, repository, null, "FAIL", null, [], [error("NOT_A_GIT_REPOSITORY", cause)]);
  }
  const evidence: ToolEvidence[] = [{ kind: "git", locator: `git:${git.headSha}` }];
  let pullRequests: readonly PullRequestState[] = [];
  const errors: ToolError[] = [];
  let status: ToolResult<unknown>["status"] = "PASS";
  if (input.includePullRequests !== false) {
    if (!dependencies.githubToken) {
      status = "NOT_TESTED";
      errors.push(error("GITHUB_AUTH_FAILED", "NEXUS_GITHUB_TOKEN is not configured"));
    } else {
      try {
        pullRequests = await (dependencies.pullRequests ?? readOpenPullRequests)({ repository, token: dependencies.githubToken });
        evidence.push({ kind: "github", locator: `https://api.github.com/repos/${repository}/pulls?state=open` });
      } catch (cause) {
        status = "NOT_TESTED";
        errors.push(error("GITHUB_UNAVAILABLE", cause, true));
      }
    }
  }
  return base("nexus_status", startedAt, now().toISOString(), requestId, repository, git, status, { git, pullRequests }, evidence, errors);
}

export async function nexusProjects(input: { includeArchived?: boolean } = {}, dependencies: ToolDependencies): Promise<ToolResult<{ projects: readonly ProjectState[] }>> {
  void input;
  const now = dependencies.clock ?? (() => new Date());
  const startedAt = now().toISOString();
  const requestId = (dependencies.requestId ?? randomUUID)();
  const repository = dependencies.repository ?? "josuechavando350-png/nexus-engine";
  let git: GitState;
  try {
    git = await (dependencies.git ?? readGitState)(dependencies.root);
  } catch (cause) {
    return base<{ projects: readonly ProjectState[] }>("nexus_projects", startedAt, now().toISOString(), requestId, repository, null, "FAIL", null, [], [error("NOT_A_GIT_REPOSITORY", cause)]);
  }
  try {
    const projects = await (dependencies.projects ?? readProjects)(dependencies.root);
    return base("nexus_projects", startedAt, now().toISOString(), requestId, repository, git, "PASS", { projects }, [
      { kind: "git", locator: `git:${git.headSha}` },
      { kind: "command", locator: "node scripts/list-workspace-apps.mjs", exitCode: 0 },
      ...projects.map((project) => ({ kind: "file" as const, locator: project.evidence.packageJsonPath })),
    ], []);
  } catch (cause) {
    return base<{ projects: readonly ProjectState[] }>("nexus_projects", startedAt, now().toISOString(), requestId, repository, git, "FAIL", null, [{ kind: "git", locator: `git:${git.headSha}` }], [error("PROJECT_MANIFEST_INVALID", cause)]);
  }
}

export async function nexusProjectNew(input: import("./project-new.js").ProjectSpec, dependencies: ToolDependencies): Promise<ToolResult<import("./project-new.js").ProjectCreation>> {
  const { createProject } = await import("./project-new.js");
  const now = dependencies.clock ?? (() => new Date()); const startedAt = now().toISOString(); const requestId = (dependencies.requestId ?? randomUUID)(); const repository = dependencies.repository ?? "josuechavando350-png/nexus-engine";
  let git: GitState;
  try { git = await (dependencies.git ?? readGitState)(dependencies.root); } catch (cause) { return base<import("./project-new.js").ProjectCreation>("nexus_project_new", startedAt, now().toISOString(), requestId, repository, null, "FAIL", null, [], [error("NOT_A_GIT_REPOSITORY", cause)]); }
  const branchName = input.branchName ?? `nexus-mcp/${input.slug}`;
  if (input.baseSha !== git.headSha) return base<import("./project-new.js").ProjectCreation>("nexus_project_new", startedAt, now().toISOString(), requestId, repository, git, "FAIL", null, [{ kind: "git", locator: `git:${git.headSha}` }], [error("SOURCE_SHA_MISMATCH", `requested ${input.baseSha}, current HEAD is ${git.headSha}`)]);
  if (!git.clean) return base<import("./project-new.js").ProjectCreation>("nexus_project_new", startedAt, now().toISOString(), requestId, repository, git, "FAIL", null, [{ kind: "git", locator: `git:${git.headSha}` }], [error("DIRTY_WORKTREE", "project creation requires a clean checkout")]);
  if (!branchName.startsWith("nexus-mcp/")) return base<import("./project-new.js").ProjectCreation>("nexus_project_new", startedAt, now().toISOString(), requestId, repository, git, "FAIL", null, [{ kind: "git", locator: `git:${git.headSha}` }], [error("BRANCH_POLICY_DENIED", "branchName must start with nexus-mcp/")]);
  const projects = await (dependencies.projects ?? readProjects)(dependencies.root);
  if (projects.some((project) => project.slug === input.slug)) return base<import("./project-new.js").ProjectCreation>("nexus_project_new", startedAt, now().toISOString(), requestId, repository, git, "FAIL", null, [{ kind: "git", locator: `git:${git.headSha}` }], [error("TARGET_EXISTS", `apps/${input.slug} already exists`)]);
  try {
    const data = await (dependencies.projectCreator ?? createProject)(dependencies.root, input, dependencies.limits?.executionTimeoutMs, dependencies.limits?.maxProcessOutputBytes);
    return base<import("./project-new.js").ProjectCreation>("nexus_project_new", startedAt, now().toISOString(), requestId, repository, { ...git, branch: data.branch.name, headSha: data.branch.headSha, clean: true, changedPaths: [] }, "PASS", data, [
      { kind: "git", locator: `git:${data.branch.baseSha}` }, { kind: "git", locator: `git:${data.branch.headSha}` },
      ...data.files.map((locator) => ({ kind: "file" as const, locator })), ...data.validation.map((item) => ({ kind: "command" as const, locator: item.command, exitCode: item.exitCode })),
    ], []);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const unavailable = /DEPENDENCY_UNAVAILABLE|ENOENT|not found|command not found|node_modules missing|Cannot find module ['"]next/i.test(message);
    return base<import("./project-new.js").ProjectCreation>("nexus_project_new", startedAt, now().toISOString(), requestId, repository, await (dependencies.git ?? readGitState)(dependencies.root).catch(() => git), unavailable ? "NOT_TESTED" : "FAIL", null, [{ kind: "git", locator: `git:${git.headSha}` }], [error(unavailable ? "DEPENDENCIES_UNAVAILABLE" : "PROJECT_CREATION_FAILED", cause, unavailable)]);
  }
}

export interface GatesData { gates: readonly import("./gates.js").GateResult[]; counts: { pass: number; fail: number; notTested: number } }
export interface PassportData { found: boolean; path: string | null; passport: import("@nexus/quality/quality-passport").QualityPassport | null; integrity: { status: import("./contracts.js").ExecutionStatus; algorithm: "sha256"; declaredHash: string | null; computedHash: string | null; sourceShaMatches: boolean | null }; checks: readonly { id: string; status: import("./contracts.js").ExecutionStatus; detail: string; evidenceIds: readonly string[] }[] }

export async function nexusGates(input: { target?: string; sourceSha: string; gates?: readonly import("./gates.js").GateId[] }, dependencies: ToolDependencies): Promise<ToolResult<GatesData>> {
  const { runGate, runBuildGate } = await import("./gates.js");
  const now = dependencies.clock ?? (() => new Date()); const startedAt = now().toISOString(); const requestId = (dependencies.requestId ?? randomUUID)(); const repository = dependencies.repository ?? "josuechavando350-png/nexus-engine";
  let git: GitState;
  try { git = await (dependencies.git ?? readGitState)(dependencies.root); } catch (cause) { return base<GatesData>("nexus_gates", startedAt, now().toISOString(), requestId, repository, null, "FAIL", null, [], [error("NOT_A_GIT_REPOSITORY", cause)]); }
  if (git.headSha !== input.sourceSha) return base<GatesData>("nexus_gates", startedAt, now().toISOString(), requestId, repository, git, "FAIL", null, [{ kind: "git", locator: `git:${git.headSha}` }], [error("SOURCE_SHA_MISMATCH", `requested ${input.sourceSha}, current HEAD is ${git.headSha}`)]);
  if (!git.clean) return base<GatesData>("nexus_gates", startedAt, now().toISOString(), requestId, repository, git, "FAIL", null, [{ kind: "git", locator: `git:${git.headSha}` }], [error("DIRTY_WORKTREE", "quality gates require a clean checkout")]);
  const requested = input.gates ?? ["lint", "typecheck", "test", "build", "quality-gates"];
  const projects = await (dependencies.projects ?? readProjects)(dependencies.root);
  const project = input.target ? projects.find((candidate) => candidate.slug === input.target) : undefined;
  if (input.target && !project) return base<GatesData>("nexus_gates", startedAt, now().toISOString(), requestId, repository, git, "FAIL", null, [{ kind: "git", locator: `git:${git.headSha}` }], [error("TARGET_NOT_FOUND", `unknown target ${input.target}`)]);
  if (requested.includes("build") && !project) return base<GatesData>("nexus_gates", startedAt, now().toISOString(), requestId, repository, git, "FAIL", null, [{ kind: "git", locator: `git:${git.headSha}` }], [error("TARGET_REQUIRED", "the SHA-bound build gate requires a target")]);
  const results = [];
  for (const gate of requested) {
    if (gate === "build") results.push(await runBuildGate(dependencies.root, project!, git.headSha, requestId, dependencies.limits?.executionTimeoutMs, dependencies.limits?.maxProcessOutputBytes, dependencies.buildRunner, dependencies.buildValidator));
    else results.push(await (dependencies.gateRunner ?? runGate)(dependencies.root, gate, requestId, dependencies.limits?.executionTimeoutMs, dependencies.limits?.maxProcessOutputBytes));
  }
  if (dependencies.artifactStore) for (const item of results) if (item.logPath) {
    const artifact = await dependencies.artifactStore.putFile(requestId, `gate-${item.id}.log`, item.logPath, "text/plain", { tool: "nexus_gates", gate: item.id, status: item.status, exitCode: item.exitCode });
    item.artifact = artifact;
  }
  const counts = { pass: results.filter((item) => item.status === "PASS").length, fail: results.filter((item) => item.status === "FAIL").length, notTested: results.filter((item) => item.status === "NOT_TESTED").length };
  const status = counts.fail ? "FAIL" : counts.notTested ? "NOT_TESTED" : "PASS";
  const gateEvidence: ToolEvidence[] = [];
  for (const item of results) {
    if (item.artifact) gateEvidence.push({ kind: "artifact", locator: `${item.artifact.url}#sha256=${item.artifact.sha256}` });
    else gateEvidence.push(...item.evidencePaths.map((locator) => ({ kind: "command" as const, locator, exitCode: item.exitCode ?? undefined })));
  }
  return base<GatesData>("nexus_gates", startedAt, now().toISOString(), requestId, repository, git, status, { gates: results, counts }, [{ kind: "git", locator: `git:${git.headSha}` }, ...gateEvidence], []);
}

export async function nexusPassport(input: { target: string; sourceSha: string; passportPath?: string }, dependencies: ToolDependencies): Promise<ToolResult<PassportData>> {
  const { readPassport } = await import("./passport.js");
  const now = dependencies.clock ?? (() => new Date()); const startedAt = now().toISOString(); const requestId = (dependencies.requestId ?? randomUUID)(); const repository = dependencies.repository ?? "josuechavando350-png/nexus-engine";
  let git: GitState;
  try { git = await (dependencies.git ?? readGitState)(dependencies.root); } catch (cause) { return base<PassportData>("nexus_passport", startedAt, now().toISOString(), requestId, repository, null, "FAIL", null, [], [error("NOT_A_GIT_REPOSITORY", cause)]); }
  if (git.headSha !== input.sourceSha) return base<PassportData>("nexus_passport", startedAt, now().toISOString(), requestId, repository, git, "FAIL", null, [{ kind: "git", locator: `git:${git.headSha}` }], [error("PASSPORT_SOURCE_MISMATCH", `requested ${input.sourceSha}, current HEAD is ${git.headSha}`)]);
  const projects = await (dependencies.projects ?? readProjects)(dependencies.root);
  if (!projects.some((project) => project.slug === input.target)) return base<PassportData>("nexus_passport", startedAt, now().toISOString(), requestId, repository, git, "FAIL", null, [{ kind: "git", locator: `git:${git.headSha}` }], [error("TARGET_NOT_FOUND", `unknown target ${input.target}`)]);
  try {
    const found = await (dependencies.passportReader ?? readPassport)(dependencies.root, input.target, input.passportPath);
    if (!found) return base<PassportData>("nexus_passport", startedAt, now().toISOString(), requestId, repository, git, "NOT_TESTED", { found: false, path: null, passport: null, integrity: { status: "NOT_TESTED", algorithm: "sha256", declaredHash: null, computedHash: null, sourceShaMatches: null }, checks: [] }, [{ kind: "git", locator: `git:${git.headSha}` }], [error("PASSPORT_NOT_FOUND", `no Quality Passport exists for ${input.target}`)]);
    const sourceShaMatches = found.passport.sourceRevision === input.sourceSha;
    const data: PassportData = { found: true, path: found.path, passport: found.passport, integrity: { status: sourceShaMatches ? "PASS" : "FAIL", algorithm: "sha256", declaredHash: found.passport.passportHash, computedHash: found.computedHash, sourceShaMatches }, checks: found.passport.checks.map((check) => ({ id: check.id, status: check.status === "PASS" ? "PASS" : check.status === "FAIL" ? "FAIL" : "NOT_TESTED", detail: check.detail, evidenceIds: check.evidenceIds })) };
    return base<PassportData>("nexus_passport", startedAt, now().toISOString(), requestId, repository, git, sourceShaMatches ? "PASS" : "FAIL", data, [{ kind: "git", locator: `git:${git.headSha}` }, { kind: "file", locator: found.path }, { kind: "artifact", locator: `sha256:${found.fileSha256}` }], sourceShaMatches ? [] : [error("PASSPORT_SOURCE_MISMATCH", "Passport sourceRevision does not match requested SHA")]);
  } catch (cause) { return base<PassportData>("nexus_passport", startedAt, now().toISOString(), requestId, repository, git, "FAIL", null, [{ kind: "git", locator: `git:${git.headSha}` }], [error(String(cause).includes("path must") ? "PASSPORT_PATH_DENIED" : "PASSPORT_INTEGRITY_FAILED", cause)]); }
}

export async function nexusCapture(input: import("./capture.js").CaptureInput, dependencies: ToolDependencies): Promise<ToolResult<import("./capture.js").CaptureOutput>> {
  const { captureTarget } = await import("./capture.js");
  const now = dependencies.clock ?? (() => new Date()); const startedAt = now().toISOString(); const requestId = (dependencies.requestId ?? randomUUID)(); const repository = dependencies.repository ?? "josuechavando350-png/nexus-engine";
  let git: GitState;
  try { git = await (dependencies.git ?? readGitState)(dependencies.root); } catch (cause) { return base<import("./capture.js").CaptureOutput>("nexus_capture", startedAt, now().toISOString(), requestId, repository, null, "FAIL", null, [], [error("NOT_A_GIT_REPOSITORY", cause)]); }
  if ("url" in input.source) return base<import("./capture.js").CaptureOutput>("nexus_capture", startedAt, now().toISOString(), requestId, repository, git, "NOT_TESTED", null, [{ kind: "git", locator: `git:${git.headSha}` }], [error("REMOTE_URL_CAPTURE_POLICY_UNAVAILABLE", "remote URL capture is disabled until redirect and subresource SSRF confinement is available")]);
  if (input.sourceSha !== git.headSha) return base<import("./capture.js").CaptureOutput>("nexus_capture", startedAt, now().toISOString(), requestId, repository, git, "FAIL", null, [{ kind: "git", locator: `git:${git.headSha}` }], [error("SOURCE_SHA_MISMATCH", `requested ${input.sourceSha ?? "missing"}, current HEAD is ${git.headSha}`)]);
  const target = "target" in input.source ? input.source.target : "";
  const projects = await (dependencies.projects ?? readProjects)(dependencies.root); const project = projects.find((item) => item.slug === target);
  if (!project) return base<import("./capture.js").CaptureOutput>("nexus_capture", startedAt, now().toISOString(), requestId, repository, git, "FAIL", null, [{ kind: "git", locator: `git:${git.headSha}` }], [error("TARGET_NOT_FOUND", `unknown target ${target}`)]);
  try {
    let data = await (dependencies.captureRunner ?? captureTarget)(dependencies.root, project, git.headSha, requestId, dependencies.artifactRoot ?? join(dependencies.root, ".artifacts", "mcp"), input.viewports);
    if (dependencies.artifactStore) data = { captures: await Promise.all(data.captures.map(async (capture) => {
      const artifact = await dependencies.artifactStore!.putFile(requestId, capture.artifact.url.split("/").at(-1) ?? `${capture.viewport}.png`, capture.artifact.path.startsWith("/") ? capture.artifact.path : join(dependencies.root, capture.artifact.path), capture.artifact.mediaType, { tool: "nexus_capture", viewport: capture.viewport, width: capture.width, height: capture.height, sourceSha: git.headSha });
      return { ...capture, artifact: { ...capture.artifact, path: artifact.path, url: artifact.url, byteLength: artifact.byteLength, sha256: artifact.sha256 } };
    })) };
    return base<import("./capture.js").CaptureOutput>("nexus_capture", startedAt, now().toISOString(), requestId, repository, git, "PASS", data, [{ kind: "git", locator: `git:${git.headSha}` }, ...data.captures.map((capture) => ({ kind: "capture" as const, locator: capture.artifact.url }))], []);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause); const unavailable = /browser.*(not found|executable)|pnpm is unavailable/i.test(message);
    return base<import("./capture.js").CaptureOutput>("nexus_capture", startedAt, now().toISOString(), requestId, repository, git, unavailable ? "NOT_TESTED" : "FAIL", null, [{ kind: "git", locator: `git:${git.headSha}` }], [error(unavailable ? "BROWSER_UNAVAILABLE" : "CAPTURE_FAILED", cause, unavailable)]);
  }
}

export async function nexusBuild(input: { target: string; sourceSha: string; clean?: boolean }, dependencies: ToolDependencies): Promise<ToolResult<import("./build.js").BuildExecution>> {
  const { buildTarget, validateBuildManifest } = await import("./build.js");
  const now = dependencies.clock ?? (() => new Date()); const startedAt = now().toISOString(); const requestId = (dependencies.requestId ?? randomUUID)(); const repository = dependencies.repository ?? "josuechavando350-png/nexus-engine";
  let git: GitState;
  try { git = await (dependencies.git ?? readGitState)(dependencies.root); } catch (cause) { return base<import("./build.js").BuildExecution>("nexus_build", startedAt, now().toISOString(), requestId, repository, null, "FAIL", null, [], [error("NOT_A_GIT_REPOSITORY", cause)]); }
  if (git.headSha !== input.sourceSha) return base<import("./build.js").BuildExecution>("nexus_build", startedAt, now().toISOString(), requestId, repository, git, "FAIL", null, [{ kind: "git", locator: `git:${git.headSha}` }], [error("SOURCE_SHA_MISMATCH", `requested ${input.sourceSha}, current HEAD is ${git.headSha}`)]);
  if (!git.clean) return base<import("./build.js").BuildExecution>("nexus_build", startedAt, now().toISOString(), requestId, repository, git, "FAIL", null, [{ kind: "git", locator: `git:${git.headSha}` }], [error("DIRTY_WORKTREE", "build requires a clean checkout")]);
  const projects = await (dependencies.projects ?? readProjects)(dependencies.root); const project = projects.find((item) => item.slug === input.target);
  if (!project) return base<import("./build.js").BuildExecution>("nexus_build", startedAt, now().toISOString(), requestId, repository, git, "FAIL", null, [{ kind: "git", locator: `git:${git.headSha}` }], [error("TARGET_NOT_FOUND", `unknown target ${input.target}`)]);
  const execution = await (dependencies.buildRunner ?? buildTarget)(dependencies.root, project, git.headSha, requestId, dependencies.limits?.executionTimeoutMs, dependencies.limits?.maxProcessOutputBytes);
  if (dependencies.artifactStore) {
    execution.logArtifact = await dependencies.artifactStore.putFile(requestId, "build.log", execution.logPath, "text/plain", { tool: "nexus_build", target: project.slug, exitCode: execution.exitCode, sourceSha: git.headSha });
    if (execution.manifestPath) execution.manifestArtifact = await dependencies.artifactStore.putFile(requestId, "build-manifest.json", execution.manifestPath, "application/json", { tool: "nexus_build", target: project.slug, sourceSha: git.headSha });
  }
  const evidence: ToolEvidence[] = [{ kind: "git", locator: `git:${git.headSha}` }, execution.logArtifact ? { kind: "artifact", locator: `${execution.logArtifact.url}#sha256=${execution.logArtifact.sha256}` } : { kind: "command", locator: execution.logPath, ...(execution.exitCode === null ? {} : { exitCode: execution.exitCode }) }];
  if (execution.manifestArtifact) evidence.push({ kind: "artifact", locator: `${execution.manifestArtifact.url}#sha256=${execution.manifestArtifact.sha256}` });
  if (execution.unavailableReason) return base<import("./build.js").BuildExecution>("nexus_build", startedAt, now().toISOString(), requestId, repository, git, "NOT_TESTED", execution, evidence, [error(execution.unavailableReason.includes("exceeded") ? "BUILD_TIMEOUT" : "DEPENDENCIES_UNAVAILABLE", execution.unavailableReason, true)]);
  if (execution.exitCode !== 0) return base<import("./build.js").BuildExecution>("nexus_build", startedAt, now().toISOString(), requestId, repository, git, "FAIL", execution, evidence, [error("BUILD_FAILED", `build exited ${execution.exitCode}`)]);
  if (!execution.manifest || !await (dependencies.buildValidator ?? validateBuildManifest)(dependencies.root, project, git.headSha, execution.manifest)) return base<import("./build.js").BuildExecution>("nexus_build", startedAt, now().toISOString(), requestId, repository, git, "FAIL", execution, evidence, [error("ARTIFACT_ENUMERATION_FAILED", "build manifest is missing or invalid")]);
  evidence.push({ kind: "artifact", locator: `sha256:${execution.manifest.manifestSha256}` }, ...execution.manifest.files.map((file) => ({ kind: "artifact" as const, locator: `${file.path}#sha256=${file.sha256}` })));
  return base<import("./build.js").BuildExecution>("nexus_build", startedAt, now().toISOString(), requestId, repository, git, "PASS", execution, evidence, []);
}
