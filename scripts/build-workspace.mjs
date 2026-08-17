import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";

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
      buildTargets.push({ relativeDir, command: manifest.scripts.build });
    }
  }
}

buildTargets.sort((a, b) => a.relativeDir.localeCompare(b.relativeDir, "en"));

const rootBin = join(root, "node_modules", ".bin");

for (const { relativeDir, command } of buildTargets) {
  const cwd = join(root, relativeDir);
  const packageBin = join(cwd, "node_modules", ".bin");
  const path = [packageBin, rootBin, process.env.PATH ?? ""].filter(Boolean).join(delimiter);

  console.log(`\n=== Building ${relativeDir} ===`);
  execSync(command, {
    cwd,
    stdio: "inherit",
    shell: "/bin/bash",
    env: { ...process.env, PATH: path },
  });
}

console.log(`\nWorkspace build completed for ${buildTargets.length} package(s).`);
