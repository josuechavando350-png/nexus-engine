import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { BuildExecution, BuildManifest } from "../src/build.js";
import type { GitState, ProjectState } from "../src/contracts.js";
import { nexusGates } from "../src/tools.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const sha = "a".repeat(40);
const project: ProjectState = { slug: "target", path: "apps/target", packageName: "@nexus/target", workspaceMember: true, kind: "REFERENCE", clientProject: false, evidence: { packageJsonPath: "apps/target/package.json", clientProjectDeclaration: null, classificationRule: "reference" } };

function git(clean = true): GitState {
  return { branch: "work", headSha: sha, detached: false, clean, changedPaths: clean ? [] : ["dirty.txt"], remoteUrl: null };
}

function manifest(sourceSha: string, files: BuildManifest["files"]): BuildManifest {
  const payload = { authority: "NEXUS_MCP_BUILD_MANIFEST_V1" as const, sourceSha, target: project.path, nodeVersion: "v24.0.0", pnpmVersion: "10.15.0", packageManager: "pnpm@10.15.0", lockfileSha256: "b".repeat(64), buildKey: "c".repeat(64), cacheHit: false, outputDigest: "d".repeat(64), files };
  return { ...payload, manifestSha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
}

async function fixture(bytes = "first", manifestSha = sha): Promise<{ root: string; execution: BuildExecution; output: string }> {
  const root = await mkdtemp(join(tmpdir(), "nexus-build-gate-")); roots.push(root);
  const output = join(root, project.path, "dist", "artifact.bin");
  await mkdir(join(root, project.path, "dist"), { recursive: true });
  await writeFile(output, bytes);
  const contents = Buffer.from(bytes);
  const buildManifest = manifest(manifestSha, [{ path: `${project.path}/dist/artifact.bin`, byteLength: contents.byteLength, sha256: createHash("sha256").update(contents).digest("hex") }]);
  return { root, output, execution: { target: { slug: project.slug, path: project.path, packageName: project.packageName }, command: "node scripts/build-target-manifest.mjs", exitCode: 0, durationMs: 1, logPath: join(root, "build.log"), manifest: buildManifest } };
}

async function gate(root: string, execution: BuildExecution, state = git()) {
  await writeFile(execution.logPath, "build complete\n");
  return nexusGates({ target: project.slug, sourceSha: sha, gates: ["build"] }, { root, git: async () => state, projects: async () => [project], buildRunner: async () => execution, requestId: () => "build-gate" });
}

it("accepts consecutive SHA-bound builds even when their output bytes differ", async () => {
  const first = await fixture("first-build");
  const second = await fixture("second-build-with-different-bytes");
  expect((await gate(first.root, first.execution)).status).toBe("PASS");
  expect((await gate(second.root, second.execution)).status).toBe("PASS");
});

it("rejects a manifest whose sourceSha differs from HEAD", async () => {
  const value = await fixture("bytes", "b".repeat(40));
  expect((await gate(value.root, value.execution)).status).toBe("FAIL");
});

it("rejects output whose bytes change after manifest generation", async () => {
  const value = await fixture("original");
  await writeFile(value.output, "tampered");
  expect((await gate(value.root, value.execution)).status).toBe("FAIL");
});

it.each(["added", "removed"])("rejects an %s output file", async (operation) => {
  const value = await fixture("original");
  if (operation === "added") await writeFile(join(value.root, project.path, "dist", "extra.bin"), "extra");
  else await rm(value.output);
  expect((await gate(value.root, value.execution)).status).toBe("FAIL");
});

it("rejects a dirty worktree before running the build", async () => {
  const value = await fixture();
  let ran = false;
  const result = await nexusGates({ target: project.slug, sourceSha: sha, gates: ["build"] }, { root: value.root, git: async () => git(false), projects: async () => [project], buildRunner: async () => { ran = true; return value.execution; } });
  expect(result.status).toBe("FAIL");
  expect(result.errors[0]?.code).toBe("DIRTY_WORKTREE");
  expect(ran).toBe(false);
});
