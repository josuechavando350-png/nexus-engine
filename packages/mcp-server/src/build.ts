import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { ProjectState } from "./contracts.js";

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
  return await new Promise((resolve) => {
    const args = ["scripts/build-target-manifest.mjs", project.path, sourceSha, manifestPath];
    const child = spawn(process.execPath, args, { cwd: root, shell: false, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let outputBytes = 0; let outputExceeded = false;
    const collect = (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes <= maxOutputBytes) chunks.push(chunk); else { outputExceeded = true; child.kill("SIGTERM"); } };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.once("error", async (cause: NodeJS.ErrnoException) => {
      clearTimeout(timer); await writeFile(logPath, `${cause.message}\n`);
      resolve({ target: { slug: project.slug, path: project.path, packageName: project.packageName }, command: `node ${args.join(" ")}`, exitCode: null, durationMs: Date.now() - started, logPath, manifest: null, unavailableReason: cause.code === "ENOENT" ? "node executable is unavailable" : cause.message });
    });
    child.once("close", async (code) => {
      clearTimeout(timer); await writeFile(logPath, Buffer.concat(chunks));
      if (outputExceeded) { await writeFile(logPath, `${Buffer.concat(chunks).toString("utf8")}\nbuild output exceeded ${maxOutputBytes} byte limit\n`); resolve({ target: { slug: project.slug, path: project.path, packageName: project.packageName }, command: `node ${args.join(" ")}`, exitCode: code ?? 1, durationMs: Date.now() - started, logPath, manifest: null }); return; }
      if (timedOut) { resolve({ target: { slug: project.slug, path: project.path, packageName: project.packageName }, command: `node ${args.join(" ")}`, exitCode: code, durationMs: Date.now() - started, logPath, manifest: null, unavailableReason: `build exceeded ${timeoutMs}ms` }); return; }
      if (code !== 0) {
        const output = Buffer.concat(chunks).toString("utf8");
        const unavailableReason = /command not found|not found|ERR_PNPM|MODULE_NOT_FOUND|Cannot find module/i.test(output) ? "build dependency or executable is unavailable" : undefined;
        resolve({ target: { slug: project.slug, path: project.path, packageName: project.packageName }, command: `node ${args.join(" ")}`, exitCode: code, durationMs: Date.now() - started, logPath, manifest: null, ...(unavailableReason ? { unavailableReason } : {}) }); return;
      }
      try {
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as BuildManifest;
        resolve({ target: { slug: project.slug, path: project.path, packageName: project.packageName }, command: `node ${args.join(" ")}`, exitCode: code, durationMs: Date.now() - started, logPath, manifestPath, manifest });
      } catch (cause) {
        resolve({ target: { slug: project.slug, path: project.path, packageName: project.packageName }, command: `node ${args.join(" ")}`, exitCode: code, durationMs: Date.now() - started, logPath, manifest: null, unavailableReason: cause instanceof Error ? cause.message : String(cause) });
      }
    });
  });
}
