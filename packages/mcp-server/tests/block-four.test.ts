import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
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

describe("block four project creation", () => {
  it("uses the repository scaffold to persist supplied facts and explicit client classification", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-scaffold-test-")); roots.push(root);
    await cp(join(repositoryRoot, "apps/_experience-seed"), join(root, "apps/_experience-seed"), { recursive: true, filter: (source) => !source.includes("/.next/") && !source.includes("/node_modules/") });
    await mkdir(join(root, "scripts"), { recursive: true });
    await cp(join(repositoryRoot, "scripts/scaffold-client.mjs"), join(root, "scripts/scaffold-client.mjs"));
    const input = join(root, "input.json");
    await writeFile(input, JSON.stringify({ schemaVersion: 1, slug: spec.slug, business: spec.business, artDirection: spec.artDirection }));
    await exec(process.execPath, ["scripts/scaffold-client.mjs", spec.slug, "--project-spec", input], { cwd: root });
    const manifest = JSON.parse(await readFile(join(root, `apps/${spec.slug}/package.json`), "utf8"));
    const stored = JSON.parse(await readFile(join(root, `apps/${spec.slug}/.nexus/project-spec.json`), "utf8"));
    expect(manifest).toMatchObject({ name: `@nexus/${spec.slug}`, nexus: { clientProject: true } });
    expect(stored).toMatchObject({ slug: spec.slug, business: spec.business, artDirection: spec.artDirection });
    await expect(exec(process.execPath, ["scripts/scaffold-client.mjs", spec.slug, "--project-spec", input], { cwd: root })).rejects.toThrow(/target already exists/);
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
