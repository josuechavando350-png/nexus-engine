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
  writeFileSync,
} from "node:fs";
import { delimiter, join, relative, resolve, sep } from "node:path";

export const OUTPUT_DIR_NAMES = ["dist", "build", "out", ".next"];
export const DEFAULT_SOURCE_DATE_EPOCH = "315532800";
const IGNORED_NAMES = new Set(["node_modules", ".git", ".nexus-cache", ".turbo", ".cache", "coverage", ...OUTPUT_DIR_NAMES]);

export function normalizedPath(path) {
  return path.split(sep).join("/");
}

export function sourceDateEpoch() {
  const value = process.env.SOURCE_DATE_EPOCH || DEFAULT_SOURCE_DATE_EPOCH;
  if (!/^\d+$/.test(value)) throw new Error(`invalid SOURCE_DATE_EPOCH: ${value}`);
  return value;
}

export function deterministicEnv() {
  return {
    ...process.env,
    TZ: "UTC",
    LANG: "C",
    LC_ALL: "C",
    SOURCE_DATE_EPOCH: sourceDateEpoch(),
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
  for (const workspaceRoot of ["packages", "apps"]) {
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

  const sharedConfigDir = join(root, "packages", "config");
  if (existsSync(sharedConfigDir) && statSync(sharedConfigDir).isDirectory()) files.push(...walkFiles(sharedConfigDir));

  for (const shared of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "vitest.config.ts", "eslint.config.mjs"]) {
    const absolute = join(root, shared);
    if (existsSync(absolute) && statSync(absolute).isFile()) files.push(absolute);
  }
  return [...new Set(files)].sort((a, b) => normalizedPath(a).localeCompare(normalizedPath(b), "en"));
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

export function targetBuildKey(target, root = process.cwd()) {
  const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const payload = {
    schemaVersion: 1,
    contentHash: targetContentHash(target.dir, root),
    command: target.command,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    packageManager: rootManifest.packageManager ?? "UNPINNED",
    sourceDateEpoch: sourceDateEpoch(),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
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

export function snapshotTargetOutputs(target, root = process.cwd()) {
  const files = outputDirs(target.dir).flatMap((dir) => walkFiles(dir, { ignore: new Set(["node_modules", ".git"]) }));
  return {
    digest: digestFiles(files, root),
    files: files.map((path) => normalizedPath(relative(root, path))).sort((a, b) => a.localeCompare(b, "en")),
  };
}

export function restoreFromCache(target, hash, root = process.cwd()) {
  const cacheRoot = cacheRootFor(hash, target.relativeDir, root);
  const manifestPath = join(cacheRoot, "cache-manifest.json");
  if (!existsSync(cacheRoot) || !existsSync(manifestPath)) return false;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    rmSync(cacheRoot, { recursive: true, force: true });
    return false;
  }
  if (manifest.schemaVersion !== 1 || manifest.buildKey !== hash || typeof manifest.outputDigest !== "string" || !Array.isArray(manifest.files)) {
    rmSync(cacheRoot, { recursive: true, force: true });
    return false;
  }
  clearOutputs(target.dir);
  for (const name of OUTPUT_DIR_NAMES) {
    const cached = join(cacheRoot, name);
    if (existsSync(cached)) cpSync(cached, join(target.dir, name), { recursive: true, preserveTimestamps: false });
  }
  const restored = snapshotTargetOutputs(target, root);
  if (restored.digest !== manifest.outputDigest || JSON.stringify(restored.files) !== JSON.stringify(manifest.files)) {
    clearOutputs(target.dir);
    rmSync(cacheRoot, { recursive: true, force: true });
    return false;
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
  const snapshot = snapshotTargetOutputs(target, root);
  if (!snapshot.files.length) {
    rmSync(cacheRoot, { recursive: true, force: true });
    return;
  }
  const manifest = { schemaVersion: 1, buildKey: hash, outputDigest: snapshot.digest, files: snapshot.files };
  writeFileSync(join(cacheRoot, "cache-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

export function runTargetBuild(target, root = process.cwd()) {
  const rootBin = join(root, "node_modules", ".bin");
  const packageBin = join(target.dir, "node_modules", ".bin");
  const path = [packageBin, rootBin, process.env.PATH ?? ""].filter(Boolean).join(delimiter);
  const env = { ...deterministicEnv(), PATH: path };

  if (process.env.NEXUS_ENFORCE_NETWORK_ISOLATION === "1") {
    if (process.platform !== "linux" || typeof process.getuid !== "function" || typeof process.getgid !== "function") {
      throw new Error("network-isolated hermetic builds require Linux uid/gid support");
    }
    execFileSync("sudo", [
      "unshare",
      "--net",
      "--setuid", String(process.getuid()),
      "--setgid", String(process.getgid()),
      "/usr/bin/env",
      "-i",
      `PATH=${path}`,
      `SOURCE_DATE_EPOCH=${env.SOURCE_DATE_EPOCH}`,
      "TZ=UTC",
      "LANG=C",
      "LC_ALL=C",
      "HOME=/tmp",
      "TMPDIR=/tmp",
      "CI=true",
      "NEXUS_DETERMINISTIC_BUILD=1",
      "/bin/bash",
      "-c",
      target.command,
    ], { cwd: target.dir, stdio: "inherit", env: process.env });
    return;
  }

  execSync(target.command, {
    cwd: target.dir,
    stdio: "inherit",
    shell: "/bin/bash",
    env,
  });
}

export function snapshotOutputs(targets, root = process.cwd()) {
  const files = [];
  for (const target of targets) for (const dir of outputDirs(target.dir)) files.push(...walkFiles(dir, { ignore: new Set(["node_modules", ".git"]) }));
  return { digest: digestFiles(files, root), files: files.map((path) => normalizedPath(relative(root, path))).sort((a, b) => a.localeCompare(b, "en")) };
}
