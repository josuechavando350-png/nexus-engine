import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverClientApps, loadSceneManifest, loadShadowBaseline, snapshotScenes } from "./client-fleet.mjs";

const root = process.cwd();
const outputDir = join(root, "artifacts", "shadow-mode");
mkdirSync(outputDir, { recursive: true });
const clients = discoverClientApps(root);
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const generatedAt = new Date().toISOString();

if (clients.length === 0) {
  const report = { authority: "NEXUS_SHADOW_MODE_V1", verdict: "NOT_TESTED", reason: "NO_CLIENT_APPS", sourceRevision, generatedAt, deploymentPerformed: false, clients: [] };
  writeFileSync(join(outputDir, "shadow-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

execFileSync("pnpm", ["build"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    NEXUS_SHADOW_MODE: "1",
    NEXUS_DEPLOY_DISABLED: "1",
    NEXUS_ENFORCE_NETWORK_ISOLATION: process.env.CI === "true" ? "1" : process.env.NEXUS_ENFORCE_NETWORK_ISOLATION,
    TZ: "UTC",
    LANG: "C",
    LC_ALL: "C",
  },
});

function artifactDiff(beforeArtifacts = [], afterArtifacts = []) {
  const before = new Map(beforeArtifacts.map((artifact) => [artifact.path, artifact]));
  const after = new Map(afterArtifacts.map((artifact) => [artifact.path, artifact]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a.localeCompare(b, "en"));
  return paths.flatMap((path) => {
    const previous = before.get(path);
    const current = after.get(path);
    if (previous?.digest === current?.digest && previous?.byteLength === current?.byteLength) return [];
    return [{
      path,
      change: !previous ? "ADDED" : !current ? "REMOVED" : "MODIFIED",
      beforeDigest: previous?.digest ?? null,
      afterDigest: current?.digest ?? null,
      beforeByteLength: previous?.byteLength ?? null,
      afterByteLength: current?.byteLength ?? null,
    }];
  });
}

const results = [];
for (const client of clients) {
  const appDir = join(root, "apps", client);
  const manifest = loadSceneManifest(appDir);
  const baseline = loadShadowBaseline(appDir, client);
  if (!manifest || !baseline) {
    results.push({ projectId: client, verdict: "NOT_TESTED", reason: !manifest ? "MISSING_SCENE_MANIFEST" : "MISSING_SHADOW_BASELINE", changedScenes: [] });
    continue;
  }

  const currentScenes = snapshotScenes(appDir, manifest);
  const baselineById = new Map(baseline.scenes.map((scene) => [scene.sceneId, scene]));
  const changedScenes = currentScenes.flatMap((scene) => {
    const before = baselineById.get(scene.sceneId);
    if (before?.digest === scene.digest) return [];
    return [{
      sceneId: scene.sceneId,
      change: before ? "MODIFIED" : "ADDED",
      beforeDigest: before?.digest ?? null,
      afterDigest: scene.digest,
      changedArtifacts: artifactDiff(before?.artifacts, scene.artifacts),
    }];
  });
  const removedScenes = baseline.scenes
    .filter((scene) => !currentScenes.some((current) => current.sceneId === scene.sceneId))
    .map((scene) => ({
      sceneId: scene.sceneId,
      change: "REMOVED",
      beforeDigest: scene.digest,
      afterDigest: null,
      changedArtifacts: artifactDiff(scene.artifacts, []),
    }));
  changedScenes.push(...removedScenes);
  changedScenes.sort((a, b) => a.sceneId.localeCompare(b.sceneId, "en"));
  results.push({ projectId: client, baselineRevision: baseline.sourceRevision, baselineEngineVersion: baseline.engineVersion, verdict: changedScenes.length ? "WOULD_CHANGE" : "NO_CHANGE", changedScenes });
}

const report = {
  authority: "NEXUS_SHADOW_MODE_V1",
  verdict: results.some((result) => result.verdict === "WOULD_CHANGE") ? "WOULD_CHANGE" : results.every((result) => result.verdict === "NO_CHANGE") ? "NO_CHANGE" : "INCOMPLETE",
  sourceRevision,
  generatedAt,
  deploymentPerformed: false,
  clients: results,
};
writeFileSync(join(outputDir, "shadow-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
