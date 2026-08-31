import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createProject } from "../src/project-new.js";
import { nexusProjectNew, type ToolDependencies } from "../src/tools.js";

const exec = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const git = { branch: "work", headSha: "a".repeat(40), detached: false, clean: true, changedPaths: [] as string[], remoteUrl: null };
const spec = {
  slug: "mcp-fixture-client", baseSha: git.headSha,
  business: { name: "Fixture Client", industry: "Hospitality", location: "Mérida", contact: { email: "hello@example.com" }, confirmedServices: [{ name: "Reservations" }] },
  artDirection: { palette: [{ hex: "#112233", role: "surface", rationale: "Quiet base" }, { hex: "#DDAA22", role: "accent", rationale: "Warm emphasis" }], typography: { display: "Editorial serif", body: "Humanist sans", rationale: "Clear hierarchy" }, heroComposition: { direction: "Asymmetric split", rationale: "Prioritize place" }, sectionRhythm: { direction: "Alternating dense and open", rationale: "Measured pacing" }, motion: { direction: "Short reveals", reducedMotionBehavior: "No transforms", rationale: "Preserve orientation" }, prohibitions: ["No invented reviews"] },
};

async function initializeCreationFixture(prefix: string): Promise<{ root: string; baseSha: string; originalLockfile: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix)); roots.push(root);
  await cp(join(repositoryRoot, "apps/_experience-seed"), join(root, "apps/_experience-seed"), { recursive: true, filter: (source) => !source.includes("/.next/") && !source.includes("/node_modules/") });
  await mkdir(join(root, "scripts"), { recursive: true });
  await cp(join(repositoryRoot, "scripts/scaffold-client.mjs"), join(root, "scripts/scaffold-client.mjs"));
  await cp(join(repositoryRoot, "scripts/project-spec-contract.mjs"), join(root, "scripts/project-spec-contract.mjs"));
  await cp(join(repositoryRoot, "pnpm-lock.yaml"), join(root, "pnpm-lock.yaml"));
  await exec("git", ["init", "-b", "work"], { cwd: root });
  await exec("git", ["config", "user.email", "nexus-test@example.com"], { cwd: root });
  await exec("git", ["config", "user.name", "NEXUS Test"], { cwd: root });
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "-m", "fixture"], { cwd: root });
  const baseSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  return { root, baseSha, originalLockfile: await readFile(join(root, "pnpm-lock.yaml"), "utf8") };
}

