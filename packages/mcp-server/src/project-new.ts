import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectState } from "./contracts.js";
import { readProjects } from "./projects.js";
import { runProcess } from "./process.js";

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

async function command(root: string, executable: string, args: readonly string[], timeout = 120_000, maxOutputBytes = 8 * 1024 * 1024): Promise<string> {
  const result = await runProcess(executable, args, { cwd: root, timeoutMs: timeout, maxOutputBytes });
  return result.stdout.toString("utf8").trim();
}

export const DEFAULT_PROJECT_VALIDATION_TIMEOUT_MS = 300_000;

export async function createProject(root: string, spec: ProjectSpec, executionTimeoutMs = DEFAULT_PROJECT_VALIDATION_TIMEOUT_MS, maxOutputBytes = 8 * 1024 * 1024): Promise<ProjectCreation> {
  const branchName = spec.branchName ?? `nexus-mcp/${spec.slug}`;
  const commitMessage = spec.commitMessage ?? `feat(client): initialize ${spec.slug}`;
  if (!/^[a-f0-9]{40}$/u.test(spec.baseSha)) throw new Error("baseSha must be an exact 40-character lowercase Git commit SHA");
  if (!branchName.startsWith("nexus-mcp/")) throw new Error("branchName must start with nexus-mcp/");
  await command(root, "git", ["check-ref-format", "--branch", branchName]);
  const originalHead = await command(root, "git", ["rev-parse", "HEAD"]);
  if (originalHead !== spec.baseSha) throw new Error(`SOURCE_SHA_MISMATCH: requested ${spec.baseSha}, current HEAD is ${originalHead}`);
  const originalBranch = await command(root, "git", ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "");
  const originalStatus = await command(root, "git", ["status", "--porcelain"]);
  if (originalStatus) throw new Error("DIRTY_WORKTREE: project creation requires a clean checkout");

  const temporary = await mkdtemp(join(tmpdir(), "nexus-project-spec-"));
  const specPath = join(temporary, "project-spec.json");
  const projectPath = `apps/${spec.slug}`;
  const projectModules = join(root, projectPath, "node_modules");
  let branchCreated = false;
  let scaffoldCreated = false;
  let completed = false;
  try {
    await writeFile(specPath, `${JSON.stringify({ schemaVersion: 1, slug: spec.slug, business: spec.business, artDirection: spec.artDirection }, null, 2)}\n`);
    await command(root, "git", ["switch", "-c", branchName, spec.baseSha]);
    branchCreated = true;
    await command(root, process.execPath, ["scripts/scaffold-client.mjs", spec.slug, "--project-spec", specPath]);
    scaffoldCreated = true;
    try { await stat(join(root, "apps", "_experience-seed", "node_modules")); } catch { throw new Error("DEPENDENCY_UNAVAILABLE: workspace dependencies are not installed"); }
    await symlink(join("..", "_experience-seed", "node_modules"), projectModules, "dir");
    const validations = ["lint", "typecheck", "build"] as const;
    const validation = [];
    for (const task of validations) {
      const args = ["--filter", `@nexus/${spec.slug}`, task];
      await command(root, "pnpm", args, executionTimeoutMs, maxOutputBytes);
      validation.push({ command: `pnpm ${args.join(" ")}`, exitCode: 0 as const, status: "PASS" as const });
    }
    await rm(projectModules, { recursive: true, force: true });
    const project = (await readProjects(root)).find((candidate) => candidate.slug === spec.slug);
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
        await rm(projectModules, { recursive: true, force: true });
        await command(root, "git", ["reset", "--hard", spec.baseSha]);
        if (scaffoldCreated) await rm(join(root, projectPath), { recursive: true, force: true });
        if (originalBranch) await command(root, "git", ["switch", originalBranch]);
        else await command(root, "git", ["switch", "--detach", spec.baseSha]);
        await command(root, "git", ["branch", "-D", branchName]);
      } catch (rollbackCause) {
        const primary = cause instanceof Error ? cause.message : String(cause);
        const rollback = rollbackCause instanceof Error ? rollbackCause.message : String(rollbackCause);
        throw new Error(`PROJECT_CREATION_ROLLBACK_FAILED: ${primary}; rollback: ${rollback}`, { cause: new AggregateError([cause, rollbackCause]) });
      }
    }
    throw cause;
  } finally {
    await rm(projectModules, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}
