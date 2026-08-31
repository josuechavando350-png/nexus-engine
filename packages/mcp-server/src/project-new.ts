import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectState } from "./contracts.js";
import { readProjects } from "./projects.js";
import { runProcess } from "./process.js";

const CLIENT_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const RESERVED_CLIENT_PREFIXES = ["_", "reference-", "v2-probe-", "probe-", "test-"] as const;
const MAX_MANIFEST_PATH_LENGTH = 512;

export interface ProjectSpec {
  slug: string;
  business: { name: string; industry: string; location: string; contact: { phone?: string; email?: string; website?: string; address?: string }; confirmedServices: readonly { name: string; description?: string }[] };
  artDirection: { palette: readonly { hex: string; role: string; rationale: string }[]; typography: { display: string; body: string; rationale: string }; heroComposition: { direction: string; rationale: string }; sectionRhythm: { direction: string; rationale: string }; motion: { direction: string; reducedMotionBehavior: string; rationale: string }; prohibitions: readonly string[] };
  baseSha: string;
  branchName?: string;
  commitMessage?: string;
}

export interface ProjectCreation {
  project: ProjectState;
  branch: { name: string; baseSha: string; headSha: string; remoteUrl: string | null };
  commit: { sha: string; message: string };
  files: readonly string[];
  validation: readonly { command: string; exitCode: number; status: "PASS" }[];
}

interface ScaffoldManifest {
  files: readonly { path: string; sha256: string }[];
}

async function command(root: string, executable: string, args: readonly string[], timeout = 120_000, maxOutputBytes = 8 * 1024 * 1024): Promise<string> {
  const result = await runProcess(executable, args, { cwd: root, timeoutMs: timeout, maxOutputBytes });
  return result.stdout.toString("utf8").trim();
}

async function gitPaths(root: string, args: readonly string[]): Promise<readonly string[]> {
  const result = await runProcess("git", args, { cwd: root, timeoutMs: 120_000, maxOutputBytes: 8 * 1024 * 1024 });
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

function assertSafeClientSlug(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 80 || !CLIENT_SLUG_RE.test(value) || value.includes("--") || RESERVED_CLIENT_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    throw new Error("slug uses a reserved or invalid client-project name");
  }
  return value;
}

function assertSafeManifestPath(value: string): readonly string[] {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_MANIFEST_PATH_LENGTH || value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
    throw new Error("ROLLBACK_SCOPE_CONFLICT: scaffold manifest contains an unsafe path");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error("ROLLBACK_SCOPE_CONFLICT: scaffold manifest contains an unsafe path");
  }
  return segments;
}

async function readRegularFile(path: string, label: string): Promise<string> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`ROLLBACK_SCOPE_CONFLICT: ${label} is not a regular file`);
  return await readFile(path, "utf8");
}

async function readScaffoldFile(root: string, projectPath: string, relativePath: string): Promise<string> {
  const segments = assertSafeManifestPath(relativePath);
  let current = join(root, projectPath);
  const projectStats = await lstat(current);
  if (projectStats.isSymbolicLink() || !projectStats.isDirectory()) throw new Error("ROLLBACK_SCOPE_CONFLICT: generated project root is not a real directory");
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) throw new Error(`ROLLBACK_SCOPE_CONFLICT: generated path became a symbolic link: ${relativePath}`);
    if (index < segments.length - 1 && !stats.isDirectory()) throw new Error(`ROLLBACK_SCOPE_CONFLICT: generated path parent is not a directory: ${relativePath}`);
    if (index === segments.length - 1 && !stats.isFile()) throw new Error(`ROLLBACK_SCOPE_CONFLICT: generated path is not a regular file: ${relativePath}`);
  }
  return await readFile(current, "utf8");
}