async function withFakePnpm(script: string, action: () => Promise<void>): Promise<void> {
  const fakeBin = await mkdtemp(join(tmpdir(), "nexus-fake-pnpm-")); roots.push(fakeBin);
  const fakePnpm = join(fakeBin, "pnpm");
  await writeFile(fakePnpm, `#!/usr/bin/env node\n${script}\n`);
  await chmod(fakePnpm, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${delimiter}${previousPath ?? ""}`;
  try { await action(); } finally { process.env.PATH = previousPath; }
}

describe("block four project creation", () => {
  it("compiles supplied facts and art direction into a non-placeholder client app plus lockfile importer", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-scaffold-test-")); roots.push(root);
    await cp(join(repositoryRoot, "apps/_experience-seed"), join(root, "apps/_experience-seed"), { recursive: true, filter: (source) => !source.includes("/.next/") && !source.includes("/node_modules/") });
    await mkdir(join(root, "scripts"), { recursive: true });
    await cp(join(repositoryRoot, "scripts/scaffold-client.mjs"), join(root, "scripts/scaffold-client.mjs"));
    await cp(join(repositoryRoot, "scripts/project-spec-contract.mjs"), join(root, "scripts/project-spec-contract.mjs"));
    await cp(join(repositoryRoot, "pnpm-lock.yaml"), join(root, "pnpm-lock.yaml"));
    const input = join(root, "input.json");
    await writeFile(input, JSON.stringify({ schemaVersion: 1, slug: spec.slug, business: spec.business, artDirection: spec.artDirection }));
    await exec(process.execPath, ["scripts/scaffold-client.mjs", spec.slug, "--project-spec", input], { cwd: root });
    const packageManifest = JSON.parse(await readFile(join(root, `apps/${spec.slug}/package.json`), "utf8"));
    const stored = JSON.parse(await readFile(join(root, `apps/${spec.slug}/.nexus/project-spec.json`), "utf8"));
    const compiled = JSON.parse(await readFile(join(root, `apps/${spec.slug}/.nexus/compiled-project.json`), "utf8"));
    const scaffold = JSON.parse(await readFile(join(root, `apps/${spec.slug}/.nexus/scaffold-manifest.json`), "utf8"));
    const page = await readFile(join(root, `apps/${spec.slug}/src/app/page.tsx`), "utf8");
    const data = await readFile(join(root, `apps/${spec.slug}/src/app/project-data.ts`), "utf8");
    const theme = await readFile(join(root, `apps/${spec.slug}/src/app/theme.ts`), "utf8");
    const lockfile = await readFile(join(root, "pnpm-lock.yaml"), "utf8");

    expect(packageManifest).toMatchObject({ name: `@nexus/${spec.slug}`, nexus: { clientProject: true, projectSpecDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) } });
    expect(stored).toMatchObject({ slug: spec.slug, business: spec.business, artDirection: spec.artDirection });
    expect(compiled).toMatchObject({ authority: "NEXUS_PROJECT_SPEC_COMPILER_V1", specDigest: packageManifest.nexus.projectSpecDigest });
    expect(scaffold).toMatchObject({ authority: "NEXUS_SCAFFOLD_V2", client: spec.slug, projectSpecDigest: packageManifest.nexus.projectSpecDigest });
    expect(data).toContain("Fixture Client");
    expect(data).toContain("Reservations");
    expect(page).toContain("projectData.business.confirmedServices");
    expect(page).not.toMatch(/\[\s*(?:Marca|Título|Acción|Contenido|Pie|Enlace)/u);
    expect(theme).toContain('"surface.base": "#112233"');
    expect(theme).toContain('"accent.default": "#DDAA22"');
    expect(lockfile).toContain(`  apps/${spec.slug}:\n`);
    await expect(exec(process.execPath, ["scripts/scaffold-client.mjs", spec.slug, "--project-spec", input], { cwd: root })).rejects.toThrow(/target already exists/);
  });

  it("rejects unsafe direct mutation inputs before filesystem or Git mutation", async () => {
    await expect(createProject(process.cwd(), { ...spec, slug: "../../escape" })).rejects.toThrow(/reserved or invalid client-project name/);
    await expect(createProject(process.cwd(), { ...spec, branchName: `nexus-mcp/${"a".repeat(241)}` })).rejects.toThrow(/bounded nexus-mcp branch policy/);
    await expect(createProject(process.cwd(), { ...spec, commitMessage: ` ${"x".repeat(10)}` })).rejects.toThrow(/commitMessage must be trimmed/);
    await expect(createProject(process.cwd(), { ...spec, business: { ...spec.business, name: "x".repeat(300_000) } })).rejects.toThrow(/project specification exceeds/);
  });

  it("rolls back branch, files and lockfile when creation fails after scaffold publication", async () => {
    const { root, baseSha, originalLockfile } = await initializeCreationFixture("nexus-project-rollback-");

    await expect(createProject(root, { ...spec, baseSha })).rejects.toThrow(/DEPENDENCY_UNAVAILABLE/);

    expect((await exec("git", ["branch", "--show-current"], { cwd: root })).stdout.trim()).toBe("work");
    expect((await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim()).toBe(baseSha);
    expect((await exec("git", ["status", "--porcelain"], { cwd: root })).stdout.trim()).toBe("");
    expect((await exec("git", ["branch", "--list", `nexus-mcp/${spec.slug}`], { cwd: root })).stdout.trim()).toBe("");
    await expect(stat(join(root, `apps/${spec.slug}`))).rejects.toThrow();
    expect(await readFile(join(root, "pnpm-lock.yaml"), "utf8")).toBe(originalLockfile);

    const marker = join(root, `apps/${spec.slug}/node_modules/preserve.txt`);
    await mkdir(join(root, `apps/${spec.slug}/node_modules`), { recursive: true });
    await writeFile(marker, "existing project data");
    await expect(createProject(root, { ...spec, baseSha })).rejects.toThrow(/TARGET_EXISTS/);
    expect(await readFile(marker, "utf8")).toBe("existing project data");
  }, 20_000);

  it("refuses destructive rollback when unrelated work appears during creation", async () => {
    const { root, baseSha } = await initializeCreationFixture("nexus-project-conflict-");
    await mkdir(join(root, "apps/_experience-seed/node_modules"), { recursive: true });
    await withFakePnpm("require('node:fs').writeFileSync('unrelated.txt', 'must survive rollback'); process.exit(1);", async () => {
      await expect(createProject(root, { ...spec, baseSha })).rejects.toThrow(/PROJECT_CREATION_ROLLBACK_FAILED/);
    });

    expect(await readFile(join(root, "unrelated.txt"), "utf8")).toBe("must survive rollback");
    expect((await exec("git", ["branch", "--show-current"], { cwd: root })).stdout.trim()).toBe(`nexus-mcp/${spec.slug}`);
    expect(await readFile(join(root, `apps/${spec.slug}/.nexus/scaffold-manifest.json`), "utf8")).toContain("NEXUS_SCAFFOLD_V2");
    expect(await readFile(join(root, "pnpm-lock.yaml"), "utf8")).toContain(`  apps/${spec.slug}:\n`);
  }, 20_000);

  it("preserves ignored files that appear inside the project during a failed mutation", async () => {
    const { root, baseSha } = await initializeCreationFixture("nexus-project-ignored-conflict-");
    await mkdir(join(root, "apps/_experience-seed/node_modules"), { recursive: true });
    await withFakePnpm(`require('node:fs').writeFileSync('apps/${spec.slug}/.env.local', 'external-data'); process.exit(1);`, async () => {
      await expect(createProject(root, { ...spec, baseSha })).rejects.toThrow(/PROJECT_CREATION_ROLLBACK_FAILED/);
    });
    expect(await readFile(join(root, `apps/${spec.slug}/.env.local`), "utf8")).toBe("external-data");
    expect((await exec("git", ["branch", "--show-current"], { cwd: root })).stdout.trim()).toBe(`nexus-mcp/${spec.slug}`);
  }, 20_000);

  it("never recursively deletes a replaced node_modules link during rollback", async () => {
    const { root, baseSha } = await initializeCreationFixture("nexus-project-link-conflict-");
    await mkdir(join(root, "apps/_experience-seed/node_modules"), { recursive: true });
    const mutation = `const fs=require('node:fs'); const p='apps/${spec.slug}/node_modules'; fs.unlinkSync(p); fs.mkdirSync(p); fs.writeFileSync(p+'/preserve.txt','external-data'); process.exit(1);`;
    await withFakePnpm(mutation, async () => {
      await expect(createProject(root, { ...spec, baseSha })).rejects.toThrow(/PROJECT_CREATION_ROLLBACK_FAILED/);
    });
    expect(await readFile(join(root, `apps/${spec.slug}/node_modules/preserve.txt`), "utf8")).toBe("external-data");
    expect((await exec("git", ["branch", "--show-current"], { cwd: root })).stdout.trim()).toBe(`nexus-mcp/${spec.slug}`);
  }, 20_000);

  it("reports rollback failure as FAIL even when the primary failure was dependency unavailability", async () => {
    const result = await nexusProjectNew(spec, {
      root: process.cwd(),
      git: async () => git,
      projects: async () => [],
      projectCreator: async () => { throw new Error("PROJECT_CREATION_ROLLBACK_FAILED: rollback could not be completed safely"); },
    });
    expect(result.status).toBe("FAIL");
    expect(result.errors[0]?.code).toBe("PROJECT_CREATION_FAILED");
  });

  it("rejects collisions before invoking creation and leaves existing projects untouched", async () => {
    let invoked = false;
    const dependencies: ToolDependencies = { root: process.cwd(), git: async () => git, projects: async () => [{ slug: spec.slug, path: `apps/${spec.slug}`, packageName: `@nexus/${spec.slug}`, workspaceMember: true, kind: "CLIENT", clientProject: true, evidence: { packageJsonPath: `apps/${spec.slug}/package.json`, clientProjectDeclaration: true, classificationRule: "fixture" } }], projectCreator: async () => { invoked = true; throw new Error("must not run"); } };
    const result = await nexusProjectNew(spec, dependencies);
    expect(result.status).toBe("FAIL"); expect(result.errors[0]?.code).toBe("TARGET_EXISTS"); expect(invoked).toBe(false);
  });

  it("reports an unavailable creation dependency as NOT_TESTED", async () => {
    const result = await nexusProjectNew(spec, { root: process.cwd(), git: async () => git, projects: async () => [], projectCreator: async () => { throw new Error("spawn pnpm ENOENT"); } });
    expect(result.status).toBe("NOT_TESTED"); expect(result.errors[0]?.code).toBe("DEPENDENCIES_UNAVAILABLE");
  });
});
