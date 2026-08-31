import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectState } from "./contracts.js";
import { readProjects } from "./projects.js";
import { runProcess } from "./process.js";

const CLIENT_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const RESERVED_CLIENT_PREFIXES = ["_", "reference-", "v2-probe-", "probe-", "test-"] as const;

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

async function assertScaffoldSourcesUnchanged(root: string, projectPath: string): Promise<void> {
  const manifestPath = join(root, projectPath, ".nexus", "scaffold-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ScaffoldManifest;
  if (!Array.isArray(manifest.files)) throw new Error("ROLLBACK_SCOPE_CONFLICT: scaffold manifest is malformed");
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256)) throw new Error("ROLLBACK_SCOPE_CONFLICT: scaffold manifest is malformed");
    const path = join(root, projectPath, entry.path);
    const digest = createHash("sha256").update(await readFile(path)).digest("hex");
    if (digest !== entry.sha256) throw new Error(`ROLLBACK_SCOPE_CONFLICT: generated source changed after scaffold: ${entry.path}`);
  }
}

async function assertRollbackConfined(root: string, projectPath: string, expectedLockfile: string | null): Promise<void> {
  const changed = new Set<string>([
    ...await gitPaths(root, ["diff", "--name-only", "--no-renames", "-z"]),
    ...await gitPaths(root, ["diff", "--cached", "--name-only", "--no-renames", "-z"]),
    ...await gitPaths(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const unexpected = [...changed].filter((path) => path !== "pnpm-lock.yaml" && !path.startsWith(`${projectPath}/`));
  if (unexpected.length) throw new Error(`ROLLBACK_SCOPE_CONFLICT: unrelated worktree changes appeared: ${unexpected[0]}`);
  if (expectedLockfile !== null && await readFile(join(root, "pnpm-lock.yaml"), "utf8") !== expectedLockfile) {
    throw new Error("ROLLBACK_SCOPE_CONFLICT: workspace lockfile changed after scaffold publication");
  }
  if (await pathExists(join(root, projectPath))) await assertScaffoldSourcesUnchanged(root, projectPath);
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
  try {
    await writeFile(specPath, `${JSON.stringify({ schemaVersion: 1, slug, business: spec.business, artDirection: spec.artDirection }, null, 2)}\n`);
    await command(root, "git", ["switch", "-c", branchName, spec.baseSha]);
    branchCreated = true;
    await command(root, process.execPath, ["scripts/scaffold-client.mjs", slug, "--project-spec", specPath]);
    scaffoldCreated = true;
    scaffoldLockfile = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
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
        await assertRollbackConfined(root, projectPath, scaffoldLockfile);
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
