import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverClientApps, loadSceneManifest, snapshotScenes } from "./client-fleet.mjs";

const root = process.cwd();
const outputDir = join(root, "artifacts", "shadow-mode");
mkdirSync(outputDir, { recursive: true });
const clients = discoverClientApps(root);
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const generatedAt = new Date().toISOString();

if (clients.length === 0) {
  const report = { authority: "NEXUS_SHADOW_MODE_V1", verdict: "NOT_TESTED", reason: "NO_CLIENT_APPS", sourceRevision, generatedAt, clients: [] };
  writeFileSync(join(outputDir, "shadow-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const results = [];
for (const client of clients) {
  const appDir = join(root, "apps", client);
  const manifest = loadSceneManifest(appDir);
  const baselinePath = join(appDir, "nexus-shadow-baseline.json");
  if (!manifest || !existsSync(baselinePath)) {
    results.push({ projectId: client, verdict: "NOT_TESTED", reason: !manifest ? "MISSING_SCENE_MANIFEST" : "MISSING_SHADOW_BASELINE", changedScenes: [] });
    continue;
  }

  const packagePath = join(appDir, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  if (typeof packageJson.scripts?.build !== "string") {
    results.push({ projectId: client, verdict: "NOT_TESTED", reason: "NO_BUILD_SCRIPT", changedScenes: [] });
    continue;
  }

  execFileSync("pnpm", ["--dir", appDir, "run", "build"], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      NEXUS_SHADOW_MODE: "1",
      NEXUS_DEPLOY_DISABLED: "1",
      TZ: "UTC",
      LANG: "C",
      LC_ALL: "C",
    },
  });

  const currentScenes = snapshotScenes(appDir, manifest);
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (baseline.schemaVersion !== 1 || !Array.isArray(baseline.scenes)) throw new Error(`invalid shadow baseline: ${baselinePath}`);
  const baselineById = new Map(baseline.scenes.map((scene) => [scene.sceneId, scene]));
  const changedScenes = currentScenes.flatMap((scene) => {
    const before = baselineById.get(scene.sceneId);
    if (before?.digest === scene.digest) return [];
    return [{
      sceneId: scene.sceneId,
      beforeDigest: before?.digest ?? null,
      afterDigest: scene.digest,
      artifactPaths: scene.artifactPaths,
    }];
  });
  const removedScenes = baseline.scenes
    .filter((scene) => !currentScenes.some((current) => current.sceneId === scene.sceneId))
    .map((scene) => ({ sceneId: scene.sceneId, beforeDigest: scene.digest ?? null, afterDigest: null, artifactPaths: scene.artifactPaths ?? [] }));
  changedScenes.push(...removedScenes);
  changedScenes.sort((a, b) => a.sceneId.localeCompare(b.sceneId, "en"));
  results.push({ projectId: client, verdict: changedScenes.length ? "WOULD_CHANGE" : "NO_CHANGE", changedScenes });
}

const report = {
  authority: "NEXUS_SHADOW_MODE_V1",
  verdict: results.some((result) => result.verdict === "WOULD_CHANGE")
    ? "WOULD_CHANGE"
    : results.every((result) => result.verdict === "NO_CHANGE")
      ? "NO_CHANGE"
      : "INCOMPLETE",
  sourceRevision,
  generatedAt,
  deploymentPerformed: false,
  clients: results,
};
writeFileSync(join(outputDir, "shadow-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