async function assertScaffoldSourcesUnchanged(root: string, projectPath: string, expectedManifest: string): Promise<void> {
  const manifestText = await readScaffoldFile(root, projectPath, ".nexus/scaffold-manifest.json");
  if (manifestText !== expectedManifest) throw new Error("ROLLBACK_SCOPE_CONFLICT: scaffold manifest changed after publication");
  const manifest = JSON.parse(manifestText) as ScaffoldManifest;
  if (!Array.isArray(manifest.files)) throw new Error("ROLLBACK_SCOPE_CONFLICT: scaffold manifest is malformed");
  const seen = new Set<string>();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256)) throw new Error("ROLLBACK_SCOPE_CONFLICT: scaffold manifest is malformed");
    assertSafeManifestPath(entry.path);
    if (seen.has(entry.path)) throw new Error("ROLLBACK_SCOPE_CONFLICT: scaffold manifest contains duplicate paths");
    seen.add(entry.path);
    const digest = createHash("sha256").update(await readScaffoldFile(root, projectPath, entry.path)).digest("hex");
    if (digest !== entry.sha256) throw new Error(`ROLLBACK_SCOPE_CONFLICT: generated source changed after scaffold: ${entry.path}`);
  }
}

async function assertRollbackConfined(root: string, projectPath: string, expectedLockfile: string | null, expectedManifest: string | null): Promise<void> {
  const changed = new Set<string>([
    ...await gitPaths(root, ["diff", "--name-only", "--no-renames", "-z"]),
    ...await gitPaths(root, ["diff", "--cached", "--name-only", "--no-renames", "-z"]),
    ...await gitPaths(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const unexpected = [...changed].filter((path) => path !== "pnpm-lock.yaml" && !path.startsWith(`${projectPath}/`));
  if (unexpected.length) throw new Error(`ROLLBACK_SCOPE_CONFLICT: unrelated worktree changes appeared: ${unexpected[0]}`);
  if (expectedLockfile === null) {
    if (changed.has("pnpm-lock.yaml")) throw new Error("ROLLBACK_SCOPE_CONFLICT: workspace lockfile changed before scaffold publication completed");
  } else if (await readRegularFile(join(root, "pnpm-lock.yaml"), "workspace lockfile") !== expectedLockfile) {
    throw new Error("ROLLBACK_SCOPE_CONFLICT: workspace lockfile changed after scaffold publication");
  }
  const targetExists = await pathExists(join(root, projectPath));
  if (expectedManifest === null) {
    if (targetExists) throw new Error("ROLLBACK_SCOPE_CONFLICT: project target appeared before scaffold publication completed");
  } else if (!targetExists) {
    throw new Error("ROLLBACK_SCOPE_CONFLICT: generated project disappeared before rollback");
  } else {
    await assertScaffoldSourcesUnchanged(root, projectPath, expectedManifest);
  }
}

export const DEFAULT_PROJECT_VALIDATION_TIMEOUT_MS = 300_000;

export async function createProject(root: string, spec: ProjectSpec, executionTimeoutMs = DEFAULT_PROJECT_VALIDATION_TIMEOUT_MS, maxOutputBytes = 8 * 1024 * 1024): Promise<ProjectCreation> {
  const slug = assertSafeClientSlug(spec.slug);
  const branchName = spec.branchName ?? `nexus-mcp/${slug}`;
  const commitMessage = spec.commitMessage ?? `feat(client): initialize ${slug}`;
  const projectPath = `apps/${slug}`;
  const projectModules = join(root, projectPath, "node_modules");
  if (!/^[a-f0-9]{40}$/u.test(spec.baseSha)) throw new Error("baseSha must be an exact 40-character lowercase Git commit SHA");
  if (!branchName.startsWith("nexus-mcp/")) throw new Error("branchName must start with nexus-mcp/");
  await command(root, "git", ["check-ref-format", "--branch", branchName]);
  if (await pathExists(join(root, projectPath))) throw new Error(`TARGET_EXISTS: ${projectPath} already exists`);
  const originalHead = await command(root, "git", ["rev-parse", "HEAD"]);
  if (originalHead !== spec.baseSha) throw new Error(`SOURCE_SHA_MISMATCH: requested ${spec.baseSha}, current HEAD is ${originalHead}`);
  const originalBranch = await command(root, "git", ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "");
  const originalStatus = await command(root, "git", ["status", "--porcelain"]);
  if (originalStatus) throw new Error("DIRTY_WORKTREE: project creation requires a clean checkout");

  const temporary = await mkdtemp(join(tmpdir(), "nexus-project-spec-"));
  const specPath = join(temporary, "project-spec.json");
  let branchCreated = false;
  let scaffoldCreated = false;
  let modulesLinked = false;
  let completed = false;
  let scaffoldLockfile: string | null = null;
  let scaffoldManifest: string | null = null;
  try {
    await writeFile(specPath, `${JSON.stringify({ schemaVersion: 1, slug, business: spec.business, artDirection: spec.artDirection }, null, 2)}\n`);
    await command(root, "git", ["switch", "-c", branchName, spec.baseSha]);
    branchCreated = true;
    await command(root, process.execPath, ["scripts/scaffold-client.mjs", slug, "--project-spec", specPath]);
    scaffoldCreated = true;
    scaffoldLockfile = await readRegularFile(join(root, "pnpm-lock.yaml"), "workspace lockfile");
    scaffoldManifest = await readScaffoldFile(root, projectPath, ".nexus/scaffold-manifest.json");
    try { await stat(join(root, "apps", "_experience-seed", "node_modules")); } catch { throw new Error("DEPENDENCY_UNAVAILABLE: workspace dependencies are not installed"); }
    await symlink(join("..", "_experience-seed", "node_modules"), projectModules, "dir");
    modulesLinked = true;
    const validations = ["lint", "typecheck", "build"] as const;
    const validation = [];
    for (const task of validations) {
      const args = ["--filter", `@nexus/${slug}`, task];
      await command(root, "pnpm", args, executionTimeoutMs, maxOutputBytes);
      validation.push({ command: `pnpm ${args.join(" ")}`, exitCode: 0 as const, status: "PASS" as const });
    }
    await rm(projectModules, { recursive: true, force: true });
    modulesLinked = false;
    const project = (await readProjects(root)).find((candidate) => candidate.slug === slug);
    if (!project || project.kind !== "CLIENT" || !project.clientProject) throw new Error("created project was not admitted by NEXUS client discovery");

    await command(root, "git", ["add", "--", projectPath, "pnpm-lock.yaml"]);
    const files = (await command(root, "git", ["diff", "--cached", "--name-only", "--", projectPath, "pnpm-lock.yaml"])).split("\n").filter(Boolean);
    const projectFiles = files.filter((path) => path.startsWith(`${projectPath}/`));
    const unexpected = files.filter((path) => path !== "pnpm-lock.yaml" && !path.startsWith(`${projectPath}/`));
    if (!projectFiles.length || !files.includes("pnpm-lock.yaml") || unexpected.length) {
      throw new Error("scaffold must stage confined client files plus the workspace lockfile importer");
    }
    await command(root, "git", ["commit", "-m", commitMessage, "--", projectPath, "pnpm-lock.yaml"]);
    const residual = await command(root, "git", ["status", "--porcelain"]);
    if (residual) throw new Error(`project creation left uncommitted changes: ${residual.split("\n")[0]}`);
    const headSha = await command(root, "git", ["rev-parse", "HEAD"]);
    const remoteUrl = await command(root, "git", ["remote", "get-url", "origin"]).catch(() => "");
    completed = true;
    return { project, branch: { name: branchName, baseSha: spec.baseSha, headSha, remoteUrl: remoteUrl || null }, commit: { sha: headSha, message: commitMessage }, files, validation };
  } catch (cause) {
    if (branchCreated && !completed) {
      try {
        if (modulesLinked) {
          await rm(projectModules, { recursive: true, force: true });
          modulesLinked = false;
        }
        await assertRollbackConfined(root, projectPath, scaffoldLockfile, scaffoldManifest);
        await command(root, "git", ["reset", "--hard", spec.baseSha]);
        if (scaffoldCreated) await rm(join(root, projectPath), { recursive: true, force: true });
        if (originalBranch) await command(root, "git", ["switch", originalBranch]);
        else await command(root, "git", ["switch", "--detach", spec.baseSha]);
        await command(root, "git", ["branch", "-D", branchName]);
      } catch (rollbackCause) {
        const primary = cause instanceof Error ? cause.message : String(cause);
        const rollback = rollbackCause instanceof Error ? rollbackCause.message : String(rollbackCause);
        throw new Error(`PROJECT_CREATION_ROLLBACK_FAILED: ${primary}; rollback: ${rollback}`, { cause: rollbackCause });
      }
    }
    throw cause;
  } finally {
    if (modulesLinked) await rm(projectModules, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}
