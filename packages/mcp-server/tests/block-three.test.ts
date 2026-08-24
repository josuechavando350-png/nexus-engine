import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { BuildExecution, BuildManifest } from "../src/build.js";
import type { GitState, ProjectState } from "../src/contracts.js";
import { nexusBuild, nexusComparator } from "../src/tools.js";

const sha = "a".repeat(40);
const git: GitState = { branch: "work", headSha: sha, detached: false, clean: true, changedPaths: [], remoteUrl: null };
const project: ProjectState = { slug: "reference-alfil", path: "apps/reference-alfil", packageName: "@nexus/reference-alfil", workspaceMember: true, kind: "REFERENCE", clientProject: false, evidence: { packageJsonPath: "apps/reference-alfil/package.json", clientProjectDeclaration: null, classificationRule: "reference" } };
const base = { root: "/repo", git: async () => git, projects: async () => [project], requestId: () => "block-three" };

function manifest(): BuildManifest {
  const payload = { authority: "NEXUS_MCP_BUILD_MANIFEST_V1" as const, sourceSha: sha, target: project.path, nodeVersion: "v24.0.0", pnpmVersion: "10.15.0", packageManager: "pnpm@10.15.0", lockfileSha256: "b".repeat(64), buildKey: "c".repeat(64), cacheHit: false, outputDigest: "d".repeat(64), files: [{ path: "apps/reference-alfil/.next/BUILD_ID", byteLength: 20, sha256: "e".repeat(64) }] };
  return { ...payload, manifestSha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
}

function execution(overrides: Partial<BuildExecution> = {}): BuildExecution {
  return { target: { slug: project.slug, path: project.path, packageName: project.packageName }, command: "node scripts/build-target-manifest.mjs", exitCode: 0, durationMs: 10, logPath: "/tmp/build.log", manifest: manifest(), ...overrides };
}

it("returns PASS only for a successful existing-pipeline build with a valid manifest", async () => {
  const result = await nexusBuild({ target: project.slug, sourceSha: sha }, { ...base, buildRunner: async () => execution() });
  expect(result.status).toBe("PASS");
  expect(result.data?.manifest?.sourceSha).toBe(sha);
  expect(result.evidence.some((item) => item.locator.includes(result.data!.manifest!.manifestSha256))).toBe(true);
});

it("distinguishes executed build failure from unavailable build capability", async () => {
  const failed = await nexusBuild({ target: project.slug, sourceSha: sha }, { ...base, buildRunner: async () => execution({ exitCode: 1, manifest: null }) });
  expect(failed.status).toBe("FAIL"); expect(failed.errors[0]?.code).toBe("BUILD_FAILED");
  const unavailable = await nexusBuild({ target: project.slug, sourceSha: sha }, { ...base, buildRunner: async () => execution({ exitCode: null, manifest: null, unavailableReason: "node executable is unavailable" }) });
  expect(unavailable.status).toBe("NOT_TESTED"); expect(unavailable.errors[0]?.code).toBe("DEPENDENCIES_UNAVAILABLE");
});

it("reports the absent geometric comparator as NOT_TESTED without fabricated counts", async () => {
  const result = await nexusComparator({ source: { target: project.slug }, sourceSha: sha }, base);
  expect(result.status).toBe("NOT_TESTED");
  expect(result.data).toBeNull();
  expect(result.errors).toEqual([{ code: "NEXUS_CAPABILITY_MISSING", message: "VISUAL_REGRESSION_GEOMETRY: no geometric comparator implementation or permanent negative fixture exists in NEXUS", retryable: false }]);
});

it("fails comparator target requests that are not bound to current source", async () => {
  const result = await nexusComparator({ source: { target: project.slug }, sourceSha: "f".repeat(40) }, base);
  expect(result.status).toBe("FAIL");
  expect(result.errors[0]?.code).toBe("SOURCE_SHA_MISMATCH");
});
