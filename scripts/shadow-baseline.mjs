import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverClientApps, loadSceneManifest, snapshotScenes } from "./client-fleet.mjs";

const root = process.cwd();
const clients = discoverClientApps(root);
if (process.env.NEXUS_ALLOW_BASELINE_WRITE !== "1") throw new Error("shadow baseline writes require NEXUS_ALLOW_BASELINE_WRITE=1");
if (clients.length === 0) {
  console.log(JSON.stringify({ authority: "NEXUS_SHADOW_BASELINE_V1", verdict: "NOT_TESTED", reason: "NO_CLIENT_APPS", clients: [] }, null, 2));
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

const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const written = [];

for (const projectId of clients) {
  const appDir = join(root, "apps", projectId);
  const manifest = loadSceneManifest(appDir);
  if (!manifest) throw new Error(`shadow baseline requires nexus-scenes.json: ${projectId}`);
  const scenes = snapshotScenes(appDir, manifest);
  const baseline = {
    schemaVersion: 1,
    authority: "NEXUS_SHADOW_BASELINE_V1",
    projectId,
    sourceRevision,
    engineVersion: rootPackage.version,
    scenes,
  };
  const path = join(appDir, "nexus-shadow-baseline.json");
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
  written.push({ projectId, path: `apps/${projectId}/nexus-shadow-baseline.json`, sceneCount: scenes.length });
}

mkdirSync(join(root, "artifacts", "shadow-mode"), { recursive: true });
const report = { authority: "NEXUS_SHADOW_BASELINE_V1", verdict: "WRITTEN", sourceRevision, deploymentPerformed: false, clients: written };
writeFileSync(join(root, "artifacts", "shadow-mode", "baseline-write-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
