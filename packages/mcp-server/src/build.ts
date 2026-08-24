import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProjectState } from "./contracts.js";

export interface BuildArtifactFile { path: string; byteLength: number; sha256: string }
export interface BuildManifest { authority: "NEXUS_MCP_BUILD_MANIFEST_V1"; sourceSha: string; target: string; nodeVersion: string; pnpmVersion: string; packageManager: string; lockfileSha256: string; buildKey: string; cacheHit: boolean; outputDigest: string; files: readonly BuildArtifactFile[]; manifestSha256: string }
export interface BuildExecution { target: { slug: string; path: string; packageName: string }; command: string; exitCode: number | null; durationMs: number; logPath: string; manifest: BuildManifest | null; unavailableReason?: string }

export async function buildTarget(root: string, project: ProjectState, sourceSha: string, requestId: string, timeoutMs = 900_000): Promise<BuildExecution> {
  const started = Date.now();
  const evidenceDir = join(tmpdir(), "nexus-mcp-builds", requestId);
  const logPath = join(evidenceDir, "build.log");
  const manifestPath = join(evidenceDir, "manifest.json");
  await mkdir(evidenceDir, { recursive: true });
  return await new Promise((resolve) => {
    const args = ["scripts/build-target-manifest.mjs", project.path, sourceSha, manifestPath];
    const child = spawn(process.execPath, args, { cwd: root, shell: false, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.once("error", async (cause: NodeJS.ErrnoException) => {
      clearTimeout(timer); await writeFile(logPath, `${cause.message}\n`);
      resolve({ target: { slug: project.slug, path: project.path, packageName: project.packageName }, command: `node ${args.join(" ")}`, exitCode: null, durationMs: Date.now() - started, logPath, manifest: null, unavailableReason: cause.code === "ENOENT" ? "node executable is unavailable" : cause.message });
    });
    child.once("close", async (code) => {
      clearTimeout(timer); await writeFile(logPath, Buffer.concat(chunks));
      if (timedOut) { resolve({ target: { slug: project.slug, path: project.path, packageName: project.packageName }, command: `node ${args.join(" ")}`, exitCode: code, durationMs: Date.now() - started, logPath, manifest: null, unavailableReason: `build exceeded ${timeoutMs}ms` }); return; }
      if (code !== 0) {
        const output = Buffer.concat(chunks).toString("utf8");
        const unavailableReason = /command not found|not found|ERR_PNPM|MODULE_NOT_FOUND|Cannot find module/i.test(output) ? "build dependency or executable is unavailable" : undefined;
        resolve({ target: { slug: project.slug, path: project.path, packageName: project.packageName }, command: `node ${args.join(" ")}`, exitCode: code, durationMs: Date.now() - started, logPath, manifest: null, ...(unavailableReason ? { unavailableReason } : {}) }); return;
      }
      try {
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as BuildManifest;
        resolve({ target: { slug: project.slug, path: project.path, packageName: project.packageName }, command: `node ${args.join(" ")}`, exitCode: code, durationMs: Date.now() - started, logPath, manifest });
      } catch (cause) {
        resolve({ target: { slug: project.slug, path: project.path, packageName: project.packageName }, command: `node ${args.join(" ")}`, exitCode: code, durationMs: Date.now() - started, logPath, manifest: null, unavailableReason: cause instanceof Error ? cause.message : String(cause) });
      }
    });
  });
}
