import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { ProjectState } from "./contracts.js";
import { ProcessExecutionError, runProcess } from "./process.js";

export interface BuildArtifactFile { path: string; byteLength: number; sha256: string }
export interface BuildManifest { authority: "NEXUS_MCP_BUILD_MANIFEST_V1"; sourceSha: string; target: string; nodeVersion: string; pnpmVersion: string; packageManager: string; lockfileSha256: string; buildKey: string; cacheHit: boolean; outputDigest: string; files: readonly BuildArtifactFile[]; manifestSha256: string }
export interface BuildExecution { target: { slug: string; path: string; packageName: string }; command: string; exitCode: number | null; durationMs: number; logPath: string; manifestPath?: string; manifest: BuildManifest | null; unavailableReason?: string; logArtifact?: import("./artifacts.js").ArtifactRecord; manifestArtifact?: import("./artifacts.js").ArtifactRecord }

export const DEFAULT_BUILD_TIMEOUT_MS = 900_000;

function canonicalBuildPayload(manifest: BuildManifest): string {
  const { manifestSha256: _manifestSha256, ...payload } = manifest;
  void _manifestSha256;
  return JSON.stringify(payload);
}

async function outputFiles(root: string, project: ProjectState): Promise<string[]> {
  const targetRoot = resolve(root, project.path);
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
    }
  }
  for (const name of ["dist", "build", "out", ".next"]) {
    const directory = join(targetRoot, name);
    if (await stat(directory).then((item) => item.isDirectory()).catch(() => false)) await visit(directory);
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

export async function validateBuildManifest(root: string, project: ProjectState, sourceSha: string, manifest: BuildManifest): Promise<boolean> {
  if (manifest.authority !== "NEXUS_MCP_BUILD_MANIFEST_V1"
    || manifest.sourceSha !== sourceSha
    || manifest.target !== project.path
    || !/^v\d+\.\d+\.\d+/.test(manifest.nodeVersion)
    || !/^\d+\.\d+\.\d+/.test(manifest.pnpmVersion)
    || !/^pnpm@\d+\.\d+\.\d+/.test(manifest.packageManager)
    || !/^[a-f0-9]{64}$/.test(manifest.lockfileSha256)
    || !/^[a-f0-9]{64}$/.test(manifest.buildKey)
    || !/^[a-f0-9]{64}$/.test(manifest.outputDigest)
    || !manifest.files.length
    || createHash("sha256").update(canonicalBuildPayload(manifest)).digest("hex") !== manifest.manifestSha256) return false;
  const actualPaths = await outputFiles(root, project);
  if (JSON.stringify(actualPaths) !== JSON.stringify(manifest.files.map((file) => file.path))) return false;
  for (const file of manifest.files) {
    const path = resolve(root, file.path);
    const targetRoot = resolve(root, project.path);
    if (!path.startsWith(`${targetRoot}${sep}`)) return false;
    const bytes = await readFile(path).catch(() => null);
    if (!bytes || bytes.byteLength !== file.byteLength || createHash("sha256").update(bytes).digest("hex") !== file.sha256) return false;
  }
  return true;
}

export async function buildTarget(root: string, project: ProjectState, sourceSha: string, requestId: string, timeoutMs = DEFAULT_BUILD_TIMEOUT_MS, maxOutputBytes = 8 * 1024 * 1024): Promise<BuildExecution> {
  const started = Date.now();
  const evidenceDir = join(tmpdir(), "nexus-mcp-builds", requestId);
  const logPath = join(evidenceDir, "build.log");
  const manifestPath = join(evidenceDir, "manifest.json");
  await mkdir(evidenceDir, { recursive: true });
  const args = ["scripts/build-target-manifest.mjs", project.path, sourceSha, manifestPath];
  const target = { slug: project.slug, path: project.path, packageName: project.packageName };
  try {
    const result = await runProcess(process.execPath, args, { cwd: root, timeoutMs, maxOutputBytes });
    await writeFile(logPath, Buffer.concat([result.stdout, result.stderr]));
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as BuildManifest;
      return { target, command: `node ${args.join(" ")}`, exitCode: 0, durationMs: result.durationMs, logPath, manifestPath, manifest };
    } catch (cause) {
      return { target, command: `node ${args.join(" ")}`, exitCode: 0, durationMs: Date.now() - started, logPath, manifest: null, unavailableReason: cause instanceof Error ? cause.message : String(cause) };
    }
  } catch (cause) {
    const error = cause as ProcessExecutionError;
    await writeFile(logPath, Buffer.concat([error.stdout ?? Buffer.alloc(0), error.stderr ?? Buffer.from(`${error.message}\n`)]));
    const unavailable = error.code === "SPAWN" || /command not found|not found|ERR_PNPM|MODULE_NOT_FOUND|Cannot find module/i.test(Buffer.concat([error.stdout, error.stderr]).toString("utf8"));
    return { target, command: `node ${args.join(" ")}`, exitCode: error.exitCode, durationMs: Date.now() - started, logPath, manifest: null, ...(unavailable ? { unavailableReason: error.message } : {}) };
  }
}
