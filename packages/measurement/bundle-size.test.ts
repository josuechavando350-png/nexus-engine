import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { measureBuildArtifacts } from "./bundle-size";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nexus-bundle-size-"));
  dirs.push(root);
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.js"), "console.log('nexus');\n");
  await writeFile(join(root, "assets", "style.css"), "body{margin:0}\n");
  return root;
}

describe("measureBuildArtifacts", () => {
  it("measures exact emitted bytes and hashes from the real artifact directory", async () => {
    const root = await fixture();
    const report = await measureBuildArtifacts(root);
    expect(report.authority).toBe("NEXUS_BUILD_ARTIFACT_BYTES_V1");
    expect(report.fileCount).toBe(2);
    expect(report.totalBytes).toBe(Buffer.byteLength("console.log('nexus');\n") + Buffer.byteLength("body{margin:0}\n"));
    expect(report.artifacts.map((artifact) => artifact.path)).toEqual(["assets/style.css", "index.js"]);
    expect(report.artifacts.every((artifact) => /^sha256:[a-f0-9]{64}$/.test(artifact.sha256))).toBe(true);
    expect(report.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("is deterministic for unchanged bytes", async () => {
    const root = await fixture();
    const first = await measureBuildArtifacts(root);
    const second = await measureBuildArtifacts(root);
    expect(second.digest).toBe(first.digest);
    expect(second.artifacts).toEqual(first.artifacts);
  });

  it("changes identity when emitted bytes change", async () => {
    const root = await fixture();
    const first = await measureBuildArtifacts(root);
    await writeFile(join(root, "index.js"), "console.log('nexus-v2');\n");
    const second = await measureBuildArtifacts(root);
    expect(second.digest).not.toBe(first.digest);
    expect(second.totalBytes).not.toBe(first.totalBytes);
  });

  it("fails closed for empty roots and symlinks instead of silently undercounting artifacts", async () => {
    const empty = await mkdtemp(join(tmpdir(), "nexus-bundle-empty-"));
    dirs.push(empty);
    await expect(measureBuildArtifacts(empty)).rejects.toThrow(/empty/);

    const root = await fixture();
    await symlink(join(root, "index.js"), join(root, "linked.js"));
    await expect(measureBuildArtifacts(root)).rejects.toThrow(/symbolic link/);
  });
});
