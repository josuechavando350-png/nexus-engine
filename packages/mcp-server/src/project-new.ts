import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ProjectState } from "./contracts.js";
import { readProjects } from "./projects.js";

const exec = promisify(execFile);

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

async function command(root: string, executable: string, args: readonly string[], timeout = 120_000): Promise<string> {
  const result = await exec(executable, [...args], { cwd: root, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 });
  return result.stdout.trim();
}

export async function createProject(root: string, spec: ProjectSpec): Promise<ProjectCreation> {
  const branchName = spec.branchName ?? `nexus-mcp/${spec.slug}`;
  const commitMessage = spec.commitMessage ?? `feat(client): initialize ${spec.slug}`;
  const temporary = await mkdtemp(join(tmpdir(), "nexus-project-spec-"));
  const specPath = join(temporary, "project-spec.json");
  const projectModules = join(root, "apps", spec.slug, "node_modules");
  try {
    await writeFile(specPath, `${JSON.stringify({ schemaVersion: 1, slug: spec.slug, business: spec.business, artDirection: spec.artDirection }, null, 2)}\n`);
    await command(root, "git", ["switch", "-c", branchName, spec.baseSha]);
    await command(root, process.execPath, ["scripts/scaffold-client.mjs", spec.slug, "--project-spec", specPath]);
    try { await stat(join(root, "apps", "_experience-seed", "node_modules")); } catch { throw new Error("DEPENDENCY_UNAVAILABLE: workspace dependencies are not installed"); }
    await symlink(join("..", "_experience-seed", "node_modules"), projectModules, "dir");
    const validations = ["lint", "typecheck", "build"] as const;
    const validation = [];
    for (const task of validations) {
      const args = ["--filter", `@nexus/${spec.slug}`, task];
      await command(root, "pnpm", args, 300_000);
      validation.push({ command: `pnpm ${args.join(" ")}`, exitCode: 0 as const, status: "PASS" as const });
    }
    await rm(projectModules, { recursive: true, force: true });
    const project = (await readProjects(root)).find((candidate) => candidate.slug === spec.slug);
    if (!project || project.kind !== "CLIENT" || !project.clientProject) throw new Error("created project was not admitted by NEXUS client discovery");
    await command(root, "git", ["add", "--", `apps/${spec.slug}`]);
    const files = (await command(root, "git", ["diff", "--cached", "--name-only", "--", `apps/${spec.slug}`])).split("\n").filter(Boolean);
    if (files.length === 0 || files.some((path) => !path.startsWith(`apps/${spec.slug}/`))) throw new Error("scaffold produced no confined project files");
    await command(root, "git", ["commit", "-m", commitMessage, "--", `apps/${spec.slug}`]);
    const headSha = await command(root, "git", ["rev-parse", "HEAD"]);
    const remoteUrl = await command(root, "git", ["remote", "get-url", "origin"]).catch(() => "");
    return { project, branch: { name: branchName, baseSha: spec.baseSha, headSha, remoteUrl: remoteUrl || null }, commit: { sha: headSha, message: commitMessage }, files, validation };
  } finally {
    await rm(projectModules, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}
