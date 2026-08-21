import { createHash } from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { delimiter, join, relative, resolve, sep } from "node:path";

export const OUTPUT_DIR_NAMES = ["dist", "build", "out", ".next"];
const IGNORED_NAMES = new Set(["node_modules", ".git", ".nexus-cache", ".turbo", ".cache", "coverage", ...OUTPUT_DIR_NAMES]);

export function normalizedPath(path) {
  return path.split(sep).join("/");
}

export function sourceDateEpoch(root = process.cwd()) {
  if (process.env.SOURCE_DATE_EPOCH) return process.env.SOURCE_DATE_EPOCH;
  return execFileSync("git", ["log", "-1", "--format=%ct"], { cwd: root, encoding: "utf8" }).trim();
}

export function deterministicEnv(root = process.cwd()) {
  return {
    ...process.env,
    TZ: "UTC",
    LANG: "C",
    LC_ALL: "C",
    SOURCE_DATE_EPOCH: sourceDateEpoch(root),
    NEXUS_DETERMINISTIC_BUILD: "1",
  };
}

export function walkFiles(root, { ignore = IGNORED_NAMES } = {}) {
  if (!existsSync(root)) return [];
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (ignore.has(entry.name)) continue;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  visit(root);
  return files;
}

export function digestFiles(files, root = process.cwd()) {
  const hash = createHash("sha256");
  for (const absolute of [...files].sort((a, b) => normalizedPath(a).localeCompare(normalizedPath(b), "en"))) {
    const rel = normalizedPath(relative(root, absolute));
    const bytes = readFileSync(absolute);
    hash.update(rel);
    hash.update("\0");
    hash.update(String(bytes.length));
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function workspacePackages(root = process.cwd()) {
  const byName = new Map();
  const roots = ["packages", "apps"];
  for (const workspaceRoot of roots) {
    const absoluteRoot = join(root, workspaceRoot);
    if (!existsSync(absoluteRoot)) continue;
    for (const entry of readdirSync(absoluteRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (!entry.isDirectory()) continue;
      const dir = join(absoluteRoot, entry.name);
      const manifestPath = join(dir, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (typeof manifest.name === "string") byName.set(manifest.name, { dir, manifest, manifestPath });
    }
  }
  return byName;
}

function dependencyNames(manifest) {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);
}

export function transitiveWorkspaceFiles(targetDir, root = process.cwd()) {
  const packages = workspacePackages(root);
  const targetManifestPath = join(targetDir, "package.json");
  const targetManifest = JSON.parse(readFileSync(targetManifestPath, "utf8"));
  const queue = [targetManifest];
  const seenNames = new Set();
  const dirs = new Set([resolve(targetDir)]);

  while (queue.length) {
    const manifest = queue.shift();
    for (const name of dependencyNames(manifest)) {
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      const dep = packages.get(name);
      if (!dep) continue;
      dirs.add(resolve(dep.dir));
      queue.push(dep.manifest);
    }
  }

  const files = [];
  for (const dir of [...dirs].sort()) files.push(...walkFiles(dir));
  for (const shared of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "vitest.config.ts", "eslint.config.mjs"]) {
    const absolute = join(root, shared);
    if (existsSync(absolute) && statSync(absolute).isFile()) files.push(absolute);
  }
  return files;
}

export function targetContentHash(targetDir, root = process.cwd()) {
  return digestFiles(transitiveWorkspaceFiles(targetDir, root), root);
}

export function buildTargets(root = process.cwd()) {
  const targets = [];
  for (const { dir, manifest } of workspacePackages(root).values()) {
    if (typeof manifest.scripts?.build !== "string") continue;
    targets.push({ dir, relativeDir: normalizedPath(relative(root, dir)), command: manifest.scripts.build });
  }
  return targets.sort((a, b) => a.relativeDir.localeCompare(b.relativeDir, "en"));
}

export function outputDirs(targetDir) {
  return OUTPUT_DIR_NAMES.map((name) => join(targetDir, name)).filter((path) => existsSync(path) && statSync(path).isDirectory());
}

export function clearOutputs(targetDir) {
  for (const name of OUTPUT_DIR_NAMES) rmSync(join(targetDir, name), { recursive: true, force: true });
}

function cacheRootFor(hash, relativeDir, root) {
  return join(root, ".nexus-cache", "builds", hash, relativeDir.replaceAll("/", "__"));
}

export function restoreFromCache(target, hash, root = process.cwd()) {
  const cacheRoot = cacheRootFor(hash, target.relativeDir, root);
  if (!existsSync(cacheRoot)) return false;
  clearOutputs(target.dir);
  for (const name of OUTPUT_DIR_NAMES) {
    const cached = join(cacheRoot, name);
    if (existsSync(cached)) cpSync(cached, join(target.dir, name), { recursive: true, preserveTimestamps: false });
  }
  return true;
}

export function storeInCache(target, hash, root = process.cwd()) {
  const cacheRoot = cacheRootFor(hash, target.relativeDir, root);
  rmSync(cacheRoot, { recursive: true, force: true });
  mkdirSync(cacheRoot, { recursive: true });
  for (const output of outputDirs(target.dir)) {
    cpSync(output, join(cacheRoot, output.split(sep).at(-1)), { recursive: true, preserveTimestamps: false });
  }
}

export function runTargetBuild(target, root = process.cwd()) {
  const rootBin = join(root, "node_modules", ".bin");
  const packageBin = join(target.dir, "node_modules", ".bin");
  const path = [packageBin, rootBin, process.env.PATH ?? ""].filter(Boolean).join(delimiter);
  execSync(target.command, {
    cwd: target.dir,
    stdio: "inherit",
    shell: "/bin/bash",
    env: { ...deterministicEnv(root), PATH: path },
  });
}

export function snapshotOutputs(targets, root = process.cwd()) {
  const files = [];
  for (const target of targets) for (const dir of outputDirs(target.dir)) files.push(...walkFiles(dir, { ignore: new Set(["node_modules", ".git"]) }));
  return { digest: digestFiles(files, root), files: files.map((path) => normalizedPath(relative(root, path))).sort() };
}
