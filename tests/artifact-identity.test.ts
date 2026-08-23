import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stageBuildArtifact, verifyStagedArtifact } from "../scripts/artifact-identity-core.mjs";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-artifact-")); roots.push(root);
  mkdirSync(join(root, "build"), { recursive: true });
  writeFileSync(join(root, "build", "index.js"), "export const value = 1;\n");
  writeFileSync(join(root, "build", "manifest.json"), '{"z":2,"a":1}\n');
  const artifactRoot = join(root, "downloaded");
  const manifestPath = join(root, "identity.json");
  stageBuildArtifact({ root, files: ["build/index.js", "build/manifest.json"], artifactRoot, manifestPath, identity: { sourceRevision: "fixture-sha" } });
  return { root, artifactRoot, manifestPath };
};

describe("build-once artifact identity", () => {
  it("accepts the exact downloaded artifact", () => {
    const { artifactRoot, manifestPath } = fixture();
    expect(verifyStagedArtifact({ artifactRoot, manifestPath, expectedSourceRevision: "fixture-sha" })).toMatchObject({ verdict: "PASS", fileCount: 2 });
  });

  it("puts the verification job red when a downloaded artifact is altered", () => {
    const { root, artifactRoot, manifestPath } = fixture();
    writeFileSync(join(artifactRoot, "build", "index.js"), "export const value = 2;\n");
    expect(() => execFileSync(process.execPath, [join(process.cwd(), "scripts", "verify-artifact.mjs"), "--artifact-root", artifactRoot, "--manifest", manifestPath, "--source-revision", "fixture-sha"], { cwd: root, stdio: "pipe" }))
      .toThrow(expect.objectContaining({ status: 1 }));
  });

  it("rejects added, removed and source-mismatched artifacts", () => {
    const added = fixture(); writeFileSync(join(added.artifactRoot, "added.txt"), "unexpected\n");
    expect(() => verifyStagedArtifact({ ...added, expectedSourceRevision: "fixture-sha" })).toThrow(/ARTIFACT_IDENTITY_MISMATCH/);
    const removed = fixture(); rmSync(join(removed.artifactRoot, "build", "index.js"));
    expect(() => verifyStagedArtifact({ ...removed, expectedSourceRevision: "fixture-sha" })).toThrow(/ARTIFACT_IDENTITY_MISMATCH/);
    const source = fixture();
    expect(() => verifyStagedArtifact({ ...source, expectedSourceRevision: "other-sha" })).toThrow(/source revision mismatch/);
  });

  it("records semantic JSON identity without weakening raw artifact identity", () => {
    const { manifestPath } = fixture();
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const json = manifest.files.find((entry: { path: string }) => entry.path.endsWith("manifest.json"));
    expect(json.semanticSha256).toBeTypeOf("string");
    expect(json.sha256).not.toBe(json.semanticSha256);
  });
});
