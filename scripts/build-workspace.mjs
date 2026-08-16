import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const workspaceRoots = ["packages", "apps"];
const buildTargets = [];

for (const workspaceRoot of workspaceRoots) {
  const absoluteRoot = join(root, workspaceRoot);
  if (!existsSync(absoluteRoot)) continue;

  for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const relativeDir = join(workspaceRoot, entry.name);
    const manifestPath = join(root, relativeDir, "package.json");
    if (!existsSync(manifestPath)) continue;

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof manifest.scripts?.build === "string") {
      buildTargets.push(relativeDir);
    }
  }
}

buildTargets.sort((a, b) => a.localeCompare(b, "en"));

for (const target of buildTargets) {
  console.log(`\n=== Building ${target} ===`);
  execFileSync("pnpm", ["--dir", target, "run", "build"], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
}

console.log(`\nWorkspace build completed for ${buildTargets.length} package(s).`);
